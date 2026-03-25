import '@ton/test-utils';
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, storeAccountStorage, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { sign } from '@ton/crypto';

import { MintMaster, MintMasterOpcodes } from '../wrappers/MintMaster';
import { MintKeeper } from '../wrappers/MintKeeper';
import { JettonWallet } from '../wrappers/03_notcoin/JettonWallet';

import {
    collectCellStats,
    createBlockchain,
    createRandomKeyPair,
    DEFAULT_NOW,
    Errors,
    deployNotcoinJettonMinter,
    expectedAgentWalletAddress,
    extractGasUsed,
    extractInternalTxFeeBreakdown,
    extractInternalMessageForwardFeeStats,
    extractMessageInitStats,
    expectSuccessfulInternalTxFeesToMatchAccounting,
    findInternalTransaction,
    formatTon,
    isFullFlowFeeReportEnabled,
    makeMintMasterJettonAdmin,
    printFeeBreakdown,
    publicKeyToBigInt,
    sumCellStats,
} from './utils';

type ClaimMintFixture = {
    blockchain: Blockchain;
    owner: SandboxContract<TreasuryContract>;
    nonOwner: SandboxContract<TreasuryContract>;
    mintMasterAddress: Address;
    mintKeeper: SandboxContract<MintKeeper>;
    validSignature: Buffer;
};

describe('Mint Flow', () => {
    let mintMasterCode: Cell;
    let mintKeeperCode: Cell;
    let agentWalletCode: Cell;
    let notcoinJettonMinterCode: Cell;
    let notcoinJettonWalletCode: Cell;

    beforeAll(async () => {
        mintMasterCode = await compile('MintMaster');
        mintKeeperCode = await compile('MintKeeper');
        agentWalletCode = await compile('AgentWalletV5');
        notcoinJettonWalletCode = await compile('03_notcoin/JettonWallet');
        notcoinJettonMinterCode = await compile('03_notcoin/JettonMinter');
    });

    async function createClaimMintFixture(params?: {
        isMintClaimed?: boolean;
        ownerWorkchain?: number;
        mintMasterAddress?: Address;
        mintContextOwnerAddress?: Address;
    }): Promise<ClaimMintFixture> {
        const blockchain = await createBlockchain(DEFAULT_NOW);

        const owner = await blockchain.treasury('owner', { workchain: params?.ownerWorkchain });
        const nonOwner = await blockchain.treasury('non-owner');

        const mintMaster = params?.mintMasterAddress ?? (await blockchain.treasury('mint-master')).address;

        const serviceKeys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(serviceKeys.publicKey);

        const mintContext = {
            ownerAddress: params?.mintContextOwnerAddress ?? owner.address,
            price: 0n,
            amount: toNano('1'),
            agentPublicKey: 0n,
        };

        const mintKeeper = blockchain.openContract(MintKeeper.createFromConfig({
            isMintClaimed: params?.isMintClaimed,
            servicePublicKey,
            mintMasterAddress: mintMaster,
            mintContext,
        }, mintKeeperCode));

        const validSignature = sign(mintKeeper.init!.data.hash(), serviceKeys.secretKey);

        return {
            blockchain,
            owner,
            nonOwner,
            mintMasterAddress: mintMaster,
            mintKeeper,
            validSignature,
        };
    }

    it('should mint with fee convergence', async () => {
        const feeReportEnabled = isFullFlowFeeReportEnabled();

        const blockchain = await createBlockchain(DEFAULT_NOW);
        const admin = await blockchain.treasury('admin');
        const user = await blockchain.treasury('user');

        const serviceKeys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(serviceKeys.publicKey);

        const agentKeys = await createRandomKeyPair();
        const agentPublicKey = publicKeyToBigInt(agentKeys.publicKey);

        const notcoinJettonMinter = await deployNotcoinJettonMinter({
            blockchain,
            admin,
            minterCode: notcoinJettonMinterCode,
            walletCodeRaw: notcoinJettonWalletCode,
        });

        const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
            isMintEnabled: true,
            servicePublicKey,
            jettonMinterAddress: notcoinJettonMinter.address,
            adminAddress: admin.address,
        }, mintMasterCode));
        await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));
        await makeMintMasterJettonAdmin({ jettonMinter: notcoinJettonMinter, mintMaster, admin });

        const mintAmount = toNano('1');
        const mintPrice = 1n;
        const protocolFee = mintPrice;

        const requiredClaimValue = await mintMaster.getClaimMintRequiredValue(mintPrice);

        const mintContext = {
            ownerAddress: user.address,
            price: mintPrice,
            amount: mintAmount,
            agentPublicKey,
        };

        const mintKeeper = blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey,
            mintMasterAddress: mintMaster.address,
            mintContext,
        }, mintKeeperCode));

        const expectedAgentAddress = expectedAgentWalletAddress(
            user.address,
            Buffer.from(agentKeys.publicKey),
            agentWalletCode,
        );

        // Advance time to make fee accounting more realistic (storage collection may occur on next tx).
        blockchain.now = (blockchain.now ?? DEFAULT_NOW) + 30 * 24 * 3600;
        const masterBalanceBefore = await mintMaster.getBalance();

        const signature = sign(mintKeeper.init!.data.hash(), serviceKeys.secretKey);
        const claimValue = requiredClaimValue + toNano('0.1');

        const result = await mintKeeper.sendClaimMint(user.getSender(), claimValue, signature, 1n);

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: mintKeeper.address,
            deploy: true,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintKeeper.address,
            to: mintMaster.address,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintMaster.address,
            to: expectedAgentAddress,
            deploy: true,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintMaster.address,
            to: notcoinJettonMinter.address,
            success: true,
        });

        const expectedJettonWalletAddress = await notcoinJettonMinter.getWalletAddress(expectedAgentAddress);
        expect(result.transactions).toHaveTransaction({
            from: notcoinJettonMinter.address,
            to: expectedJettonWalletAddress,
            deploy: true,
            success: true,
        });

        const expectedJettonWallet = blockchain.openContract(JettonWallet.createFromAddress(expectedJettonWalletAddress));
        const walletData = await expectedJettonWallet.getWalletData();

        expect(walletData.owner.equals(expectedAgentAddress)).toBe(true);
        expect(walletData.minter.equals(notcoinJettonMinter.address)).toBe(true);
        expect(walletData.balance).toBe(mintAmount);

        expect(await mintKeeper.getIsMintClaimed()).toBe(true);

        const masterBalanceAfter = await mintMaster.getBalance();
        expect(masterBalanceAfter).toBe(masterBalanceBefore + protocolFee);

        const keeperTx = findInternalTransaction(result.transactions, user.address, mintKeeper.address);
        const masterTx = findInternalTransaction(result.transactions, mintKeeper.address, mintMaster.address);
        const agentTx = findInternalTransaction(result.transactions, mintMaster.address, expectedAgentAddress);
        const jettonMinterTx = findInternalTransaction(result.transactions, mintMaster.address, notcoinJettonMinter.address);
        const jettonWalletTx = findInternalTransaction(result.transactions, notcoinJettonMinter.address, expectedJettonWalletAddress);

        const keeperFees = extractInternalTxFeeBreakdown(keeperTx);
        const masterFees = extractInternalTxFeeBreakdown(masterTx);
        const agentFees = extractInternalTxFeeBreakdown(agentTx);
        const jettonMinterFees = extractInternalTxFeeBreakdown(jettonMinterTx);
        const jettonWalletFees = extractInternalTxFeeBreakdown(jettonWalletTx);

        expectSuccessfulInternalTxFeesToMatchAccounting(keeperFees);
        expectSuccessfulInternalTxFeesToMatchAccounting(masterFees);
        expectSuccessfulInternalTxFeesToMatchAccounting(agentFees);
        expectSuccessfulInternalTxFeesToMatchAccounting(jettonMinterFees);
        expectSuccessfulInternalTxFeesToMatchAccounting(jettonWalletFees);

        if (feeReportEnabled) {
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('Full Mint Flow Fee Report');
            console.log('═══════════════════════════════════════════════════════════\n');
            console.log(`Claim value:            ${formatTon(claimValue)}`);
            console.log(`Required claim value:   ${formatTon(requiredClaimValue)}`);
            console.log(`Protocol fee (price*amount): ${formatTon(protocolFee)}\n`);

            printFeeBreakdown('[1] User -> MintKeeper (ClaimMint)', keeperFees);
            console.log('');
            printFeeBreakdown('[2] MintKeeper -> MintMaster (RequestMintJettons)', masterFees);
            console.log('');
            printFeeBreakdown('[3] MintMaster -> AgentWalletV5 (deploy + carry)', agentFees);
            console.log('');
            printFeeBreakdown('[4] MintMaster -> JettonMinter (MintNewJettons)', jettonMinterFees);
            console.log('');
            printFeeBreakdown('[5] JettonMinter -> JettonWallet (deploy + internal_transfer)', jettonWalletFees);
            console.log('');

            console.log(`MintMaster balance before: ${formatTon(masterBalanceBefore)}`);
            console.log(`MintMaster balance after:  ${formatTon(masterBalanceAfter)}`);
            console.log(`MintKeeper min reserve:    ${formatTon(await mintKeeper.getMinStorageFee())}`);
            console.log('');

            const mintKeeperStorageStats = (() => {
                const visited = new Set<string>();
                return sumCellStats(
                    collectCellStats(mintKeeperCode, visited),
                    collectCellStats(mintKeeper.init!.data, visited),
                );
            })();

            const mintMasterStorageStats = (() => {
                const visited = new Set<string>();
                return sumCellStats(
                    collectCellStats(mintMasterCode, visited),
                    collectCellStats(mintMaster.init!.data, visited),
                );
            })();

            const jettonWalletSmc = await blockchain.getContract(expectedJettonWalletAddress);
            if (!jettonWalletSmc.account.account) {
                throw new Error('JettonWallet account not active');
            }
            const jettonWalletStorageStats = collectCellStats(
                beginCell().store(storeAccountStorage(jettonWalletSmc.account.account.storage)).endCell(),
            );

            const agentWalletInitStats = extractMessageInitStats(agentTx.inMessage);
            const jettonWalletInitStats = extractMessageInitStats(jettonWalletTx.inMessage);
            const keeperToMasterRequestMintFwd = extractInternalMessageForwardFeeStats({
                blockchain,
                message: masterTx.inMessage,
            });
            const masterToJettonMintFwd = extractInternalMessageForwardFeeStats({
                blockchain,
                message: jettonMinterTx.inMessage,
            });
            const masterToJettonMintMsgStats = {
                bits: masterToJettonMintFwd.stats.bits,
                cells: masterToJettonMintFwd.stats.cells,
            };
            const masterToJettonMintWorstCaseMsgBits = (() => {
                const MAX_COINS = (1n << 120n) - 1n;
                const coinsTlbBits = (value: bigint): bigint => {
                    if (value === 0n) {
                        return 4n;
                    }
                    const hex = value.toString(16);
                    const bytes = BigInt(Math.ceil(hex.length / 2));
                    return 4n + 8n * bytes;
                };

                const delta = coinsTlbBits(MAX_COINS) - coinsTlbBits(mintAmount);
                return masterToJettonMintMsgStats.bits + delta;
            })();

            const keeperToMasterRequestMintMsgStats = {
                bits: keeperToMasterRequestMintFwd.stats.bits,
                cells: keeperToMasterRequestMintFwd.stats.cells,
            };
            const keeperToMasterRequestMintWorstCaseMsgBits = (() => {
                const MAX_COINS = (1n << 120n) - 1n;
                const coinsTlbBits = (value: bigint): bigint => {
                    if (value === 0n) {
                        return 4n;
                    }
                    const hex = value.toString(16);
                    const bytes = BigInt(Math.ceil(hex.length / 2));
                    return 4n + 8n * bytes;
                };

                const deltaPrice = coinsTlbBits(MAX_COINS) - coinsTlbBits(mintPrice);
                const deltaAmount = coinsTlbBits(MAX_COINS) - coinsTlbBits(mintAmount);
                return keeperToMasterRequestMintMsgStats.bits + deltaPrice + deltaAmount;
            })();

            const NOTCOIN_MAX_JETTON_WALLET_STORAGE = { bits: 1033n, cells: 3n };
            const NOTCOIN_JETTON_WALLET_INIT_STATE = { bits: 931n, cells: 3n };
            const NOTCOIN_JETTON_WALLET_GAS_TRANSFER = 6153n;
            const NOTCOIN_JETTON_WALLET_GAS_RECEIVE = 7253n;
            const JETTON_MINT_FWD_FEE_ROUNDING_BUFFER = 4n;

            expect(jettonWalletStorageStats.bits).toBeLessThanOrEqual(NOTCOIN_MAX_JETTON_WALLET_STORAGE.bits);
            expect(jettonWalletStorageStats.cells).toBeLessThanOrEqual(NOTCOIN_MAX_JETTON_WALLET_STORAGE.cells);
            expect(jettonWalletInitStats.bits).toBeLessThanOrEqual(NOTCOIN_JETTON_WALLET_INIT_STATE.bits);
            expect(jettonWalletInitStats.cells).toBeLessThanOrEqual(NOTCOIN_JETTON_WALLET_INIT_STATE.cells);

            const pasteLines = [
                '// Paste into `contracts/fees-management.tolk`:',
                '',
                `const STORAGE_SIZE_MintKeeper_bits = ${mintKeeperStorageStats.bits};`,
                `const STORAGE_SIZE_MintKeeper_cells = ${mintKeeperStorageStats.cells};`,
                `const STORAGE_SIZE_MintMaster_bits = ${mintMasterStorageStats.bits};`,
                `const STORAGE_SIZE_MintMaster_cells = ${mintMasterStorageStats.cells};`,
                '',
                `const GAS_CONSUMPTION_MintKeeperClaim = ${extractGasUsed(keeperTx)};`,
                `const GAS_CONSUMPTION_MintMasterRequestMint = ${extractGasUsed(masterTx)};`,
                '',
                `const MESSAGE_SIZE_KeeperToMasterRequestMint_bits = ${keeperToMasterRequestMintWorstCaseMsgBits};`,
                `const MESSAGE_SIZE_KeeperToMasterRequestMint_cells = ${keeperToMasterRequestMintMsgStats.cells};`,
                `// actual (this run): keeper->master request fwd stats = ${keeperToMasterRequestMintMsgStats.bits} bits, ${keeperToMasterRequestMintMsgStats.cells} cells`,
                '',
                `const STORAGE_SIZE_JettonWallet_bits = ${NOTCOIN_MAX_JETTON_WALLET_STORAGE.bits};`,
                `const STORAGE_SIZE_JettonWallet_cells = ${NOTCOIN_MAX_JETTON_WALLET_STORAGE.cells};`,
                `const STORAGE_SIZE_InitStateJettonWallet_bits = ${NOTCOIN_JETTON_WALLET_INIT_STATE.bits};`,
                `const STORAGE_SIZE_InitStateJettonWallet_cells = ${NOTCOIN_JETTON_WALLET_INIT_STATE.cells};`,
                `// actual (this run): JettonWallet storage = ${jettonWalletStorageStats.bits} bits, ${jettonWalletStorageStats.cells} cells`,
                `// actual (this run): JettonWallet init    = ${jettonWalletInitStats.bits} bits, ${jettonWalletInitStats.cells} cells`,
                `const STORAGE_SIZE_InitStateAgentWalletV5_bits = ${agentWalletInitStats.bits};`,
                `const STORAGE_SIZE_InitStateAgentWalletV5_cells = ${agentWalletInitStats.cells};`,
                '',
                `const MESSAGE_SIZE_MasterToJettonMint_bits = ${masterToJettonMintWorstCaseMsgBits};`,
                `const MESSAGE_SIZE_MasterToJettonMint_cells = ${masterToJettonMintMsgStats.cells};`,
                `// actual (this run): master->jetton mint fwd stats = ${masterToJettonMintFwd.stats.bits} bits, ${masterToJettonMintFwd.stats.cells} cells`,
                `const JETTON_MINT_FWD_FEE_ROUNDING_BUFFER: coins = ${JETTON_MINT_FWD_FEE_ROUNDING_BUFFER};`,
                '',
                `const GAS_CONSUMPTION_JettonMint = ${extractGasUsed(jettonMinterTx)};`,
                `const GAS_CONSUMPTION_JettonWalletTransfer = ${NOTCOIN_JETTON_WALLET_GAS_TRANSFER};`,
                `const GAS_CONSUMPTION_JettonWalletReceive = ${NOTCOIN_JETTON_WALLET_GAS_RECEIVE};`,
                `// actual (this run): JettonWallet receive gas = ${extractGasUsed(jettonWalletTx)};`,
                '═══════════════════════════════════════════════════════════',
                '',
            ];
            console.log(pasteLines.join('\n'));
        }
    });

    it('rejects ClaimMint when value is below required budget', async () => {
        const fixture = await createClaimMintFixture();
        const lowClaimValue = toNano('0.01');

        const result = await fixture.mintKeeper.sendClaimMint(
            fixture.owner.getSender(),
            lowClaimValue,
            fixture.validSignature,
            7n,
        );

        expect(result.transactions).toHaveTransaction({
            on: fixture.mintKeeper.address,
            from: fixture.owner.address,
            success: false,
            exitCode: Errors.notEnoughFundsToClaimMint,
        });

        expect(result.transactions).not.toHaveTransaction({
            from: fixture.mintKeeper.address,
            to: fixture.mintMasterAddress,
            success: true,
        });
    });

    it('rejects ClaimMint when sender is not the owner', async () => {
        const fixture = await createClaimMintFixture();

        const result = await fixture.mintKeeper.sendClaimMint(
            fixture.nonOwner.getSender(),
            toNano('1'),
            fixture.validSignature,
            1n,
        );

        expect(result.transactions).toHaveTransaction({
            on: fixture.mintKeeper.address,
            from: fixture.nonOwner.address,
            success: false,
            exitCode: Errors.notOwnerTryingToClaimMint,
        });
    });

    it('rejects ClaimMint when signature is invalid', async () => {
        const fixture = await createClaimMintFixture();

        const invalidSignature = Buffer.from(fixture.validSignature);
        invalidSignature[0] = invalidSignature[0] ^ 0xff;

        const result = await fixture.mintKeeper.sendClaimMint(
            fixture.owner.getSender(),
            toNano('1'),
            invalidSignature,
            1n,
        );

        expect(result.transactions).toHaveTransaction({
            on: fixture.mintKeeper.address,
            from: fixture.owner.address,
            success: false,
            exitCode: Errors.signatureInvalid,
        });

        expect(await fixture.mintKeeper.getIsMintClaimed()).toBe(false);
    });

    it('rejects ClaimMint when ownerAddress is not basechain', async () => {
        const fixture = await createClaimMintFixture({ ownerWorkchain: -1 });

        const result = await fixture.mintKeeper.sendClaimMint(
            fixture.owner.getSender(),
            toNano('1'),
            fixture.validSignature,
            1n,
        );

        expect(result.transactions).toHaveTransaction({
            on: fixture.mintKeeper.address,
            from: fixture.owner.address,
            success: false,
            exitCode: Errors.wrongWorkchain,
        });
    });

    it('rejects ClaimMint when the claim is already used', async () => {
        const fixture = await createClaimMintFixture({ isMintClaimed: true });

        const result = await fixture.mintKeeper.sendClaimMint(
            fixture.owner.getSender(),
            toNano('1'),
            fixture.validSignature,
            1n,
        );

        expect(result.transactions).toHaveTransaction({
            on: fixture.mintKeeper.address,
            from: fixture.owner.address,
            success: false,
            exitCode: Errors.mintClaimAlreadyUsed,
        });
    });

    it('rejects RequestMintJettons on MintMaster when sender is not the expected MintKeeper address', async () => {
        const blockchain = await createBlockchain(DEFAULT_NOW);
        const admin = await blockchain.treasury('admin');
        const attacker = await blockchain.treasury('attacker');

        const serviceKeys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(serviceKeys.publicKey);

        const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
            isMintEnabled: true,
            servicePublicKey,
            jettonMinterAddress: (await blockchain.treasury('jetton-minter')).address,
            adminAddress: admin.address,
        }, mintMasterCode));
        await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

        const mintContext = {
            ownerAddress: (await blockchain.treasury('owner')).address,
            price: 0n,
            amount: toNano('1'),
            agentPublicKey: 0n,
        };

        const requestMintBody = beginCell()
            .storeUint(MintMasterOpcodes.requestMintJettons, 32) // RequestMintJettons
            .storeUint(1n, 64) // queryId
            .storeAddress(mintContext.ownerAddress)
            .storeCoins(mintContext.price)
            .storeCoins(mintContext.amount)
            .storeUint(mintContext.agentPublicKey, 256)
            .endCell();

        const result = await blockchain.sendMessage(internal({
            from: attacker.address,
            to: mintMaster.address,
            value: toNano('1'),
            bounce: true,
            body: requestMintBody,
        }));

        expect(result.transactions).toHaveTransaction({
            on: mintMaster.address,
            from: attacker.address,
            success: false,
            exitCode: Errors.mintKeeperAddressMismatch,
        });
    });

    it('rejects RequestMintJettons on MintMaster when ownerAddress is not basechain', async () => {
        const blockchain = await createBlockchain(DEFAULT_NOW);
        const admin = await blockchain.treasury('admin');
        const attacker = await blockchain.treasury('attacker');

        const keys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(keys.publicKey);

        const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
            isMintEnabled: true,
            servicePublicKey,
            jettonMinterAddress: (await blockchain.treasury('jetton-minter')).address,
            adminAddress: admin.address,
        }, mintMasterCode));
        await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

        const nonBasechainOwner = await blockchain.treasury('owner', { workchain: -1 });
        const mintContext = {
            ownerAddress: nonBasechainOwner.address,
            price: 0n,
            amount: toNano('1'),
            agentPublicKey: 0n,
        };

        const requestMintBody = beginCell()
            .storeUint(MintMasterOpcodes.requestMintJettons, 32) // RequestMintJettons
            .storeUint(1n, 64) // queryId
            .storeAddress(mintContext.ownerAddress)
            .storeCoins(mintContext.price)
            .storeCoins(mintContext.amount)
            .storeUint(mintContext.agentPublicKey, 256)
            .endCell();

        const result = await blockchain.sendMessage(internal({
            from: attacker.address,
            to: mintMaster.address,
            value: toNano('1'),
            bounce: true,
            body: requestMintBody,
        }));

        expect(result.transactions).toHaveTransaction({
            on: mintMaster.address,
            from: attacker.address,
            success: false,
            exitCode: Errors.wrongWorkchain,
        });
    });
});

import '@ton/test-utils';
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { sign } from '@ton/crypto';

import { MintMaster } from '../wrappers/MintMaster';
import { MintKeeper } from '../wrappers/MintKeeper';
import { JettonWallet } from '../wrappers/03_notcoin/JettonWallet';

import {
    createBlockchain,
    createRandomKeyPair,
    DEFAULT_NOW,
    deployNotcoinJettonMinter,
    expectedAgentWalletAddress,
    findInternalTransaction,
    makeMintMasterJettonAdmin,
    publicKeyToBigInt,
    Errors,
} from './utils';

const MAX_COINS = (1n << 120n) - 1n;

type MintEnv = {
    blockchain: Blockchain;
    admin: SandboxContract<TreasuryContract>;
    user: SandboxContract<TreasuryContract>;
    mintMaster: SandboxContract<MintMaster>;
    mintMasterCode: Cell;
    mintKeeperCode: Cell;
    agentWalletCode: Cell;
    notcoinJettonMinter: SandboxContract<any>;
    notcoinJettonMinterCode: Cell;
    notcoinJettonWalletCode: Cell;
    serviceKeys: Awaited<ReturnType<typeof createRandomKeyPair>>;
    servicePublicKey: bigint;
};

async function setupMintEnvironment(params: {
    mintMasterCode: Cell;
    mintKeeperCode: Cell;
    agentWalletCode: Cell;
    notcoinJettonMinterCode: Cell;
    notcoinJettonWalletCode: Cell;
    isMintEnabled: boolean;
}): Promise<MintEnv> {
    const blockchain = await createBlockchain(DEFAULT_NOW);
    const admin = await blockchain.treasury('admin');
    const user = await blockchain.treasury('user');

    const serviceKeys = await createRandomKeyPair();
    const servicePublicKey = publicKeyToBigInt(serviceKeys.publicKey);

    const notcoinJettonMinter = await deployNotcoinJettonMinter({
        blockchain,
        admin,
        minterCode: params.notcoinJettonMinterCode,
        walletCodeRaw: params.notcoinJettonWalletCode,
    });

    const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
        isMintEnabled: params.isMintEnabled,
        servicePublicKey,
        jettonMinterAddress: notcoinJettonMinter.address,
        adminAddress: admin.address,
    }, params.mintMasterCode));
    await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

    await makeMintMasterJettonAdmin({ jettonMinter: notcoinJettonMinter, mintMaster, admin });

    return {
        blockchain,
        admin,
        user,
        mintMaster,
        mintMasterCode: params.mintMasterCode,
        mintKeeperCode: params.mintKeeperCode,
        agentWalletCode: params.agentWalletCode,
        notcoinJettonMinter,
        notcoinJettonMinterCode: params.notcoinJettonMinterCode,
        notcoinJettonWalletCode: params.notcoinJettonWalletCode,
        serviceKeys,
        servicePublicKey,
    };
}

async function findMinimalClaimValueThatPassesKeeperBudget(params: {
    blockchain: Blockchain;
    user: SandboxContract<TreasuryContract>;
    mintKeeper: SandboxContract<MintKeeper>;
    mintMasterAddress: Address;
    signature: Buffer;
    queryId: bigint;
    lowFail: bigint;
    highPass: bigint;
}): Promise<bigint> {
    const base = params.blockchain.snapshot();

    const keeperAccepts = async (claimValue: bigint): Promise<boolean> => {
        await params.blockchain.loadFrom(base);
        const result = await params.mintKeeper.sendClaimMint(params.user.getSender(), claimValue, params.signature, params.queryId);
        const keeperTx = findInternalTransaction(result.transactions, params.user.address, params.mintKeeper.address);
        if (keeperTx.description.type !== 'generic') {
            throw new Error(`Generic transaction expected, got ${keeperTx.description.type}`);
        }
        if (keeperTx.description.aborted) {
            return false;
        }

        try {
            findInternalTransaction(result.transactions, params.mintKeeper.address, params.mintMasterAddress);
            return true;
        } catch {
            return false;
        }
    };

    const lowAccepts = await keeperAccepts(params.lowFail);
    expect(lowAccepts).toBe(false);

    let high = params.highPass;
    while (!(await keeperAccepts(high))) {
        high *= 2n;
        if (high > toNano('50')) {
            throw new Error(`Failed to find a passing ClaimMint value; last tried ${high.toString()}`);
        }
    }

    let low = params.lowFail;
    while (high - low > 1n) {
        const mid = (low + high) / 2n;
        if (await keeperAccepts(mid)) {
            high = mid;
        } else {
            low = mid;
        }
    }

    await params.blockchain.loadFrom(base);
    return high;
}

describe('Fee Budget Invariants', () => {
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

    it('does not overflow on protocolFee = price * amount for max coin values', async () => {
        const blockchain = await createBlockchain(DEFAULT_NOW);
        const owner = await blockchain.treasury('owner');
        const mintMasterAddress = (await blockchain.treasury('mint-master')).address;

        const keys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(keys.publicKey);

        const mintKeeper = blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey,
            mintMasterAddress,
            mintContext: {
                ownerAddress: owner.address,
                price: MAX_COINS,
                amount: MAX_COINS,
                agentPublicKey: 0n,
            },
        }, mintKeeperCode));

        const signature = sign(mintKeeper.init!.data.hash(), keys.secretKey);
        const result = await mintKeeper.sendClaimMint(owner.getSender(), toNano('0.01'), signature, 1n);

        expect(result.transactions).toHaveTransaction({
            on: mintKeeper.address,
            from: owner.address,
            success: false,
            exitCode: Errors.notEnoughFundsToClaimMint,
        });
    });

    it('throws 0xFFFF on unknown opcode (MintMaster)', async () => {
        const blockchain = await createBlockchain(DEFAULT_NOW);
        const user = await blockchain.treasury('user');
        const admin = await blockchain.treasury('admin');

        const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
            isMintEnabled: true,
            servicePublicKey: 0n,
            jettonMinterAddress: (await blockchain.treasury('jetton-minter')).address,
            adminAddress: admin.address,
        }, mintMasterCode));
        await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

        const unknownOpBody = beginCell().storeUint(0x12345678, 32).endCell();
        const result = await blockchain.sendMessage(internal({
            from: user.address,
            to: mintMaster.address,
            value: toNano('0.1'),
            bounce: true,
            body: unknownOpBody,
        }));

        expect(result.transactions).toHaveTransaction({
            on: mintMaster.address,
            from: user.address,
            success: false,
            exitCode: 0xffff,
        });
    });

    it('throws 0xFFFF on unknown opcode (MintKeeper)', async () => {
        const blockchain = await createBlockchain(DEFAULT_NOW);
        const owner = await blockchain.treasury('owner');
        const mintMasterAddress = (await blockchain.treasury('mint-master')).address;

        const keys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(keys.publicKey);

        const mintKeeper = blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey,
            mintMasterAddress,
            mintContext: {
                ownerAddress: owner.address,
                price: 0n,
                amount: toNano('1'),
                agentPublicKey: 0n,
            },
        }, mintKeeperCode));

        const unknownOpBody = beginCell().storeUint(0x12345678, 32).endCell();
        const result = await blockchain.sendMessage(internal({
            from: owner.address,
            to: mintKeeper.address,
            value: toNano('0.1'),
            bounce: true,
            body: unknownOpBody,
            stateInit: mintKeeper.init,
        }));

        expect(result.transactions).toHaveTransaction({
            on: mintKeeper.address,
            from: owner.address,
            success: false,
            exitCode: 0xffff,
        });
    });

    it('calculateClaimMintRequiredValue does not underestimate (boundary, standard mint)', async () => {
        const env = await setupMintEnvironment({
            mintMasterCode,
            mintKeeperCode,
            agentWalletCode,
            notcoinJettonMinterCode,
            notcoinJettonWalletCode,
            isMintEnabled: false,
        });

        const agentKeys = await createRandomKeyPair();
        const agentPublicKey = publicKeyToBigInt(agentKeys.publicKey);

        const mintAmount = toNano('1');
        const mintPrice = 1n;
        const protocolFee = mintPrice * mintAmount;

        const mintContext = {
            ownerAddress: env.user.address,
            price: mintPrice,
            amount: mintAmount,
            agentPublicKey,
        };

        const mintKeeper = env.blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey: env.servicePublicKey,
            mintMasterAddress: env.mintMaster.address,
            mintContext,
        }, mintKeeperCode));

        const signature = sign(mintKeeper.init!.data.hash(), env.serviceKeys.secretKey);
        const minimalClaimValue = await findMinimalClaimValueThatPassesKeeperBudget({
            blockchain: env.blockchain,
            user: env.user,
            mintKeeper,
            mintMasterAddress: env.mintMaster.address,
            signature,
            queryId: 1n,
            lowFail: toNano('0.01'),
            highPass: protocolFee + toNano('5'),
        });

        await env.mintMaster.sendToggleMint(env.admin.getSender(), toNano('0.1'), true, 1n);

        const expectedAgentAddress = expectedAgentWalletAddress(
            env.user.address,
            Buffer.from(agentKeys.publicKey),
            env.agentWalletCode,
        );

        const masterBalanceBefore = await env.mintMaster.getBalance();
        const result = await mintKeeper.sendClaimMint(env.user.getSender(), minimalClaimValue, signature, 2n);

        expect(result.transactions).toHaveTransaction({
            from: env.user.address,
            to: mintKeeper.address,
            deploy: true,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintKeeper.address,
            to: env.mintMaster.address,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: env.mintMaster.address,
            to: expectedAgentAddress,
            deploy: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: env.mintMaster.address,
            to: env.notcoinJettonMinter.address,
            success: true,
        });

        const expectedJettonWalletAddress = await env.notcoinJettonMinter.getWalletAddress(expectedAgentAddress);
        expect(result.transactions).toHaveTransaction({
            from: env.notcoinJettonMinter.address,
            to: expectedJettonWalletAddress,
            deploy: true,
            success: true,
        });

        expect(result.transactions).not.toHaveTransaction({
            from: mintKeeper.address,
            to: env.user.address,
            success: true,
        });

        const expectedJettonWallet = env.blockchain.openContract(JettonWallet.createFromAddress(expectedJettonWalletAddress));
        const walletData = await expectedJettonWallet.getWalletData();
        expect(walletData.balance).toBe(mintAmount);

        expect(await mintKeeper.getIsMintClaimed()).toBe(true);

        const masterBalanceAfter = await env.mintMaster.getBalance();
        expect(masterBalanceAfter).toBe(masterBalanceBefore + protocolFee);
    });

    it('calculateClaimMintRequiredValue does not underestimate (boundary, max-amount varuint + big-int mint)', async () => {
        const env = await setupMintEnvironment({
            mintMasterCode,
            mintKeeperCode,
            agentWalletCode,
            notcoinJettonMinterCode,
            notcoinJettonWalletCode,
            isMintEnabled: false,
        });

        const agentKeys = await createRandomKeyPair();
        const agentPublicKey = publicKeyToBigInt(agentKeys.publicKey);

        const mintAmount = MAX_COINS;
        const mintPrice = 0n;
        const protocolFee = 0n;

        const mintContext = {
            ownerAddress: env.user.address,
            price: mintPrice,
            amount: mintAmount,
            agentPublicKey,
        };

        const mintKeeper = env.blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey: env.servicePublicKey,
            mintMasterAddress: env.mintMaster.address,
            mintContext,
        }, mintKeeperCode));

        const signature = sign(mintKeeper.init!.data.hash(), env.serviceKeys.secretKey);
        const minimalClaimValue = await findMinimalClaimValueThatPassesKeeperBudget({
            blockchain: env.blockchain,
            user: env.user,
            mintKeeper,
            mintMasterAddress: env.mintMaster.address,
            signature,
            queryId: 10n,
            lowFail: toNano('0.01'),
            highPass: toNano('5'),
        });

        await env.mintMaster.sendToggleMint(env.admin.getSender(), toNano('0.1'), true, 1n);

        const expectedAgentAddress = expectedAgentWalletAddress(
            env.user.address,
            Buffer.from(agentKeys.publicKey),
            env.agentWalletCode,
        );

        const masterBalanceBefore = await env.mintMaster.getBalance();
        const result = await mintKeeper.sendClaimMint(env.user.getSender(), minimalClaimValue, signature, 11n);

        expect(result.transactions).toHaveTransaction({
            from: env.user.address,
            to: mintKeeper.address,
            deploy: true,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintKeeper.address,
            to: env.mintMaster.address,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: env.mintMaster.address,
            to: expectedAgentAddress,
            deploy: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: env.mintMaster.address,
            to: env.notcoinJettonMinter.address,
            success: true,
        });

        const expectedJettonWalletAddress = await env.notcoinJettonMinter.getWalletAddress(expectedAgentAddress);
        const expectedJettonWallet = env.blockchain.openContract(JettonWallet.createFromAddress(expectedJettonWalletAddress));
        const walletData = await expectedJettonWallet.getWalletData();
        expect(walletData.balance).toBe(mintAmount);

        const masterBalanceAfter = await env.mintMaster.getBalance();
        expect(masterBalanceAfter).toBe(masterBalanceBefore + protocolFee);
    });
});

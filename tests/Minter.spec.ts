import '@ton/test-utils';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';

import { MintMaster } from '../wrappers/MintMaster';
import { JettonMinter, jettonContentToCell } from '../wrappers/03_notcoin/JettonMinter';

import {
    addLibraryToBlockchain,
    createBlockchain,
    DEFAULT_NOW,
    Errors,
    extractInternalTxFeeBreakdown,
    expectSuccessfulInternalTxFeesToMatchAccounting,
    findInternalTransaction,
    formatTon,
    isAnyFeeReportEnabled,
    printFeeBreakdown,
} from './utils';

describe('MintMaster', () => {
    let mintMasterCode: Cell;
    let notcoinJettonMinterCode: Cell;
    let notcoinJettonWalletCode: Cell;

    beforeAll(async () => {
        mintMasterCode = await compile('MintMaster');
        notcoinJettonMinterCode = await compile('03_notcoin/JettonMinter');
        notcoinJettonWalletCode = await compile('03_notcoin/JettonWallet');
    });

    function expectBalanceConvergence(params: {
        balanceBefore: bigint;
        balanceAfter: bigint;
        txFees: ReturnType<typeof extractInternalTxFeeBreakdown>;
    }) {
        const lhs = params.balanceBefore + params.txFees.inValue;
        const rhs =
            params.balanceAfter
            + params.txFees.outValue
            + params.txFees.storageCollected
            + params.txFees.compute
            + params.txFees.action
            + params.txFees.forwardNet;
        expect(lhs).toBe(rhs);
    }

    describe('Admin-only operations', () => {
        let blockchain: Awaited<ReturnType<typeof createBlockchain>>;
        let admin: SandboxContract<TreasuryContract>;
        let user: SandboxContract<TreasuryContract>;
        let jettonMinter: SandboxContract<TreasuryContract>;
        let mintMaster: SandboxContract<MintMaster>;

        beforeEach(async () => {
            blockchain = await createBlockchain(DEFAULT_NOW);
            admin = await blockchain.treasury('admin');
            user = await blockchain.treasury('user');
            jettonMinter = await blockchain.treasury('jetton-minter');

            mintMaster = blockchain.openContract(MintMaster.createFromConfig({
                isMintEnabled: true,
                servicePublicKey: 0n,
                jettonMinterAddress: jettonMinter.address,
                adminAddress: admin.address,
            }, mintMasterCode));

            const deployResult = await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

            expect(deployResult.transactions).toHaveTransaction({
                from: admin.address,
                to: mintMaster.address,
                deploy: true,
                success: true,
            });
        });

        it('deploys', async () => {
            // Deployment is asserted in beforeEach.
        });

        it('allows admin to withdraw all tons above the reserve (with fee accounting)', async () => {
            const feeReportEnabled = isAnyFeeReportEnabled();

            const minStorageFee = await mintMaster.getMinStorageFee();
            await mintMaster.sendTopUpTons(user.getSender(), toNano('5'));
            const balanceBefore = await mintMaster.getBalance();
            expect(balanceBefore).toBeGreaterThan(minStorageFee);

            // Move time forward to force storage fee collection on next tx.
            blockchain.now = (blockchain.now ?? 0) + 365 * 24 * 60 * 60;

            const withdrawMsgValue = toNano('0.1');
            const withdrawResult = await mintMaster.sendWithdrawTons(admin.getSender(), withdrawMsgValue);

            expect(withdrawResult.transactions).toHaveTransaction({
                from: admin.address,
                to: mintMaster.address,
                success: true,
            });

            expect(withdrawResult.transactions).toHaveTransaction({
                from: mintMaster.address,
                to: admin.address,
                success: true,
            });

            const mintMasterTx = findInternalTransaction(withdrawResult.transactions, admin.address, mintMaster.address);
            const payoutTx = findInternalTransaction(withdrawResult.transactions, mintMaster.address, admin.address);

            const fees = extractInternalTxFeeBreakdown(mintMasterTx);

            const storageCollected = mintMasterTx.description.type === 'generic'
                ? mintMasterTx.description.storagePhase?.storageFeesCollected ?? 0n
                : 0n;
            const storageDue = mintMasterTx.description.type === 'generic'
                ? mintMasterTx.description.storagePhase?.storageFeesDue ?? 0n
                : 0n;
            expect(storageCollected).toBeGreaterThan(0n);
            expect(storageDue).toBe(0n);

            const balanceAfter = await mintMaster.getBalance();

            expectSuccessfulInternalTxFeesToMatchAccounting(fees);

            if (payoutTx.inMessage?.info.type === 'internal') {
                const payoutValue = payoutTx.inMessage.info.value.coins as bigint;
                const payoutInFwd = payoutTx.inMessage.info.forwardFee as bigint;
                expect(fees.outValue).toBe(payoutValue);
                expect(fees.forwardNet).toBe(payoutInFwd);
            }

            expectBalanceConvergence({ balanceBefore, balanceAfter, txFees: fees });
            expect(balanceAfter).toBe(minStorageFee);

            if (feeReportEnabled) {
                console.log('\n═══════════════════════════════════════════════════════════');
                console.log('WithdrawTons Fee Report');
                console.log('═══════════════════════════════════════════════════════════\n');
                console.log(`Contract balance before: ${formatTon(balanceBefore)}`);
                console.log(`Withdraw msg value:      ${formatTon(withdrawMsgValue)}`);
                console.log(`Min storage fee:         ${formatTon(minStorageFee)}\n`);
                printFeeBreakdown('[MintMaster] admin -> MintMaster (WithdrawTons)', fees);
                console.log('');
                console.log(`Contract balance after:  ${formatTon(balanceAfter)}`);
                console.log('═══════════════════════════════════════════════════════════\n');
            }
        });

        it('rejects WithdrawTons from non-admin', async () => {
            const result = await mintMaster.sendWithdrawTons(user.getSender(), toNano('0.1'));

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notAdmin,
            });

            expect(result.transactions).not.toHaveTransaction({
                from: mintMaster.address,
                to: admin.address,
                success: true,
            });
        });

        it('allows admin to toggle mint (with fee accounting)', async () => {
            const feeReportEnabled = isAnyFeeReportEnabled();

            await mintMaster.sendTopUpTons(user.getSender(), toNano('3'));
            expect(await mintMaster.getIsMintEnabled()).toBe(true);

            const fullDataBefore = await mintMaster.getMintMasterData();
            expect(fullDataBefore.isMintEnabled).toBe(true);
            expect(fullDataBefore.adminAddress.equals(admin.address)).toBe(true);
            expect(fullDataBefore.jettonMinterAddress.equals(jettonMinter.address)).toBe(true);

            const balanceBefore = await mintMaster.getBalance();
            blockchain.now = (blockchain.now ?? 0) + 365 * 24 * 60 * 60;

            const toggleMsgValue = toNano('0.1');
            const toggleResult = await mintMaster.sendToggleMint(admin.getSender(), toggleMsgValue, false);

            expect(toggleResult.transactions).toHaveTransaction({
                from: admin.address,
                to: mintMaster.address,
                success: true,
            });

            expect(toggleResult.transactions).toHaveTransaction({
                from: mintMaster.address,
                to: admin.address,
                success: true,
            });

            const mintMasterTx = findInternalTransaction(toggleResult.transactions, admin.address, mintMaster.address);
            const payoutTx = findInternalTransaction(toggleResult.transactions, mintMaster.address, admin.address);

            const fees = extractInternalTxFeeBreakdown(mintMasterTx);

            const storageCollected = mintMasterTx.description.type === 'generic'
                ? mintMasterTx.description.storagePhase?.storageFeesCollected ?? 0n
                : 0n;
            const storageDue = mintMasterTx.description.type === 'generic'
                ? mintMasterTx.description.storagePhase?.storageFeesDue ?? 0n
                : 0n;
            expect(storageCollected).toBeGreaterThan(0n);
            expect(storageDue).toBe(0n);

            const balanceAfter = await mintMaster.getBalance();

            expectSuccessfulInternalTxFeesToMatchAccounting(fees);

            if (payoutTx.inMessage?.info.type === 'internal') {
                const payoutValue = payoutTx.inMessage.info.value.coins as bigint;
                const payoutInFwd = payoutTx.inMessage.info.forwardFee as bigint;
                expect(fees.outValue).toBe(payoutValue);
                expect(fees.forwardNet).toBe(payoutInFwd);
            }

            expectBalanceConvergence({ balanceBefore, balanceAfter, txFees: fees });
            expect(balanceAfter).toBe(balanceBefore);

            if (feeReportEnabled) {
                console.log('\n═══════════════════════════════════════════════════════════');
                console.log('ToggleMint Fee Report');
                console.log('═══════════════════════════════════════════════════════════\n');
                console.log(`Contract balance before: ${formatTon(balanceBefore)}`);
                console.log(`Toggle msg value:        ${formatTon(toggleMsgValue)}\n`);
                printFeeBreakdown('[MintMaster] admin -> MintMaster (ToggleMint)', fees);
                console.log('');
                console.log(`Contract balance after:  ${formatTon(balanceAfter)}`);
                console.log('═══════════════════════════════════════════════════════════\n');
            }

            expect(await mintMaster.getIsMintEnabled()).toBe(false);
        });

        it('rejects ToggleMint from non-admin', async () => {
            const result = await mintMaster.sendToggleMint(user.getSender(), toNano('0.1'), false);

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notAdmin,
            });

            expect(await mintMaster.getIsMintEnabled()).toBe(true);
        });

        it('accepts TopUpTons from any sender', async () => {
            const balanceBefore = await mintMaster.getBalance();

            const result = await mintMaster.sendTopUpTons(user.getSender(), toNano('1'));

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: mintMaster.address,
                success: true,
            });

            const balanceAfter = await mintMaster.getBalance();
            expect(balanceAfter).toBeGreaterThan(balanceBefore);
        });

        it('rejects ChangeJettonAdmin from non-admin', async () => {
            const newAdmin = await blockchain.treasury('new-admin');

            const result = await mintMaster.sendChangeJettonAdmin(
                user.getSender(),
                toNano('0.1'),
                newAdmin.address,
                1n,
            );

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notAdmin,
            });
        });

        it('rejects ClaimJettonAdmin from non-admin', async () => {
            const result = await mintMaster.sendClaimJettonAdmin(user.getSender(), toNano('0.1'), 1n);

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notAdmin,
            });
        });

        it('allows admin to change MintMaster admin (two-step)', async () => {
            const newAdmin = await blockchain.treasury('new-admin');

            // Step 1: admin sets nextAdminAddress
            const changeResult = await mintMaster.sendChangeMintMasterAdmin(
                admin.getSender(),
                toNano('0.1'),
                newAdmin.address,
                1n,
            );

            expect(changeResult.transactions).toHaveTransaction({
                from: admin.address,
                to: mintMaster.address,
                success: true,
            });

            const nextAdmin = await mintMaster.getNextAdminAddress();
            expect(nextAdmin).toEqualAddress(newAdmin.address);

            // Admin is still the old one
            const dataMid = await mintMaster.getMintMasterData();
            expect(dataMid.adminAddress).toEqualAddress(admin.address);

            // Step 2: new admin claims
            const claimResult = await mintMaster.sendClaimMintMasterAdmin(
                newAdmin.getSender(),
                toNano('0.1'),
                2n,
            );

            expect(claimResult.transactions).toHaveTransaction({
                from: newAdmin.address,
                to: mintMaster.address,
                success: true,
            });

            const dataAfter = await mintMaster.getMintMasterData();
            expect(dataAfter.adminAddress).toEqualAddress(newAdmin.address);

            // nextAdminAddress should be cleared
            const nextAdminAfter = await mintMaster.getNextAdminAddress();
            expect(nextAdminAfter).toBeNull();
        });

        it('rejects ChangeMintMasterAdmin from non-admin', async () => {
            const newAdmin = await blockchain.treasury('new-admin');

            const result = await mintMaster.sendChangeMintMasterAdmin(
                user.getSender(),
                toNano('0.1'),
                newAdmin.address,
                1n,
            );

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notAdmin,
            });
        });

        it('rejects ClaimMintMasterAdmin from wrong address', async () => {
            const newAdmin = await blockchain.treasury('new-admin');

            // Set next admin first
            await mintMaster.sendChangeMintMasterAdmin(
                admin.getSender(),
                toNano('0.1'),
                newAdmin.address,
                1n,
            );

            // Try to claim from user (not newAdmin)
            const result = await mintMaster.sendClaimMintMasterAdmin(
                user.getSender(),
                toNano('0.1'),
                2n,
            );

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notNextAdmin,
            });

            // Admin unchanged
            const data = await mintMaster.getMintMasterData();
            expect(data.adminAddress).toEqualAddress(admin.address);
        });

        it('rejects ClaimMintMasterAdmin when nextAdmin is not set', async () => {
            const result = await mintMaster.sendClaimMintMasterAdmin(
                user.getSender(),
                toNano('0.1'),
                1n,
            );

            expect(result.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: user.address,
                success: false,
                exitCode: Errors.notNextAdmin,
            });
        });

        it('new admin can use admin operations after transfer', async () => {
            const newAdmin = await blockchain.treasury('new-admin');

            // Transfer admin
            await mintMaster.sendChangeMintMasterAdmin(admin.getSender(), toNano('0.1'), newAdmin.address, 1n);
            await mintMaster.sendClaimMintMasterAdmin(newAdmin.getSender(), toNano('0.1'), 2n);

            // New admin can toggle mint
            const toggleResult = await mintMaster.sendToggleMint(newAdmin.getSender(), toNano('0.1'), false);
            expect(toggleResult.transactions).toHaveTransaction({
                from: newAdmin.address,
                to: mintMaster.address,
                success: true,
            });
            expect(await mintMaster.getIsMintEnabled()).toBe(false);

            // Old admin cannot toggle mint anymore
            const rejectResult = await mintMaster.sendToggleMint(admin.getSender(), toNano('0.1'), true);
            expect(rejectResult.transactions).toHaveTransaction({
                on: mintMaster.address,
                from: admin.address,
                success: false,
                exitCode: Errors.notAdmin,
            });
        });
    });

    describe('Jetton admin proxying', () => {
        it('allows admin to claim JettonMinter admin via MintMaster (ClaimJettonAdmin)', async () => {
            const blockchain = await createBlockchain(DEFAULT_NOW);
            const admin = await blockchain.treasury('admin');
            const walletCode = addLibraryToBlockchain(blockchain, notcoinJettonWalletCode);

            const jettonMinter = blockchain.openContract(JettonMinter.createFromConfig({
                admin: admin.address,
                nextAdmin: null,
                wallet_code: walletCode,
                jetton_content: jettonContentToCell({ uri: 'ipfs://jetton-metadata' }),
            }, notcoinJettonMinterCode));
            await jettonMinter.sendDeploy(admin.getSender(), toNano('2'));

            const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
                isMintEnabled: true,
                servicePublicKey: 0n,
                jettonMinterAddress: jettonMinter.address,
                adminAddress: admin.address,
            }, mintMasterCode));
            await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

            await jettonMinter.sendChangeAdmin(admin.getSender(), mintMaster.address);
            await mintMaster.sendClaimJettonAdmin(admin.getSender(), toNano('0.2'), 1n);

            expect(await jettonMinter.getAdminAddress()).toEqualAddress(mintMaster.address);
        });

        it('allows admin to change JettonMinter admin via MintMaster (ChangeJettonAdmin)', async () => {
            const blockchain = await createBlockchain(DEFAULT_NOW);
            const admin = await blockchain.treasury('admin');
            const newAdmin = await blockchain.treasury('new-admin');
            const walletCode = addLibraryToBlockchain(blockchain, notcoinJettonWalletCode);

            const jettonMinter = blockchain.openContract(JettonMinter.createFromConfig({
                admin: admin.address,
                nextAdmin: null,
                wallet_code: walletCode,
                jetton_content: jettonContentToCell({ uri: 'ipfs://jetton-metadata' }),
            }, notcoinJettonMinterCode));
            await jettonMinter.sendDeploy(admin.getSender(), toNano('2'));

            const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
                isMintEnabled: true,
                servicePublicKey: 0n,
                jettonMinterAddress: jettonMinter.address,
                adminAddress: admin.address,
            }, mintMasterCode));
            await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

            // Give MintMaster jetton-minter admin rights first.
            await jettonMinter.sendChangeAdmin(admin.getSender(), mintMaster.address);
            await mintMaster.sendClaimJettonAdmin(admin.getSender(), toNano('0.2'), 1n);

            // Now MintMaster can proxy a change of JettonMinter admin.
            await mintMaster.sendChangeJettonAdmin(admin.getSender(), toNano('0.2'), newAdmin.address, 2n);
            await jettonMinter.sendClaimAdmin(newAdmin.getSender(), 3n);

            expect(await jettonMinter.getAdminAddress()).toEqualAddress(newAdmin.address);
        });
    });
});

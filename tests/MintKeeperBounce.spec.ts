import '@ton/test-utils';
import { internal } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { sign } from '@ton/crypto';

import { MintMaster, MintMasterOpcodes } from '../wrappers/MintMaster';
import { MintKeeper } from '../wrappers/MintKeeper';

import {
    createBlockchain,
    createRandomKeyPair,
    DEFAULT_NOW,
    Errors,
    extractInternalTxFeeBreakdown,
    findInternalTransaction,
    formatTon,
    isAnyFeeReportEnabled,
    printFeeBreakdown,
    publicKeyToBigInt,
} from './utils';

describe('MintKeeper Bounce Flow', () => {
    let mintMasterCode: Cell;
    let mintKeeperCode: Cell;

    beforeAll(async () => {
        mintMasterCode = await compile('MintMaster');
        mintKeeperCode = await compile('MintKeeper');
    });

    it('should bounce request when mint disabled, refund owner, and reset isMintClaimed', async () => {
        const feeReportEnabled = isAnyFeeReportEnabled();

        const blockchain = await createBlockchain(DEFAULT_NOW);
        const admin = await blockchain.treasury('admin');
        const user = await blockchain.treasury('user');
        const jettonMinter = await blockchain.treasury('jetton-minter');

        const keys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(keys.publicKey);

        const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
            isMintEnabled: false,
            servicePublicKey,
            jettonMinterAddress: jettonMinter.address,
            adminAddress: admin.address,
        }, mintMasterCode));

        await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

        const mintContext = {
            ownerAddress: user.address,
            price: 0n,
            amount: toNano('100'),
            agentPublicKey: 0n,
        };

        const mintKeeper = blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey,
            mintMasterAddress: mintMaster.address,
            mintContext,
        }, mintKeeperCode));

        const signature = sign(mintKeeper.init!.data.hash(), keys.secretKey);
        const claimValue = toNano('1.2');

        const result = await mintKeeper.sendClaimMint(user.getSender(), claimValue, signature, 777n);

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: mintKeeper.address,
            deploy: true,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintKeeper.address,
            to: mintMaster.address,
            success: false,
            exitCode: Errors.mintDisabled,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintMaster.address,
            to: mintKeeper.address,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: mintKeeper.address,
            to: user.address,
            success: true,
        });

        const keeperClaimTx = findInternalTransaction(result.transactions, user.address, mintKeeper.address);
        const masterRejectTx = findInternalTransaction(result.transactions, mintKeeper.address, mintMaster.address);
        const keeperBounceTx = findInternalTransaction(result.transactions, mintMaster.address, mintKeeper.address);
        const refundTx = findInternalTransaction(result.transactions, mintKeeper.address, user.address);

        const keeperClaimFees = extractInternalTxFeeBreakdown(keeperClaimTx);
        const masterRejectFees = extractInternalTxFeeBreakdown(masterRejectTx);
        const keeperBounceFees = extractInternalTxFeeBreakdown(keeperBounceTx);

        // Successful tx accounting should be exact.
        expect(keeperClaimFees.storageDue).toBe(0n);
        expect(keeperBounceFees.storageDue).toBe(0n);
        expect(keeperClaimFees.totalFees).toBe(
            keeperClaimFees.storageCollected + keeperClaimFees.compute + keeperClaimFees.action,
        );
        expect(keeperBounceFees.totalFees).toBe(
            keeperBounceFees.storageCollected + keeperBounceFees.compute + keeperBounceFees.action,
        );

        // Failed tx can include extra accounting (e.g. bounce/message fees) beyond storage+compute+action.
        expect(masterRejectFees.totalFees).toBeGreaterThanOrEqual(
            masterRejectFees.storageCollected + masterRejectFees.compute + masterRejectFees.action,
        );

        // Messages should chain as: ClaimMint -> RequestMint (rejected) -> onBouncedMessage -> refund.
        expect(keeperClaimFees.outValue).toBe(masterRejectFees.inValue);
        expect(keeperClaimFees.forwardNet).toBe(masterRejectFees.inForwardFee);
        expect(keeperBounceFees.outValue).toBe(
            refundTx.inMessage?.info.type === 'internal' ? (refundTx.inMessage.info.value.coins as bigint) : 0n,
        );

        const keeperBalanceAfter = await mintKeeper.getBalance();

        const keeperTotalIn = keeperClaimFees.inValue + keeperBounceFees.inValue;
        const keeperTotalOut = keeperClaimFees.outValue + keeperBounceFees.outValue;
        const keeperTotalDeductions =
            keeperClaimFees.storageCollected + keeperClaimFees.compute + keeperClaimFees.action + keeperClaimFees.forwardNet
            + keeperBounceFees.storageCollected + keeperBounceFees.compute + keeperBounceFees.action + keeperBounceFees.forwardNet;

        // MintKeeper started from zero balance and should keep minimal reserve after refund.
        expect(keeperTotalIn).toBe(keeperBalanceAfter + keeperTotalOut + keeperTotalDeductions);
        expect(keeperBalanceAfter).toBe(await mintKeeper.getMinStorageFee());
        expect(await mintKeeper.getIsMintClaimed()).toBe(false);

        const refundValue = refundTx.inMessage?.info.type === 'internal'
            ? (refundTx.inMessage.info.value.coins as bigint)
            : 0n;
        expect(refundValue).toBeGreaterThan(0n);

        if (feeReportEnabled) {
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('Mint Disabled Bounce Flow Fee Report');
            console.log('═══════════════════════════════════════════════════════════\n');
            printFeeBreakdown('[1] User -> MintKeeper (ClaimMint)', keeperClaimFees);
            console.log('');
            printFeeBreakdown('[2] MintKeeper -> MintMaster (rejected)', masterRejectFees);
            console.log('');
            printFeeBreakdown('[3] MintMaster -> MintKeeper (onBouncedMessage)', keeperBounceFees);
            console.log('');
            console.log(`Refund value to owner: ${formatTon(refundValue)}`);
            console.log(`MintKeeper final balance: ${formatTon(keeperBalanceAfter)}`);
            console.log('═══════════════════════════════════════════════════════════\n');
        }
    });

    it('should ignore spoofed bounced messages not sent from MintMaster', async () => {
        const blockchain = await createBlockchain(DEFAULT_NOW);

        const admin = await blockchain.treasury('admin');
        const user = await blockchain.treasury('user');
        const attacker = await blockchain.treasury('attacker');
        const jettonMinter = await blockchain.treasury('jetton-minter');

        const keys = await createRandomKeyPair();
        const servicePublicKey = publicKeyToBigInt(keys.publicKey);

        const mintMaster = blockchain.openContract(MintMaster.createFromConfig({
            isMintEnabled: true,
            servicePublicKey,
            jettonMinterAddress: jettonMinter.address,
            adminAddress: admin.address,
        }, mintMasterCode));
        await mintMaster.sendDeploy(admin.getSender(), toNano('0.5'));

        const mintContext = {
            ownerAddress: user.address,
            price: 0n,
            amount: toNano('100'),
            agentPublicKey: 0n,
        };

        const mintKeeper = blockchain.openContract(MintKeeper.createFromConfig({
            servicePublicKey,
            mintMasterAddress: mintMaster.address,
            mintContext,
        }, mintKeeperCode));

        const signature = sign(mintKeeper.init!.data.hash(), keys.secretKey);
        const claimValue = toNano('2');

        await mintKeeper.sendClaimMint(user.getSender(), claimValue, signature, 1n);
        expect(await mintKeeper.getIsMintClaimed()).toBe(true);

        const spoofedBounceBody = beginCell()
            .storeUint(0xffffffff, 32) // bounced prefix
            .storeUint(MintMasterOpcodes.requestMintJettons, 32) // RequestMintJettons
            .storeUint(1n, 64)         // queryId
            .endCell();

        await blockchain.sendMessage(internal({
            from: attacker.address,
            to: mintKeeper.address,
            value: toNano('0.05'),
            bounced: true,
            bounce: false,
            body: spoofedBounceBody,
        }));

        expect(await mintKeeper.getIsMintClaimed()).toBe(true);

        const secondClaim = await mintKeeper.sendClaimMint(user.getSender(), claimValue, signature, 2n);
        expect(secondClaim.transactions).toHaveTransaction({
            on: mintKeeper.address,
            from: user.address,
            success: false,
            exitCode: Errors.mintClaimAlreadyUsed,
        });
    });
});

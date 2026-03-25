import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, Slice, storeMessage, toNano } from '@ton/core';
import { fromNano } from '@ton/ton';
import { getSecureRandomBytes, keyPairFromSeed, KeyPair } from '@ton/crypto';

import { AgentWalletV5 } from '../wrappers/AgentWalletV5';
import { MintMaster } from '../wrappers/MintMaster';
import { JettonMinter, jettonContentToCell } from '../wrappers/03_notcoin/JettonMinter';

export const DEFAULT_NOW = 1_700_000_000;

export const Errors = {
    mintDisabled: 201,
    notOwnerTryingToClaimMint: 202,
    notEnoughFundsToClaimMint: 203,
    mintClaimAlreadyUsed: 204,
    signatureInvalid: 205,
    mintKeeperAddressMismatch: 206,
    notAdmin: 207,
    wrongWorkchain: 209,
    notNextAdmin: 210,
} as const;

export async function createBlockchain(now: number = DEFAULT_NOW): Promise<Blockchain> {
    const blockchain = await Blockchain.create();
    blockchain.now = now;
    return blockchain;
}

export async function createRandomKeyPair(): Promise<KeyPair> {
    return keyPairFromSeed(await getSecureRandomBytes(32));
}

export function publicKeyToBigInt(publicKey: Uint8Array): bigint {
    return BigInt(`0x${Buffer.from(publicKey).toString('hex')}`);
}

export function formatTon(nanoTon: bigint): string {
    return `${fromNano(nanoTon)} TON (${nanoTon} nanoTON)`;
}

export function isFullFlowFeeReportEnabled(): boolean {
    return process.env.FULL_FLOW_FEE_REPORT === '1';
}

export function isAnyFeeReportEnabled(): boolean {
    return isFullFlowFeeReportEnabled() || process.env.FEE_REPORT === '1';
}

export function findInternalTransaction(transactions: any[], from: Address, to: Address): any {
    const transaction = transactions.find((item) =>
        item.inMessage?.info.type === 'internal'
        && item.inMessage.info.src.equals(from)
        && item.inMessage.info.dest.equals(to),
    );

    if (!transaction) {
        throw new Error(`Internal transaction not found: ${from.toString()} -> ${to.toString()}`);
    }

    return transaction;
}

export type InternalTxFeeBreakdown = {
    inValue: bigint;
    inForwardFee: bigint;
    outValue: bigint;

    storageCollected: bigint;
    storageDue: bigint;
    compute: bigint;
    action: bigint;
    forwardTotal: bigint;
    forwardNet: bigint;
    totalFees: bigint;
};

export function extractInternalTxFeeBreakdown(tx: any): InternalTxFeeBreakdown {
    if (tx.description.type !== 'generic') {
        throw new Error(`Generic transaction expected, got ${tx.description.type}`);
    }

    const storageCollected = (tx.description.storagePhase?.storageFeesCollected ?? 0n) as bigint;
    const storageDue = (tx.description.storagePhase?.storageFeesDue ?? 0n) as bigint;

    const compute = tx.description.computePhase.type === 'vm'
        ? (tx.description.computePhase.gasFees as bigint)
        : 0n;

    const action = (tx.description.actionPhase?.totalActionFees ?? 0n) as bigint;
    const forwardTotal = (tx.description.actionPhase?.totalFwdFees ?? 0n) as bigint;
    const forwardNet = forwardTotal - action;

    const inValue = tx.inMessage?.info.type === 'internal'
        ? (tx.inMessage.info.value.coins as bigint)
        : 0n;
    const inForwardFee = tx.inMessage?.info.type === 'internal'
        ? (tx.inMessage.info.forwardFee as bigint)
        : 0n;

    const outValue = [...tx.outMessages.values()]
        .filter((msg: any) => msg.info.type === 'internal')
        .reduce((acc: bigint, msg: any) => acc + (msg.info.value.coins as bigint), 0n);

    const totalFees = (tx.totalFees?.coins ?? 0n) as bigint;

    return {
        inValue,
        inForwardFee,
        outValue,
        storageCollected,
        storageDue,
        compute,
        action,
        forwardTotal,
        forwardNet,
        totalFees,
    };
}

export function expectSuccessfulInternalTxFeesToMatchAccounting(fees: InternalTxFeeBreakdown) {
    expect(fees.storageDue).toBe(0n);
    expect(fees.totalFees).toBe(fees.storageCollected + fees.compute + fees.action);
}

export function extractGasUsed(tx: any): bigint {
    if (tx.description.type !== 'generic') {
        throw new Error(`Generic transaction expected, got ${tx.description.type}`);
    }

    if (tx.description.computePhase.type !== 'vm') {
        throw new Error(`VM compute phase expected, got ${tx.description.computePhase.type}`);
    }

    return tx.description.computePhase.gasUsed as bigint;
}

export type CellStats = {
    bits: bigint;
    cells: bigint;
};

export type MsgPrices = {
    lumpPrice: bigint;
    bitPrice: bigint;
    cellPrice: bigint;
    ihrPriceFactor: bigint;
    firstFrac: bigint;
    nextFrac: bigint;
};

export function collectCellStats(cell: Cell, visited: Set<string> = new Set(), skipRoot: boolean = false): CellStats {
    const hash = cell.hash().toString('hex');
    if (visited.has(hash)) {
        return { bits: 0n, cells: 0n };
    }
    visited.add(hash);

    let bits = skipRoot ? 0n : BigInt(cell.bits.length);
    let cells = skipRoot ? 0n : 1n;

    for (const ref of cell.refs) {
        const stats = collectCellStats(ref, visited, false);
        bits += stats.bits;
        cells += stats.cells;
    }

    return { bits, cells };
}

function shr16ceil(src: bigint): bigint {
    const mod = src % 65536n;
    const div = src / 65536n;
    return mod === 0n ? div : div + 1n;
}

function parseMsgPrices(slice: Slice): MsgPrices {
    const magic = slice.loadUint(8);
    if (magic !== 0xea) {
        throw new Error(`Invalid message prices magic: ${magic}`);
    }

    return {
        lumpPrice: slice.loadUintBig(64),
        bitPrice: slice.loadUintBig(64),
        cellPrice: slice.loadUintBig(64),
        ihrPriceFactor: slice.loadUintBig(32),
        firstFrac: slice.loadUintBig(16),
        nextFrac: slice.loadUintBig(16),
    };
}

export function getMsgPrices(config: Cell, workchain: 0 | -1): MsgPrices {
    const dict = config.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
    const pricesCell = dict.get(25 + workchain);
    if (!pricesCell) {
        throw new Error(`Message prices not found in config for workchain ${workchain}`);
    }
    return parseMsgPrices(pricesCell.beginParse());
}

export type ForwardFees = {
    total: bigint;
    actionFee: bigint;
    remaining: bigint;
};

export function computeForwardFeesVerbose(msgPrices: MsgPrices, stats: CellStats): ForwardFees {
    const total = msgPrices.lumpPrice
        + shr16ceil(msgPrices.bitPrice * stats.bits + msgPrices.cellPrice * stats.cells);

    const actionFee = (total * msgPrices.firstFrac) >> 16n;
    return { total, actionFee, remaining: total - actionFee };
}

export function extractInternalMessageForwardFeeStats(params: {
    blockchain: Blockchain;
    message: any;
    workchain?: 0 | -1;
}): { stats: CellStats; fees: ForwardFees } {
    const workchain = params.workchain ?? 0;
    const msgPrices = getMsgPrices(params.blockchain.config, workchain);

    if (params.message?.info?.type !== 'internal') {
        throw new Error('Internal message expected');
    }

    const packedMsg = beginCell().store(storeMessage(params.message)).endCell();
    const stats = collectCellStats(packedMsg, new Set(), true);
    const fees = computeForwardFeesVerbose(msgPrices, stats);

    const expectedForwardFee = params.message.info.forwardFee as bigint;
    if (fees.remaining !== expectedForwardFee) {
        throw new Error(
            `Forward fee mismatch: expected ${expectedForwardFee}, computed ${fees.remaining} (cells=${stats.cells}, bits=${stats.bits})`,
        );
    }

    return { stats, fees };
}

export function sumCellStats(...stats: CellStats[]): CellStats {
    return stats.reduce<CellStats>((acc, s) => ({ bits: acc.bits + s.bits, cells: acc.cells + s.cells }), {
        bits: 0n,
        cells: 0n,
    });
}

export function extractMessageInitStats(message: any): CellStats {
    if (!message?.init) {
        return { bits: 0n, cells: 0n };
    }

    const visited = new Set<string>();
    let stats: CellStats = { bits: 0n, cells: 0n };

    let refCount = 0;
    let overheadBits = 5n; // minimal additional bits for StateInit wrapper

    if (message.init.splitDepth) {
        overheadBits += 5n;
    }

    if (message.init.libraries) {
        refCount += 1;
        const libsCell = beginCell().storeDictDirect(message.init.libraries).endCell();
        stats = sumCellStats(stats, collectCellStats(libsCell, visited, true));
    }

    if (message.init.code) {
        refCount += 1;
        stats = sumCellStats(stats, collectCellStats(message.init.code, visited, false));
    }

    if (message.init.data) {
        refCount += 1;
        stats = sumCellStats(stats, collectCellStats(message.init.data, visited, false));
    }

    if (refCount >= 2) {
        stats = { bits: stats.bits + overheadBits, cells: stats.cells + 1n };
    }

    return stats;
}

export function printFeeBreakdown(title: string, fees: InternalTxFeeBreakdown) {
    const lines = [
        title,
        `  inValue:     ${formatTon(fees.inValue)}`,
        `  outValue:    ${formatTon(fees.outValue)}`,
        `  storage:     ${formatTon(fees.storageCollected)}`,
        `  storageDue:  ${formatTon(fees.storageDue)}`,
        `  compute:     ${formatTon(fees.compute)}`,
        `  action:      ${formatTon(fees.action)}`,
        `  fwdTotal:    ${formatTon(fees.forwardTotal)} (action + fwdNet)`,
        `  fwdNet:      ${formatTon(fees.forwardNet)}`,
        `  totalFees:   ${formatTon(fees.totalFees)}`,
    ];
    console.log(lines.join('\n'));
}

export function expectedAgentWalletAddress(ownerAddress: Address, agentPublicKey: Buffer, agentWalletCode: Cell): Address {
    const config = {
        signatureAllowed: true,
        seqno: 0,
        walletId: 0,
        publicKey: agentPublicKey,
        ownerAddress,
    };
    return AgentWalletV5.createFromConfig(config, agentWalletCode).address;
}

export function addLibraryToBlockchain(blockchain: Blockchain, code: Cell): Cell {
    const dict = blockchain.libs
        ? blockchain.libs.beginParse().loadDictDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
        : Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());

    dict.set(BigInt(`0x${code.hash().toString('hex')}`), code);
    blockchain.libs = beginCell().storeDictDirect(dict).endCell();

    const libPrep = beginCell().storeUint(2, 8).storeBuffer(code.hash()).endCell();
    return new Cell({ exotic: true, bits: libPrep.bits, refs: libPrep.refs });
}

export async function deployNotcoinJettonMinter(params: {
    blockchain: Blockchain;
    admin: SandboxContract<TreasuryContract>;
    minterCode: Cell;
    walletCodeRaw: Cell;
}): Promise<SandboxContract<JettonMinter>> {
    const walletCode = addLibraryToBlockchain(params.blockchain, params.walletCodeRaw);
    const contract = params.blockchain.openContract(JettonMinter.createFromConfig({
        admin: params.admin.address,
        nextAdmin: null,
        wallet_code: walletCode,
        jetton_content: jettonContentToCell({ uri: 'ipfs://jetton-metadata' }),
    }, params.minterCode));

    await contract.sendDeploy(params.admin.getSender(), toNano('2'));
    return contract;
}

export async function makeMintMasterJettonAdmin(params: {
    jettonMinter: SandboxContract<JettonMinter>;
    mintMaster: SandboxContract<MintMaster>;
    admin: SandboxContract<TreasuryContract>;
}) {
    await params.jettonMinter.sendChangeAdmin(params.admin.getSender(), params.mintMaster.address);
    await params.mintMaster.sendClaimJettonAdmin(params.admin.getSender(), toNano('0.1'));
}

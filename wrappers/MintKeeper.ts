import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
} from '@ton/core';

export const MintKeeperOpcodes = {
    claimMint: 0xc8c37acc,
} as const;

export type MintContextConfig = {
    ownerAddress: Address;
    price: bigint;
    amount: bigint;
    agentPublicKey: bigint;
};

export type MintKeeperConfig = {
    servicePublicKey: bigint;
    mintMasterAddress: Address;
    mintContext: MintContextConfig;
    isMintClaimed?: boolean;
};

function mintContextToCell(context: MintContextConfig): Cell {
    return beginCell()
        .storeAddress(context.ownerAddress)
        .storeCoins(context.price)
        .storeCoins(context.amount)
        .storeUint(context.agentPublicKey, 256)
        .endCell();
}

export function mintKeeperConfigToCell(config: MintKeeperConfig): Cell {
    return beginCell()
        .storeBit(config.isMintClaimed ?? false)
        .storeUint(config.servicePublicKey, 256)
        .storeAddress(config.mintMasterAddress)
        .storeRef(mintContextToCell(config.mintContext))
        .endCell();
}

export class MintKeeper implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MintKeeper(address);
    }

    static createFromConfig(config: MintKeeperConfig, code: Cell, workchain = 0) {
        const data = mintKeeperConfigToCell(config);
        const init = { code, data };
        return new MintKeeper(contractAddress(workchain, init), init);
    }

    async sendClaimMint(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        signature: Buffer,
        queryId: bigint = 0n,
    ) {
        if (signature.length !== 64) {
            throw new Error(`Signature must be 64 bytes, got ${signature.length}`);
        }

        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MintKeeperOpcodes.claimMint, 32) // ClaimMint
                .storeUint(queryId, 64)
                .storeBuffer(signature)
                .endCell(),
        });
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState();
        return state.balance;
    }

    async getIsMintClaimed(provider: ContractProvider): Promise<boolean> {
        const { stack } = await provider.get('get_is_mint_claimed', []);
        return stack.readBoolean();
    }

    async getMinStorageFee(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_min_storage_fee', []);
        return stack.readBigNumber();
    }
}

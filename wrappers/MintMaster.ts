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

export const MintMasterOpcodes = {
    requestMintJettons: 0xcfccc2c4,
    toggleMint: 0x61c5c9d6,
    withdrawTons: 0x6d8e5e3c,
    changeJettonAdmin: 0x6501f354,
    claimJettonAdmin: 0xfb88e119,
    topUpTons: 0xd372158c,
} as const;

export type MintMasterConfig = {
    isMintEnabled: boolean;
    servicePublicKey: bigint;
    jettonMinterAddress: Address;
    adminAddress: Address;
};

export function mintMasterConfigToCell(config: MintMasterConfig): Cell {
    return beginCell()
        .storeBit(config.isMintEnabled)
        .storeUint(config.servicePublicKey, 256)
        .storeAddress(config.jettonMinterAddress)
        .storeAddress(config.adminAddress)
        .endCell();
}

export class MintMaster implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MintMaster(address);
    }

    static createFromConfig(config: MintMasterConfig, code: Cell, workchain = 0) {
        const data = mintMasterConfigToCell(config);
        const init = { code, data };
        return new MintMaster(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendTopUpTons(provider, via, value);
    }

    async sendTopUpTons(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MintMasterOpcodes.topUpTons, 32) // TopUpTons
                .endCell(),
        });
    }

    async sendToggleMint(provider: ContractProvider, via: Sender, value: bigint, enableMint: boolean, queryId: bigint = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MintMasterOpcodes.toggleMint, 32) // ToggleMint
                .storeUint(queryId, 64)
                .storeBit(enableMint)
                .endCell(),
        });
    }

    async sendWithdrawTons(provider: ContractProvider, via: Sender, value: bigint, queryId: bigint = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MintMasterOpcodes.withdrawTons, 32) // WithdrawTons
                .storeUint(queryId, 64)
                .endCell(),
        });
    }

    async sendChangeJettonAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        newAdminAddress: Address,
        queryId: bigint = 0n,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MintMasterOpcodes.changeJettonAdmin, 32) // ChangeJettonAdmin (ChangeMinterAdmin)
                .storeUint(queryId, 64)
                .storeAddress(newAdminAddress)
                .endCell(),
        });
    }

    async sendClaimJettonAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint = 0n,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MintMasterOpcodes.claimJettonAdmin, 32) // ClaimJettonAdmin (ClaimMinterAdmin)
                .storeUint(queryId, 64)
                .endCell(),
        });
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState();
        return state.balance;
    }

    async getIsMintEnabled(provider: ContractProvider): Promise<boolean> {
        const { stack } = await provider.get('get_is_mint_enabled', []);
        return stack.readBoolean();
    }

    async getMintMasterData(provider: ContractProvider): Promise<{
        isMintEnabled: boolean;
        servicePublicKey: bigint;
        jettonMinterAddress: Address;
        adminAddress: Address;
    }> {
        const { stack } = await provider.get('get_mint_master_data', []);
        return {
            isMintEnabled: stack.readBoolean(),
            servicePublicKey: stack.readBigNumber(),
            jettonMinterAddress: stack.readAddress(),
            adminAddress: stack.readAddress(),
        };
    }

    async getMinStorageFee(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_min_storage_fee', []);
        return stack.readBigNumber();
    }

    async getClaimMintRequiredValue(provider: ContractProvider, price: bigint, amount: bigint): Promise<bigint> {
        const { stack } = await provider.get('get_claim_mint_required_value', [
            { type: 'int', value: price },
            { type: 'int', value: amount },
        ]);
        return stack.readBigNumber();
    }
}

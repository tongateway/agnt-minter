// Storage layouts are ABI-critical; do not reorder fields.

struct MintContext {
    ownerAddress: address;
    price: coins;
    amount: coins;
    agentPublicKey: uint256;
}

// MintKeeper storage.
struct MintKeeperStorage {
    isMintClaimed: bool = false;
    servicePublicKey: uint256;
    mintMasterAddress: address;
    mintContext: Cell<MintContext>;
}

@inline
fun MintKeeperStorage.load(): MintKeeperStorage {
    return MintKeeperStorage.fromCell(contract.getData());
}

@inline
fun MintKeeperStorage.save(self) {
    contract.setData(self.toCell());
}

// MintMaster storage.
struct MintMasterStorage {
    isMintEnabled: bool;
    servicePublicKey: uint256;
    jettonMinterAddress: address;
    adminAddress: address;
    nextAdminAddress: Cell<address>?;
}

@inline
fun MintMasterStorage.load(): MintMasterStorage {
    return MintMasterStorage.fromCell(contract.getData());
}

@inline
fun MintMasterStorage.save(self) {
    contract.setData(self.toCell());
}

import "storage"
import "03_notcoin/messages"

struct (0xc8c37acc) ClaimMint {
    queryId: uint64;
    signature: bits512;
}

type MintKeeperInMsg = ClaimMint


struct (0xcfccc2c4) RequestMintJettons {
    queryId: uint64;
    mintContext: MintContext;
}

struct (0x61c5c9d6) ToggleMint {
    queryId: uint64;
    enableMint: bool;
}

struct (0x6d8e5e3c) WithdrawTons {
    queryId: uint64;
}

type ChangeJettonAdmin = ChangeMinterAdmin
type ClaimJettonAdmin = ClaimMinterAdmin

struct (0xa4ed9981) ChangeMintMasterAdmin {
    queryId: uint64;
    newAdminAddress: address;
}

struct (0x1b332ab2) ClaimMintMasterAdmin {
    queryId: uint64;
}

// TopUpTons

type MintMasterInMsg =
    | RequestMintJettons
    | ToggleMint
    | WithdrawTons
    | ChangeJettonAdmin
    | ClaimJettonAdmin
    | ChangeMintMasterAdmin
    | ClaimMintMasterAdmin
    | TopUpTons

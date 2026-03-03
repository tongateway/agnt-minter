import "storage"
import "auto/mint-keeper-code"
import "auto/agent-wallet-v5-code"

// ============================================================================
// MintKeeper helpers
// ============================================================================

@inline
fun calcDeployedMintKeeper(servicePublicKey: uint256, mintMasterAddress: address, mintContext: MintContext): AutoDeployAddress {
    return {
        stateInit: {
            data: MintKeeperStorage {
                servicePublicKey,
                mintMasterAddress,
                mintContext: mintContext.toCell()
            }.toCell(),
            code: mintKeeperCode()
        }
    }
}

@inline
fun calculateMintKeeperAddress(servicePublicKey: uint256, mintMasterAddress: address, mintContext: MintContext) {
    return calcDeployedMintKeeper(servicePublicKey, mintMasterAddress, mintContext).calculateAddress()
}

// ============================================================================
// AgentWalletV5 helpers
// ============================================================================

// AgentWalletV5 `StateInit.data` layout: signatureAllowed, seqno, walletId, publicKey, ownerAddress.
struct AgentWalletV5Data {
    signatureAllowed: bool;
    seqno: uint32;
    walletId: uint32;
    publicKey: uint256;
    ownerAddress: address;
}

const AGENT_WALLET_V5_DEFAULT_SIGNATURE_ALLOWED: bool = true;
const AGENT_WALLET_V5_DEFAULT_SEQNO: uint32 = 0;
const AGENT_WALLET_V5_DEFAULT_WALLET_ID: uint32 = 0;

@inline
fun buildAgentWalletV5Data(ownerAddress: address, agentPublicKey: uint256): cell {
    return AgentWalletV5Data {
        signatureAllowed: AGENT_WALLET_V5_DEFAULT_SIGNATURE_ALLOWED,
        seqno: AGENT_WALLET_V5_DEFAULT_SEQNO,
        walletId: AGENT_WALLET_V5_DEFAULT_WALLET_ID,
        publicKey: agentPublicKey,
        ownerAddress: ownerAddress,
    }.toCell();
}

@inline
fun calcDeployedAgentWallet(ownerAddress: address, agentWalletV5Data: cell): AutoDeployAddress {
    return {
        workchain: ownerAddress.getWorkchain(),
        stateInit: {
            code: agentWalletV5Code(),
            data: agentWalletV5Data
        }
    };
}

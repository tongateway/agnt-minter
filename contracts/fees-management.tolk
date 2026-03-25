import "@stdlib/gas-payments"

// ============================================================================
// Shared environment
// ============================================================================

const MY_WORKCHAIN = BASECHAIN

const MIN_STORAGE_DURATION = 365 * 24 * 60 * 60 // 1 year
// Must match `contracts/03_notcoin/fees-management.tolk` (`MIN_STORAGE_DURATION`).
const JETTON_WALLET_MIN_STORAGE_DURATION = 5 * 365 * 24 * 60 * 60 // 5 years

// ============================================================================
// Internal fees: keeper + master
// - 2 compute phases (keeper claim + master request-mint)
// - 1 forward fee (keeper -> master)
// ============================================================================

// Keep contract reserve for long-term storage (code + data, measured in tests).
const STORAGE_SIZE_MintKeeper_bits = 4157;
const STORAGE_SIZE_MintKeeper_cells = 12;
const STORAGE_SIZE_MintMaster_bits = 13501;
const STORAGE_SIZE_MintMaster_cells = 44;

// Gas units for keeper/master part.
const GAS_CONSUMPTION_MintKeeperClaim = 6788;
const GAS_CONSUMPTION_MintMasterRequestMint = 9397;

// ============================================================================
// Mint fees: master -> jetton-master -> jetton-wallet
// - forward fee to jetton-master
// - jetton-master compute
// - delivery budget to jetton-wallet (same additive scheme as in jetton checks)
// ============================================================================

// Jetton wallet storage size (max), for library-reference wallet code.
// Must match `contracts/03_notcoin/fees-management.tolk` (`STORAGE_SIZE_MaxWallet_*`).
const STORAGE_SIZE_JettonWallet_bits = 1033;
const STORAGE_SIZE_JettonWallet_cells = 3;

// Jetton wallet StateInit size for internal_transfer auto-deploy (library-reference wallet code).
// Must match `contracts/03_notcoin/fees-management.tolk` (`STORAGE_SIZE_InitStateWallet_*`).
const STORAGE_SIZE_InitStateJettonWallet_bits = 931;
const STORAGE_SIZE_InitStateJettonWallet_cells = 3;

// Agent wallet StateInit size in this repo setup (full code, non-library).
const STORAGE_SIZE_InitStateAgentWalletV5_bits = 4270;
const STORAGE_SIZE_InitStateAgentWalletV5_cells = 18;

// Message body sizes in mint flow.
// Worst-case `MintNewJettons` body size for our mint path:
// - `sendExcessesTo` is set to the recipient (refunds go to recipient)
// - `forwardTonAmount = 1` to trigger `transfer_notification`
// - `coins` is TL-B VarUInteger16 (up to 124 bits)
// - `address` is MsgAddressInt (267 bits)
const MESSAGE_SIZE_MasterToJettonMint_bits = 893;
const MESSAGE_SIZE_MasterToJettonMint_cells = 2;

// Worst-case `RequestMintJettons` body size (MintKeeper -> MintMaster):
// - `address` is MsgAddressInt (267 bits)
// - `coins` is TL-B VarUInteger16 (up to 124 bits)
const MESSAGE_SIZE_KeeperToMasterRequestMint_bits = 867;
const MESSAGE_SIZE_KeeperToMasterRequestMint_cells = 1;

// Small buffer to exceed strict `>` checks and rounding effects in forward-fee accounting.
const JETTON_MINT_FWD_FEE_ROUNDING_BUFFER: coins = 4;

// Gas units for jetton path.
const GAS_CONSUMPTION_JettonMint = 6218;
// JettonMinter uses Notcoin transfer accounting and expects max JettonWallet gas constants.
const GAS_CONSUMPTION_JettonWalletTransfer = 6153;
const GAS_CONSUMPTION_JettonWalletReceive = 7253;

// ============================================================================
// Internal fees helpers
// ============================================================================

@inline
fun calculateMintKeeperMinStorageFee() {
    return calculateStorageFee(
        MY_WORKCHAIN,
        MIN_STORAGE_DURATION,
        STORAGE_SIZE_MintKeeper_bits,
        STORAGE_SIZE_MintKeeper_cells
    );
}

@inline
fun calculateMintMasterMinStorageFee() {
    return calculateStorageFee(
        MY_WORKCHAIN,
        MIN_STORAGE_DURATION,
        STORAGE_SIZE_MintMaster_bits,
        STORAGE_SIZE_MintMaster_cells
    );
}

@inline
fun calculateClaimInternalFees(): coins {
    val keeperGas = calculateGasFee(MY_WORKCHAIN, GAS_CONSUMPTION_MintKeeperClaim);
    val masterGas = calculateGasFee(MY_WORKCHAIN, GAS_CONSUMPTION_MintMasterRequestMint);
    val keeperStorageFee = calculateMintKeeperMinStorageFee();
    val masterStorageFee = calculateMintMasterMinStorageFee();
    val keeperToMasterFwdFee = calculateForwardFeeKeeperToMasterRequestMint();
    return keeperGas + masterGas + keeperStorageFee + masterStorageFee + keeperToMasterFwdFee;
}

// ============================================================================
// Mint fees helpers
// ============================================================================

struct JettonMintFeeSplit {
    masterToJettonFwdFee: coins
    jettonWalletTonValue: coins
    jettonMintMessageTonValue: coins
}

@inline
fun calculateJettonWalletMinStorageFee() {
    return calculateStorageFee(
        MY_WORKCHAIN,
        JETTON_WALLET_MIN_STORAGE_DURATION,
        STORAGE_SIZE_JettonWallet_bits,
        STORAGE_SIZE_JettonWallet_cells
    );
}

@inline
fun calculateForwardFeeMasterToJettonMint() {
    return calculateForwardFee(
        MY_WORKCHAIN,
        MESSAGE_SIZE_MasterToJettonMint_bits,
        MESSAGE_SIZE_MasterToJettonMint_cells
    );
}

@inline
fun calculateForwardFeeKeeperToMasterRequestMint() {
    return calculateForwardFee(
        MY_WORKCHAIN,
        MESSAGE_SIZE_KeeperToMasterRequestMint_bits,
        MESSAGE_SIZE_KeeperToMasterRequestMint_cells
    );
}

@inline
fun calculateForwardFeeMasterToAgentWalletV5() {
    // MintMaster sends an auto-deploy message to AgentWalletV5 with an empty body,
    // so message size is dominated by StateInit (code+data).
    return calculateForwardFee(
        MY_WORKCHAIN,
        STORAGE_SIZE_InitStateAgentWalletV5_bits,
        STORAGE_SIZE_InitStateAgentWalletV5_cells
    );
}

@inline
fun calculateForwardInitStateJettonWalletOverhead() {
    return calculateForwardFeeWithoutLumpPrice(
        MY_WORKCHAIN,
        STORAGE_SIZE_InitStateJettonWallet_bits,
        STORAGE_SIZE_InitStateJettonWallet_cells
    );
}

@inline
fun calculateJettonMintFeeSplit(): JettonMintFeeSplit {
    // Same additive scheme as 03_notcoin/checkAmountIsEnoughToTransfer.
    val masterToJettonFwdFee = calculateForwardFeeMasterToJettonMint();
    // Non-zero forward amount is required to trigger `transfer_notification` to the recipient.
    val forwardTonAmount: coins = 1;
    val fwdCount = 2;
    val transferForwardBudget =
        forwardTonAmount +
        fwdCount * masterToJettonFwdFee +
        calculateForwardInitStateJettonWalletOverhead();

    val jettonWalletTonValue =
        transferForwardBudget +
        calculateGasFee(MY_WORKCHAIN, GAS_CONSUMPTION_JettonWalletTransfer) +
        calculateGasFee(MY_WORKCHAIN, GAS_CONSUMPTION_JettonWalletReceive) +
        calculateJettonWalletMinStorageFee() +
        1 +
        JETTON_MINT_FWD_FEE_ROUNDING_BUFFER;

    return {
        masterToJettonFwdFee,
        jettonWalletTonValue,
        jettonMintMessageTonValue: jettonWalletTonValue +
        calculateGasFee(MY_WORKCHAIN, GAS_CONSUMPTION_JettonMint) +
        transferForwardBudget,
    };
}

// ============================================================================
// Total fees: internal + mint + 1 forward to agent-wallet
// ============================================================================

@inline
fun calculateJettonMintTotalTonValue(): coins {
    val split = calculateJettonMintFeeSplit();
    return
        split.masterToJettonFwdFee +
        split.jettonMintMessageTonValue;
}

@inline
fun calculateClaimMintFlowFees(): coins {
    // Only message/compute/fwd costs of the claim path:
    // internal + mint + 1 forward on master -> agent-wallet send.
    val internalFees = calculateClaimInternalFees();
    val mintFees = calculateJettonMintTotalTonValue();
    val masterToWalletFwdFee = calculateForwardFeeMasterToAgentWalletV5();

    // AgentWalletV5 compute/storage is paid from the carried remaining value, so we only budget the forward fee.
    return internalFees + mintFees + masterToWalletFwdFee;
}

@inline
fun calculateClaimMintRequiredValue(price: coins): coins {
    val protocolFee = price;
    return
        calculateClaimMintFlowFees() +
        protocolFee;
}

// ============================================================================
// Reserve helpers
// ============================================================================

@inline
fun reserveOriginalBalance() {
    reserveToncoinsOnBalance(
        contract.getStoragePaidPayment(),
        RESERVE_MODE_INCREASE_BY_ORIGINAL_BALANCE | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL
    );
}

@inline
fun reserveOriginalBalancePlusFee(fee: coins) {
    reserveToncoinsOnBalance(
        contract.getStoragePaidPayment() + fee,
        RESERVE_MODE_INCREASE_BY_ORIGINAL_BALANCE | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL
    );
}

@inline
fun reserveMintKeeperMinimum() {
    reserveToncoinsOnBalance(calculateMintKeeperMinStorageFee(), RESERVE_MODE_EXACT_AMOUNT);
}

@inline
fun reserveMintMasterMinimum() {
    reserveToncoinsOnBalance(calculateMintMasterMinStorageFee(), RESERVE_MODE_EXACT_AMOUNT);
}

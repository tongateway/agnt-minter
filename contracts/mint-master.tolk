import "@stdlib/gas-payments"

import "errors"
import "fees-management"
import "messages"
import "storage"
import "utils"
import "03_notcoin/messages"

// ============================================================================
// Handlers
// ============================================================================

fun onInternalMessage(in: InMessage) {
    var storage = lazy MintMasterStorage.load();
    val msg = lazy MintMasterInMsg.fromSlice(in.body);

    match (msg) {
        RequestMintJettons => {
            assert (storage.isMintEnabled) throw ERROR_MINT_DISABLED;

            val ctx = msg.mintContext;
            assert (ctx.ownerAddress.getWorkchain() == MY_WORKCHAIN) throw ERROR_WRONG_WORKCHAIN;

            val expectedMintKeeperAddress = calculateMintKeeperAddress(
                storage.servicePublicKey,
                contract.getAddress(),
                ctx
            );
            assert (in.senderAddress == expectedMintKeeperAddress) throw ERROR_MINT_KEEPER_ADDRESS_MISMATCH;

            // Keep original balance + protocol fee on contract.
            val protocolFee = ctx.price * ctx.amount;
            reserveOriginalBalancePlusFee(protocolFee);

            val agentWalletV5Data = buildAgentWalletV5Data(
                ctx.ownerAddress,
                ctx.agentPublicKey
            );

            val agentWallet = calcDeployedAgentWallet(ctx.ownerAddress, agentWalletV5Data);
            val agentWalletAddress = agentWallet.calculateAddress();

            val feeSplit = calculateJettonMintFeeSplit();
            mintJettonsToAgentWallet(
                storage.jettonMinterAddress,
                agentWalletAddress,
                msg.queryId,
                ctx.amount,
                feeSplit.jettonMintMessageTonValue,
                feeSplit.jettonWalletTonValue
            );

            sendAllRemainingTonsToAgentWallet(agentWallet);
        }

        ToggleMint => {
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_ADMIN;

            storage.isMintEnabled = msg.enableMint;
            storage.save();

            // Keep original balance; return the rest to admin.
            reserveOriginalBalance();

            val excessMsg = createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.adminAddress,
                body: ReturnExcessesBack {
                    queryId: msg.queryId
                }
            });

            excessMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        WithdrawTons => {
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_ADMIN;

            // Keep minimal reserve; withdraw the rest.
            reserveMintMasterMinimum();

            val payoutMsg = createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.adminAddress
            });

            payoutMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        ChangeJettonAdmin => {
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_ADMIN;
            reserveOriginalBalance();
            sendChangeJettonAdminCall(
                storage.jettonMinterAddress,
                msg.queryId,
                msg.newAdminAddress
            );
        }

        ClaimJettonAdmin => {
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_ADMIN;
            reserveOriginalBalance();
            sendClaimJettonAdminCall(
                storage.jettonMinterAddress,
                msg.queryId
            );
        }

        TopUpTons => {
            // Accept TONs.
        }

        else => throw 0xFFFF
    }
}

// ============================================================================
// Internal helpers
// ============================================================================

@inline
fun sendAllRemainingTonsToAgentWallet(agentWallet: AutoDeployAddress) {
    val outMsg = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: agentWallet
    });
    outMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

@inline
fun mintJettonsToAgentWallet(
    jettonMinterAddress: address,
    mintRecipient: address,
    queryId: uint64,
    jettonAmount: coins,
    jettonMintMessageTonValue: coins,
    jettonWalletTonValue: coins
) {
    val mintMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: jettonMintMessageTonValue,
        dest: jettonMinterAddress,
        body: MintNewJettons {
            queryId: queryId,
            mintRecipient: mintRecipient,
            tonAmount: jettonWalletTonValue,
            internalTransferMsg: InternalTransferStep {
                queryId: queryId,
                jettonAmount: jettonAmount,
                transferInitiator: null,
                sendExcessesTo: mintRecipient,
                forwardTonAmount: 1,
                forwardPayload: beginCell().storeMaybeRef(null).endCell().beginParse(),
            }.toCell(),
        },
    });
    mintMsg.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

@inline
fun sendChangeJettonAdminCall(jettonMinterAddress: address, queryId: uint64, newAdminAddress: address) {
    val outMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: jettonMinterAddress,
        body: ChangeJettonAdmin {
            queryId: queryId,
            newAdminAddress: newAdminAddress
        }
    });
    outMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

@inline
fun sendClaimJettonAdminCall(jettonMinterAddress: address, queryId: uint64) {
    val outMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: jettonMinterAddress,
        body: ClaimJettonAdmin {
            queryId: queryId
        }
    });
    outMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// ============================================================================
// Get methods
// ============================================================================

struct MintMasterDataReply {
    isMintEnabled: bool
    servicePublicKey: uint256
    jettonMinterAddress: address
    adminAddress: address
}

get fun get_mint_master_data(): MintMasterDataReply {
    val storage = lazy MintMasterStorage.load();
    return {
        isMintEnabled: storage.isMintEnabled,
        servicePublicKey: storage.servicePublicKey,
        jettonMinterAddress: storage.jettonMinterAddress,
        adminAddress: storage.adminAddress,
    };
}

get fun get_is_mint_enabled(): bool {
    val storage = lazy MintMasterStorage.load();
    return storage.isMintEnabled;
}

get fun get_min_storage_fee(): coins {
    return calculateMintMasterMinStorageFee();
}

get fun get_claim_mint_required_value(price: coins, amount: coins): coins {
    return calculateClaimMintRequiredValue(price, amount);
}

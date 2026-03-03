import "errors"
import "fees-management"
import "messages"
import "storage"

// ============================================================================
// Handlers
// ============================================================================

fun onInternalMessage(in: InMessage) {
    var storage = lazy MintKeeperStorage.load();
    val msg = lazy MintKeeperInMsg.fromSlice(in.body);

    match (msg) {
        ClaimMint => {
            assert (storage.isMintClaimed == false) throw ERROR_MINT_CLAIM_ALREADY_USED;

            val ctx = lazy storage.mintContext.load();
            assert (ctx.ownerAddress.getWorkchain() == MY_WORKCHAIN) throw ERROR_WRONG_WORKCHAIN;
            assert (in.senderAddress == ctx.ownerAddress) throw ERROR_NOT_OWNER_TRYING_TO_CLAIM_MINT;

            val requiredClaimValue = calculateClaimMintRequiredValue(ctx.price, ctx.amount);
            assert (in.valueCoins >= requiredClaimValue) throw ERROR_NOT_ENOUGH_FUNDS_TO_CLAIM_MINT;

            val dataHash = contract.getData().hash();
            assert (isSignatureValid(dataHash, msg.signature as slice, storage.servicePublicKey)) throw ERROR_SIGNATURE_INVALID;

            reserveMintKeeperMinimum();

            requestMintJettons(msg.queryId, storage.mintMasterAddress, ctx);

            storage.isMintClaimed = true;
            storage.save();
        }

        else => throw 0xFFFF
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    var storage = lazy MintKeeperStorage.load();
    if (in.senderAddress != storage.mintMasterAddress) {
        // Ignore spoofed bounces.
        return;
    }

    storage.isMintClaimed = false;
    storage.save();

    val ctx = lazy storage.mintContext.load();

    reserveMintKeeperMinimum();

    val refundMsg = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: ctx.ownerAddress
    });
    refundMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// ============================================================================
// Internal helpers
// ============================================================================

@inline
fun requestMintJettons(queryId: uint64, mintMasterAddress: address, context: MintContext) {
    val requestMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: mintMasterAddress,
        body: RequestMintJettons {
            queryId: queryId,
            mintContext: context,
        }
    });
    requestMsg.send(SEND_MODE_CARRY_ALL_BALANCE);
}

// ============================================================================
// Get methods
// ============================================================================

get fun get_is_mint_claimed(): bool {
    val storage = lazy MintKeeperStorage.load();
    return storage.isMintClaimed;
}

get fun get_min_storage_fee(): coins {
    return calculateMintKeeperMinStorageFee();
}

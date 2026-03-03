# Testnet script flow

This repo ships Blueprint scripts in `scripts/` for a minimal end-to-end testnet run:
publish the `JettonWallet` public library, deploy a `JettonMinter`, deploy `MintMaster`,
transfer Jetton admin to `MintMaster`, and perform a single mint claim via `MintKeeper`.

## Prerequisites

- Node.js + npm
- A testnet wallet with enough TON:
  - regular deployments are cheap,
  - publishing the public library on masterchain can require a large reserve (script tells you if it was not enough).

## Local config (do not commit)

Create a local `.env` (it is gitignored) and load it into your shell:

```bash
set -a
source .env
set +a
```

Recommended `.env` keys:

```bash
# `deployLibrary` needs access to your wallet keys to send an internal message with `bounce=false` to masterchain.
# Blueprint's `--mnemonic` deployer reads these variables from the environment (it does not prompt/set them).
WALLET_MNEMONIC="word1 word2 ... word24"
WALLET_VERSION="v5r1"   # or "v4"
SUBWALLET_NUMBER="0"    # v5r1 only (optional)
WALLET_ID="698983191"   # v4 only (optional)

# Optional: for fully non-interactive library deploy
LIBRARY_DEPLOY_VALUE_TON="10"
```

Scripts may create local key files under `.local/keys/` (gitignored). Keep them private.

## Flow

1) Publish `JettonWallet` code as a public library (masterchain):

```bash
npx blueprint run deployLibrary --testnet --mnemonic
```

If the script says “deployed but not bricked”, the library was NOT published yet. Increase `LIBRARY_DEPLOY_VALUE_TON` and rerun; funds remain on the Librarian contract and are reused.

2) Deploy `JettonMinter` (03_notcoin) referencing the library:

```bash
npx blueprint run deployJetton --testnet --mnemonic
```

Export `JETTON_MINTER_ADDRESS` from the script output (or set it in `.env`).

3) Deploy `MintMaster`:

```bash
npx blueprint run deployMinter --testnet --mnemonic
```

Export `MINT_MASTER_ADDRESS` from the script output.

4) Transfer Jetton admin to `MintMaster`:

```bash
export NEXT_ADMIN_ADDRESS="$MINT_MASTER_ADDRESS"
npx blueprint run setJettonNextAdmin --testnet --mnemonic
npx blueprint run claimJettonAdmin --testnet --mnemonic
```

5) Enable minting:

```bash
export MINT_ENABLED="true"
npx blueprint run toggleMint --testnet --mnemonic
```

6) Perform a single mint claim (deploys `MintKeeper` and calls `claim_mint`):

```bash
export MINT_PRICE="0"
export MINT_AMOUNT="1"
npx blueprint run claimMint --testnet --mnemonic
```

Optional:

```bash
npx blueprint run printMintMasterData --testnet
```

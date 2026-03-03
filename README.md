# jetton-minter-tolk

Signature-authorized, single-use jetton minting flow. A user deploys a per-claim contract (`MintKeeper`) with a service signature, then claims once. The root contract (`MintMaster`) deploys an `AgentWalletV5` for the user and mints jettons to that wallet.

Canonical TL-B scheme: `contracts/scheme.tlb`.

## Contracts

- `MintKeeper` (`contracts/mint-keeper.tolk`): per-claim verifier and forwarder (service signature + budget + one-time guard).
- `MintMaster` (`contracts/mint-master.tolk`): root mint executor (verifies expected `MintKeeper`, deploys `AgentWalletV5`, mints jettons via `JettonMinter`).
- `AgentWalletV5`: code is compiled and embedded; `StateInit.data` is constructed by `MintMaster` (`contracts/utils.tolk`).
- Jetton implementation used for integration: `contracts/03_notcoin/*` (JettonMinter/JettonWallet).

## Architecture

```
User wallet
    │ deploy MintKeeper + send claim_mint
    ▼
MintKeeper  ── verifies service signature and claim budget
    │ internal request (carry all balance)
    ▼
MintMaster  ── verifies expected MintKeeper address
   ├─ deploy AgentWalletV5 (auto-deploy)
   └─ mint jettons via JettonMinter to AgentWalletV5
```

## Processing flow

Exact schemas (storage layouts, message tags, and field names) are defined in `contracts/scheme.tlb`.

1. Off-chain, the service signs `MintKeeper` initial data hash for a specific `MintContext`.
2. The user deploys `MintKeeper` and sends the claim message with the service signature and sufficient TON.
3. `MintKeeper` enforces:
   - one-time claim guard,
   - `owner_address` must be in `BASECHAIN` and `sender == owner_address`,
   - budget check using `calculateClaimMintRequiredValue(...)` (`contracts/fees-management.tolk`),
   - service signature verification over `contract.getData().hash()`.
4. `MintKeeper` forwards the request to `MintMaster` using carry-all-balance.
5. `MintMaster` enforces:
   - minting enabled,
   - `owner_address` must be in `BASECHAIN`,
   - `sender` equals the expected `MintKeeper` address derived from `(service_public_key, mint_master_address, mint_context)`.
6. `MintMaster` deploys `AgentWalletV5` for `(owner_address, agent_public_key)`, mints jettons to it via `JettonMinter`, and forwards remaining TON to the agent wallet.

## Get methods

`MintMaster`:

- `get_mint_master_data() -> (isMintEnabled: bool, servicePublicKey: uint256, jettonMinterAddress: address, adminAddress: address)`
- `get_is_mint_enabled() -> bool`
- `get_min_storage_fee() -> coins`
- `get_claim_mint_required_value(price: coins, amount: coins) -> coins` (required TON for a new claim)

`MintKeeper`:

- `get_is_mint_claimed() -> bool`
- `get_min_storage_fee() -> coins`

## Scripts

Blueprint scripts for deployment and interaction are in `scripts/`:

- Deploy: `deployLibrary`, `deployJetton`, `deployMinter`
- Admin: `toggleMint`, `withdrawTons`, `topUpTons`, `changeJettonAdmin`, `claimJettonAdmin`
- Read-only: `printMintMasterData`
- Claim helper: `claimMint` (deploys `MintKeeper` + sends `claim_mint`)

For a minimal testnet walkthrough, see `test-flow.md`.

## Development

```bash
npm install
npx blueprint build --all
npm test
```

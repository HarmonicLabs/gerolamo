# Plan: stake pool tooling on HarmonicLabs libraries (preview testnet first)

Decision (2026-09-05): every key, certificate and transaction a pool operator
needs is produced with the HarmonicLabs libraries inside Gerolamo — no
`cardano-cli` in the product — and later exposed through the desktop
(Electrobun) UI. The first live test is a pool on the **preview** testnet
(1-day epochs, so leader schedules and rewards can be checked quickly).
`cardano-cli` from the local `cardano-node` 11 install is used only to
cross-check formats and results during development.

## 1. The operator flow (CoinCashew guide) → Gerolamo

| Guide step (cardano-cli) | Gerolamo / library | Status |
|---|---|---|
| Cold keys: `node key-gen` → `node.skey/vkey`, `node.counter` | ed25519 keypair via `@harmoniclabs/crypto` (`deriveEd25519PublicKey`); counter kept in the pool keystore; pool id = blake2b_224(cold vkey) | have: `src/pool/keystore.ts` |
| VRF keys: `node key-gen-VRF` → `vrf.skey/vkey` | `VrfProof03` keys: 32-byte seed → ed25519-style public key; vrf key hash = blake2b_256(vkey) (already what the header check uses) | have: keystore (`generateVrfKey`, hash = `key-hash-VRF`) |
| KES keys: `node key-gen-KES` → `kes.skey/vkey` | `@harmoniclabs/kes`: `keygenSum6` / `kes_keygen`, `kes_update` per period, `kes_to_pk` | have (lib) |
| KES period: `slot / slotsPerKESPeriod` (preview 129 600 slots, 62 evolutions, ~90 days) | from the local tip and `shelley-genesis.json` | have (geometry) |
| Operational certificate: `node issue-op-cert` (kes vkey, counter, start period, cold signature) | `PoolOperationalCert` (`eras/common/ledger/certs`): body = kes vkey ‖ counter ‖ period, signed by the cold key; counter must be last on-chain counter + 1 (`opcert_counters` table) | need: issue function + serialisation to the same TextEnvelope |
| Payment/stake keys and addresses | ledger-ts `Address`, `StakeAddress`, `Credential` | have |
| Stake address registration (`stake-address registration-certificate`, deposit from params) | `CertStakeRegistration` / `CertRegistrationDeposit` (Conway) with `key_deposit` from the local epoch parameters | have (lib) |
| Pool metadata JSON + hash (`stake-pool metadata-hash`) | blake2b_256 of the file bytes; `IPoolParamsMetadata { poolMetadataUrl, hash }` | have |
| Pool registration certificate (pledge, cost ≥ min_pool_cost, margin, reward account, owners, relays, metadata) | `PoolParams` + `CertPoolRegistration`; relays as `PoolRelay` (single host IPv4/DNS, multi-host) | have (lib) |
| Delegation certificate (owner → pool) | `CertStakeDelegation` | have (lib) |
| Transaction build / fee / sign / submit (have: `operator.ts` `buildWithMinFee`, `scripts/pool-register.ts`) | `buildooor` `TxBuilder` with `certificates`, inputs from the local UTxO table, protocol parameters from the local records; witnesses: payment key, stake key, cold key (`getRequiredSigners()`); submit through Gerolamo's own `POST /api/v0/tx/submit` (mempool → TxSubmission to peers) | have (pieces); need: a local UTxO/params provider for the builder |
| Verify registration (`query stake-snapshot`) | local `pool_params`, `epoch_pool_stake` (mark/set/go = taken_at e, e−1, e−2) | have |
| Leader schedule (`query leadership-schedule --current/--next`) | `rules/leaderMath.isSlotLeader` with our σ from `epoch_pool_stake`, η0 from `epoch_nonces` (next epoch known once the candidate freezes) and `VrfProof03.generate` on `praosVrfInput(slot, η0)` | have: `src/pool/leaderSchedule.ts`, `scripts/leader-schedule.ts` (compare with `cardano-cli query leadership-schedule` pending a preview cardano-node) |
| KES rotation every ≤ 62 periods (`issue-op-cert` with counter+1, restart) | `kes_update` in-process; new opcert from the keystore without restart | need (block plan §7) |
| Topology: producer talks only to its own relays; relays list the producer as trustable local root | Gerolamo `role: producer` (new) + relay topology; duplex fix and silent-primary watchdog from block plan §6 | need |

## 1b. Done 2026-09-05: `src/pool/operator.ts` + `scripts/pool-register.ts`

Keys (payment/stake), base and stake addresses (bech32), stake registration
(Conway `reg_cert` with deposit), pool registration (relays, margin as
tag-30 rational, owners as tag-258 set, metadata hash) and delegation
certificates, and a signed Conway transaction (inputs/certs as tag-258 sets,
legacy `[address, coin]` outputs, min fee a·size + b iterated on the signed
size, vkey witnesses ordered by key hash). Every certificate, the transaction
body, the txid and the whole signed transaction are byte-identical to
`cardano-cli conway` 11 fixtures (`src/pool/__fixtures__/cli-tx`).
`scripts/pool-register.ts keygen | opcert | register --node http://localhost:3035
[--submit]` reads UTxOs and parameters from the node's MiniBF API and submits
through `POST /txsubmit`. Verified against the live preview node (unfunded
address → funding message; opcert issued for the tip's KES period).

## 2. Preview testnet plan

1. Add `src/config/preview/` (genesis files from `cardano-node/share/preview`, magic 2, Shelley from epoch 0, 86 400-slot epochs, k = 432). Sync preview from genesis with full validation and run the Koios comparisons (`--network preview`) — the same proof as preprod, but a whole epoch takes a day instead of five.
2. Fund a payment address from the preview faucet; build and submit with Gerolamo: stake registration, pool registration (pledge, cost, margin, relay = the Gerolamo relay), owner delegation. Cross-check the transaction bytes against `cardano-cli conway transaction build-raw` output for the same inputs once, then rely on the node's own validation (it applies its own transaction through the strict rules).
3. Wait two boundaries: verify our pool in `epoch_pool_stake` (set → go) and on Koios preview.
4. Leader schedule: compute ours for the coming epoch, compare with `cardano-cli conway query leadership-schedule --next` from the local cardano-node on preview.
5. Forge: block assembly (block plan §3), self-adoption, publication; confirm on Koios preview that the block is ours; compare rewards at the boundary.
6. KES rotation and opcert reissue while running; restart safety (last forged slot persisted).

## 3. Desktop UI (later)

Wizard: create keys (cold offline, KES/VRF on the producer) → register stake
address → register pool (metadata upload, relay list) → delegate pledge →
status page (registration, stake per epoch, leader schedule, blocks forged,
KES periods left, rotate button). Everything runs through the same
library code paths as the CLI-less node.

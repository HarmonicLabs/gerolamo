# Snapshot bootstrap and the extractor (design, 2026-09-07)

Direction agreed with Mike on 2026-09-07: Gerolamo keeps two ways to reach the tip, and both
stay first-class.

1. **Genesis replay (proof mode).** Every block and every epoch boundary validated by our own
   rules from slot 0, with the Mithril-certified block store as input. This is how the rules are
   proved (bugs 72–85 were all found this way) and it stays available forever, as a scheduled
   proof and for development. Nothing about it is redundant: it verifies *our* code, which a
   snapshot import cannot.
2. **Snapshot bootstrap (production mode).** Download the Mithril `cardano-database` artifact,
   verify it, decode the node's ledger state at the snapshot slot into our tables, then validate
   and record forward from that slot exactly as today — every new block through the full rules,
   every boundary through our reward, snapshot and governance code. Start-up in minutes.

Beside the ledger, a **parse-only extractor** fills the explorer / mini-Blockfrost database from
the immutable chunks (no rules), so the API does not depend on the ledger's sync state.

## What the artifact contains and what is certified

- `immutable/` chunks: the chain up to the certificate's beacon. Certified by the STM
  multi-signature (what `mithril-bootstrap` verifies today, chain ≈ 1 400 certificates).
- `ledger/<slot>/` ledger state at the last immutable slot, plus the last immutable file: the
  **ancillary** set. Per the Mithril manual these "can't be currently signed by the Mithril
  protocol"; they carry a single Ed25519 signature checked against the network's published
  `ANCILLARY_VERIFICATION_KEY` (the aggregator operator's key), not the SPO multi-signature.
  cardano-node and Amaru accept it. Verification: certificate chain for the immutables (SPO
  multi-signature, what `mithril-bootstrap` checks today) + the ancillary signature. Both are
  required; refuse a snapshot where either fails.
- With UTxO-HD (node ≥ 10.x) the UTxO set is **not** in `state`: it is in
  `ledger/<slot>/tables/` (in-memory backend dump, or LMDB). `scripts/lmdb-ffi.ts` already
  prototypes LMDB reading; the in-memory dump is plain CBOR.

## The importer: `NewEpochState` → our tables

Reference layouts: cardano-ledger's `ToCBOR` instances (spec), Dingo `ledgerstate/import.go`
(Go, tonight's reading), Amaru's `amaru-ledger` snapshot import (Rust). Versioned by node
release: the decoder carries the node version it was written against and refuses unknown
encodings loudly.

| Node state | Our tables |
| --- | --- |
| `nesEL` epoch, `nesBprev` / `nesBcur` blocks made | `blocks_made_by_epoch` (two epochs) |
| `esAccountState` treasury, reserves | `reward_pots`, `pot_snapshots` |
| `esSnapshots` mark / set / go (stake, delegations, pool params) + fee | `epoch_stake_cred`, `epoch_pool_stake`, `epoch_stake_totals`, `epoch_pool_params` for three `taken_at` values |
| `esNonMyopic` | `non_myopic` (likelihoods) |
| `nesPd` pool distribution | derived from the mark snapshot; cross-check |
| `nesRu` pulsing reward update | **not imported**: recomputed by our reward code from the go snapshot and `nesBprev` at the next boundary (the certified formula) |
| `lsUTxOState.utxo` (tables) | `utxo` with the indexed side columns (`stake_key` typed, address, lovelace, reference script) |
| `lsUTxOState` deposited, fees, donation | `reward_pots.fee_pot`, deposit pot |
| `lsCertState.DState` unified map: rewards, deposits, pointers, delegations | `rewards` (typed credential bytes), `stake` (registrations, deposit), `stake_pointers`, `delegations`; MIR accumulators → `mir_pending` |
| `lsCertState.PState` pools, future pools, retiring, deposits | `pool_params`, `pool_params_pending`, retirements |
| `lsCertState.VState` DReps, committee hot keys, dormant epochs | `gov_dreps`, `gov_committee_auth`, `gov_state.dormant_epochs` |
| Conway `GovState`: pparams cur/prev/future, proposals, committee, constitution, DRep pulser | `epoch_params` (current + next), `gov_proposals` (with `ratified`/pending semantics: the pulser's snapshot becomes `gov_state.pending`), `gov_committee`, `gov_state` |
| Header state (`ChainDepState`): nonces (evolving, candidate, epoch, lab), op-cert counters | `epoch_nonces`, `opcert_counters` |
| `stashedAVVMAddresses` | `stashed_avvm_addresses` (mainnet only) |

Every imported table gets the same invariants the replay checks (bug 6a pool-snapshot
diagnostic, typed credentials everywhere, pots balance) run once after import, and the
`/metrics` `ledgerComplete` flag is set from the import, not from a genesis sync.

Mid-epoch state: the snapshot slot is not a boundary. Import as-is; the in-flight reward update
is recomputed from the imported snapshots at the next boundary; the DRep pulser's snapshot is
stored as our pending ratification (bugs 81/82 semantics). The first boundary after the import is
verified against Koios as an acceptance test.

## The ledger store (agreed 2026-09-07 evening)

Validation needs the state, not SQLite. Three backends behind one interface, chosen by mode:

- **LMDB** (production, mainnet-scale): memory-mapped, reads at page-cache speed (sub-µs plus
  ≈ 0.3 µs of Bun FFI, against 5–20 µs per SQLite statement — a quarter of the applier at
  dense epochs), durable by construction, larger than RAM still works. The same design choice as
  cardano-node's UTxO-HD. If the store uses the node's own key/value layout (TxIn → TxOut
  CBOR), the Mithril snapshot's LMDB tables are our UTxO set as-is: bootstrap = open the file.
  `scripts/lmdb-ffi.ts` is the reader prototype.
- **In-memory maps** (proof replays, testnets): fastest; the small hot sets (pool and epoch
  parameters, the block's delegations) stay in memory in every mode.
- **SQLite** stays for the explorer / mini-Blockfrost database, the history tables the
  verification scripts read, and diagnostics — never again on the block-application path.

Forks and rollbacks: LMDB gives per-block atomicity, not undo. Split the state at the
immutable point like the node: LMDB holds the state as of k (2 160) blocks behind the tip and
only advances when a block becomes immutable; the last k blocks are an ordered list of
in-memory diffs (created / consumed outputs, certificate and balance changes) layered over it.
A fork of depth d drops d diffs and applies the other branch — no disk writes, no journal
replay, no spent-row restore. Diff volume: tens of MB on preview, a few hundred on mainnet.
Proof replays have no forks and flush diffs straight through. Measure LMDB against the
in-memory store on the same replay before committing the production default.

## The extractor

`extract` reads the immutable chunks (the same reader as `mithril-bootstrap --blocks-only`) and
writes the explorer database: blocks, transactions, inputs/outputs, address index, metadata —
parse only, no ledger rules, partitioned by chunk so it runs on all cores and resumes by chunk.
Spent marks are computed from the same stream. After the extractor the explorer worker takes
over at the tip as today. Estimated throughput ≥ 5 000 blocks/s (pure CBOR, no UTxO lookups).

## Order of work

1. Finish the third genesis replay (running): it certifies the reward code the importer relies
   on for the pulser recomputation.
2. Extractor (small; immediately useful; reuses the chunk reader and `explorer-backfill`).
3. UTxO table reader (in-memory dump first, LMDB via the existing FFI prototype) → `utxo`.
4. `NewEpochState` decoder for the rest of the table above, node-version pinned.
5. Ancillary signature verification in `mithril-bootstrap`; `--ledger-state` mode.
6. Acceptance: import at slot S, sync to tip, compare the next two boundaries with Koios
   (pots, stake, rewards, enactments) and with a genesis-replay database at the same slots.

## Implementation phases (started 2026-09-09, after replay 6 proved the ledger exact)

- **A. Extractor** — `gerolamo extract --immutable-dir … --explorer …` (`src/mithril/extract.ts`,
  `extractWorker.ts`, `extractDelta.ts`). Worker pool decodes chunks in any order (`parseChunk`
  + `MultiEraBlock.fromCbor` + `buildUtxoRowForOutput`), one writer thread applies `applyMbTx`
  in a transaction per chunk, `mb_extract_chunks` marks each chunk for resume, and a finalize
  pass completes spent marks and the input side of the address index with set-based SQL over
  `mb_tx_in ⋈ mb_tx_out ⋈ mb_tx` (so the decode order never matters). Byron payloads follow the
  applier's shapes; phase-2-invalid transactions are skipped like the applier. DONE 2026-09-09:
  41 Byron chunks in 0.7 s, 25 Conway chunks (3 496 blocks, 2 896 txs) in 2.2 s at 1 700
  blocks/s with 8 workers; cross-checked against the replay-6 ledger: 133/133 sampled spent marks found in its delta log, 97/97 sampled unspent outputs equal in address, lovelace and reference script in its `utxo` table;
  tests in `extractDelta.test.ts`. Full preview run and throughput tuning next.
- **B. UTxO import** — `gerolamo import-utxo --tables ledger/<slot>/tables --db <target>`
  (`src/mithril/importUtxo.ts`). Streams the `utxohd-mem` file (3.17 M entries on preview e1415,
  620 MB) through the MemPack codec (`src/state/utxohdMemCodec.ts`, all six TxOut tags), rebuilds
  each output's Babbage wire CBOR and hands it to the applier's own parser and row builder, so
  rows are what the applier writes; the `stake_balance` triggers fill the balances. DONE
  2026-09-09: 3 167 873 rows in 250 s, verified row by row against the replay-6 ledger
  reconstructed at the snapshot slot 122 316 253 (`scripts/verify-utxo-import.ts`, tip minus
  the 604 later blocks' deltas): set identical, 3 167 845 rows byte-identical; the 28 others are
  collateral-return outputs, where only the applier's `collateral_return` flag and its empty
  `assets` object differ (the snapshot cannot carry that flag). One codec fix on the way: the
  tag-3 DataHash32 is four host-endian words like Addr28Extra (988 outputs). LMDB tables:
  not needed for the aggregator's snapshots (backend `utxohd-mem`); keep the FFI reader for
  node-produced LMDB snapshots.
- **C. `NewEpochState` decoder + importer** — `gerolamo import-state --state ledger/<slot>/state
  --db <target> [--meta …]` (`src/mithril/nesDecoder.ts`: typed navigation of the
  `ExtLedgerState` with a shape assertion per section, pinned to cardano-node 11.0.x;
  `src/mithril/importState.ts`: the table in "The importer" above, one transaction; verifier
  `scripts/verify-state-import.ts`). DONE 2026-09-09: preview epoch 1415 (slot 122 316 253)
  decoded in 2.3 s and imported in 2 s; against the replay-6 ledger every boundary-frozen table is
  exact — rewards 80 351/80 351, registrations 110 994, delegations 80 387, the three stake
  snapshots (239 213 credential rows, all values), pool parameters at the three snapshots, blocks
  made 1414, pots, pot snapshot, epoch parameters 1414/1415 (54 keys), epoch and candidate nonces,
  op-cert counters, DReps, committee, governance state and roots, live proposals and votes,
  genesis delegations. Facts learned on the way: the pulser is always serialised in its
  completed form (ratification result + DRep/pool distributions, which we import as
  `gov_state.pending` and `epoch_drep_stake`); the node's fee pot still holds the previous epoch's
  fees until that reward update is applied (`fee_pot = utxosFees − snapshot fee`); the Praos
  state has eight fields (the sixth is the previous epoch's nonce); the snapshot pool records
  carry the delegated owners only and reduced margins (reward-equivalent); the DRep expiry is
  stored, not derived (bug 102), and DRep unregistration clears the delegations to it (bug 101) —
  both found by this comparison and fixed in the ledger code. The evolver resumes from the
  imported ηv/ηc/ηh at the snapshot slot (`epoch_nonces.start_slot`). Not imported: the pulsing
  reward update (recomputed at the next boundary), non-myopic likelihoods, stashed AVVM
  addresses (refused; mainnet needs it before the Shelley start only).
- **D. Bootstrap mode** — `mithril-bootstrap --ledger-state` (implies `--blocks-only
  --include-ancillary`): after the certified chunks are stored it verifies the ancillary set —
  `ancillary_manifest.json` lists the SHA-256 of the last immutable file's three parts and of
  `ledger/<slot>/{meta,state,tables}`, and carries the aggregator's Ed25519 signature over
  SHA-256(path‖hash, entries in path order) (mithril `AncillaryFilesManifest::compute_hash`, the
  signer signs that digest directly); the key is the published `ancillary.vkey` per network
  (hex-of-JSON byte array like the genesis key; preview and preprod share one, mainnet has its
  own; built into `src/mithril/ancillaryManifest.ts`, override with `--ancillary-vkey`). A failed
  hash or signature aborts the bootstrap. Then `import-utxo` and `import-state` run on the same
  database. DONE 2026-09-09: the preview manifest of snapshot d2bd116c… verifies with the
  published key (test `ancillaryManifest.test.ts`, which also checks that mainnet's key and a
  changed hash fail).
- **E. Acceptance** — import at slot S, sync to the tip, the next two boundaries against Koios
  and against the replay-6 database (`gerolamo-preview-mithril/preview.db`). STARTED 2026-09-09
  23:03 UTC: `mithril-bootstrap --network preview --skip-download --digest d2bd116c… --ledger-state
  --from-chunk 28150 --db gerolamo-preview-mithril2/preview.db` (certificate chain 47 s, 164 chunks
  = 24 784 blocks in 8 s, manifest 6 files + signature OK, UTxO 3 167 873 rows in 7 min, state
  in 5 s; the block store is trimmed to the state's slot — the last chunk carries 8 blocks the
  state does not include — and renumbered to the chain heights). Node 3036 on it reached the
  live tip (122 339 067) 30 s after launch, strict, `ledgerComplete`; the only warnings are the
  known Plutus-shadow budget family (open item 11, present on the tip node too). First 1416
  boundary (2026-09-10 00:00 UTC): the reward update for epoch 1414 was lovelace-identical to the
  tip node's (pot 17 076 639 048 375, treasury +3 415 327 883 774, 420 835 771 534 to 5 958
  accounts), but the 1416 stake snapshot came out at 2 901 T instead of 1 543 T: the database had
  been through `import-utxo` twice (the first bootstrap attempt, before the block-store trim),
  and `INSERT OR REPLACE` over existing rows fires the `stake_balance` insert trigger without the
  delete one, doubling every balance. Fix: the importer rebuilds `stake_balance` from `utxo` at
  the end (idempotent). Database rebuilt from scratch and the node relaunched to redo 1416.
  Rebuilt node at 1416 (00:20 UTC): every table equal to the tip node's after both applied the
  boundary — rewards 80 353/80 353, the 1414/1415/1416 snapshots, pots, pot snapshot, parameters,
  nonces, DRep stake 2 904/2 904, governance state and proposals; `stake_balance` identical
  (3 902 280 214 551 718). The two differences were both on the replay side: bug 104 (phantom
  blocks after rollbacks) and the 13 zero-stake snapshot rows (both fixed). Boundary 1417 (applied 2026-09-11
  02:33 UTC, after an internet outage): the reward update for epoch 1415 — the one whose blocks
  the imported node counted partly from `nesBcur` and partly itself — is lovelace-identical on
  both nodes (pot 16 972 576 264 511, treasury +3 394 515 252 902, 418 938 148 444 to 6 019
  accounts), the 1417 stake snapshot identical (1 545 727 609 211 407, our pool's
  1 009 501 687 663 included), pots at 1417 equal to Koios to the lovelace (reserves
  7 607 278 908 197 930, treasury 7 095 916 826 110 957), parameters, nonces, DRep stake and
  governance identical. **Phase E passed: snapshot bootstrap is production-ready on preview.**
  Side finding: the bug-104 journaling had missed the leader-count writes (24 phantom blocks in
  1416 on both nodes); fixed and recounted before the 1418 reward update uses them.
- **F. Ledger store** — LMDB with the node's TxIn → TxOut layout + in-memory volatile diffs.

The preview ancillary artifact download started 2026-09-09 20:40 UTC
(`mithril-preview/ancillary-download.log`, progress in `progress-ancillary.json`).

## Open questions

- Which node version's encoding to target first (preview aggregator snapshots come from a
  specific node release; check the artifact's `cardano_node_version`).
- LMDB vs in-memory UTxO backend in the aggregator's snapshots.
- Whether to keep a mode that imports the state *and* replays the last N epochs through our
  rules as a cheap partial proof (state at boundary E−N from the snapshot's own history is not
  available, so this needs the pulser-free boundary import above).

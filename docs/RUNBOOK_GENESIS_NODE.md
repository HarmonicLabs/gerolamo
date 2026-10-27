# Runbook — node 3037: preview from genesis on the LMDB ledger (2026-10-02)

Target: a preview data node whose LMDB ledger store is built from the genesis files and synced
block by block from slot 0 (bug 304), with no SQLite ledger at all (`--no-ledger-sql-writes`),
then proven identical to the network at its tip: 64/64 LocalStateQuery answers byte-identical with
the cardano-node relay, and a key-by-key store comparison with node 3036 (Mithril-imported).
Only after that is the store declared exact (`--genesis-exact`, see §6).

What was proven before this run (docs/VALIDATION_STATUS.md, bugs 304–305 and 316–327): preprod's
Byron era and its first four Shelley-based epochs through the node's apply path from an empty LMDB
store; preview epochs 0–99 from genesis through the local chain server with ~20 restarts, every
boundary of 0–98 identical to Koios (pots, nonces, parameters, active stake, per-pool stake and
blocks, rewards, per-account rewards). Requires the bug-327 fix (nonce evolver bootstrap race on
restart) — do not run this with an older build under a restarting supervisor.

## 1. Data directory

```
D=/media/bakon/data/cardano/gerolamo-preview-genesis3037
mkdir -p $D/logs
```

Layout once running (cardano-node style, nothing shared with 3035 / 3036):

```
$D/config.json            instance overlay (below)
$D/topology.json          phase A: local chain server only; phase B: network peers
$D/preview.db             SQLite: schema, header records, explorer bookkeeping (no ledger tables written)
$D/preview.explorer.db    mini-Blockfrost projection (paused while far behind: skipIndexWhileBehind)
$D/db/immutable|volatile  block store (chunk format), db/gerolamo/{hash-index.bin,selected-tip.hex}
$D/ledger/                LMDB ledger store (data.mdb, lock.mdb, diffs/) — meta ledger_source = "genesis"
$D/hfc-eras.json          hard-fork history
$D/node.socket            node-to-client socket
$D/logs/                  supervisor + node logs, failed-block dumps
```

## 2. config.json

```json
{
 "role": "data",
 "syncFromTip": false, "syncFromGenesis": true, "syncFromPoint": false,
 "topologyFile": "/media/bakon/data/cardano/gerolamo-preview-genesis3037/topology.json",
 "logs": { "logToFile": false, "logToConsole": true, "logLevel": "INFO" },
 "n2n": { "enabled": false },
 "sync": { "quorum": 1, "maliciousHoldMs": 3600000, "skipIndexWhileBehind": true },
 "peerGovernor": { "targetHot": 1, "maxHot": 1, "targetWarm": 1, "maxWarm": 2, "targetCold": 1 },
 "validation": { "workers": 6 },
 "relayStore": "chunks",
 "blockStoreMode": "primary",
 "ledgerStore": "lmdb",
 "n2cSocketPath": "/media/bakon/data/cardano/gerolamo-preview-genesis3037/node.socket"
}
```

The base config (`src/config/preview/config.json`) supplies the genesis files and hashes
(`byronGenesisHash`, `shelleyGenesisHash` — the latter is the initial nonce; the repository's preview
Shelley genesis file hashes to it). The hard-fork triggers come from the built-in preview overrides
(`Test{Shelley,Allegra,Mary,Alonzo}HardForkAtEpoch: 0`): the genesis state is built in Alonzo.

Node flags (the supervisor passes the first four itself; the others go after `--`, or in config.json
as `"ledgerSqlWrites": false` and `"ledgerKeepEpochs": 100000`):

```
--network preview --port 3037
--db-path $D/preview.db --config $D/config.json
--no-ledger-sql-writes             # no SQLite ledger (lmdb mode only)
--ledger-keep-epochs 100000        # keep every epoch's reward / snapshot reports for the Koios check (default 30)
# no --genesis-exact until §6 passes
```

## 3. Phase A — history from the local chain server

Serve 3036's chunk store read-only (it never writes into it; it uses 3036's `hash-index.bin` and
serves the chain as of its start, the immutable tip plus the volatile blocks then):

```
cd <repo>
nice -n 10 bun scripts/serve-chain.ts \
  --block-store /media/bakon/data/cardano/gerolamo-preview-mithril2/db --network preview --port 3147 \
  >> $D/logs/serve-chain.log 2>&1 &
```

(Or copy chunks `00000…NNNNN` into a scratch `<dir>/immutable`, create `<dir>/volatile`, and serve
that with `--index`, which builds the copy's hash index; this is what the proving run used.)

`$D/topology.json` for phase A:

```json
{
  "localRoots": [ { "accessPoints": [ { "address": "127.0.0.1", "port": 3147 } ], "advertise": false, "valency": 1, "trustable": true } ],
  "bootstrapPeers": [], "publicRoots": [], "useLedgerAfterSlot": -1
}
```

Start under the supervisor with a low RSS cap — 4 GB. Throughput decays as the process ages
(the proving run: 105–117 blocks/s right after a start, 29–30 blocks/s at 5 GB RSS a few epochs
later, the main thread then ~85 % busy with GC); a restart costs seconds (the store resumes from
its anchor and diffs), so frequent supervisor restarts are the cheap remedy:

```
cd <repo> && nohup nice -n 10 scripts/run-supervised.sh preview 3037 $D 4 \
  -- --no-ledger-sql-writes --ledger-keep-epochs 100000 >> $D/logs/supervisor.out 2>&1 &
```

First lines to see: `Block store is PRIMARY and empty: syncing from genesis`, then
`ledger store …/ledger (lmdb): built the preview genesis state — start era 4, 1 UTxO(s) holding
30000000000000000 lovelace, reserves 15000000000000000, first block's parent none`, then
`Epoch 0 begins …`, `Epoch 1: reward update for epoch -1 applied — pot 45000000000000 … treasury
+9000000000000`. Never `ledger store: … broken`, never `pool-ranking likelihoods not advanced`.

Throughput measured in the proving run (preview, 4 validation workers, nice 10, 2026-10-02): see
VALIDATION_STATUS bug 304 (blocks/s per epoch range, RSS). Preview has ~6.2 M blocks: expect a day
or more; the supervisor restarts on RSS and the node resumes from its anchor (verified).

Progress checks while it runs (read-only, safe beside the node):

```
bun scripts/ledger-koios-check.ts $D/ledger --network preview --from 1 --to <last complete epoch> --pools 10 --accounts 10
```

(pots, nonce, parameters, active stake, per-pool stake / blocks / reward totals, per-account rewards
per epoch against Koios; ~4 requests/s; run it per range of ~50 epochs.)

## 4. Phase B — to the tip from the network

When the node reaches the server's tip (the log shows it waiting at slot ≈ 3036's immutable tip at
server start), stop it (supervisor first, then the node by pid: the bun process whose command line has
`start-gerolamo … --port 3037`), stop serve-chain by its pid, and switch the topology to the network:

```json
{
  "localRoots": [ { "accessPoints": [ { "address": "127.0.0.1", "port": 6424 } ], "advertise": false, "valency": 1, "trustable": true } ],
  "bootstrapPeers": [ { "address": "preview-node.play.dev.cardano.org", "port": 3001 } ],
  "publicRoots": [ { "accessPoints": [
      { "address": "preview1-node.play.dev.cardano.org", "port": 3001 },
      { "address": "preview2-node.play.dev.cardano.org", "port": 3001 },
      { "address": "preview3-node.play.dev.cardano.org", "port": 3001 } ], "advertise": false, "valency": 3 } ],
  "useLedgerAfterSlot": 116812831
}
```

(127.0.0.1:6424 = the cardano-node 11.0.1 relay's N2N port, used as a read-only upstream peer;
3001 is the producer's.) In config.json set
`"sync": { "quorum": 2, … }` and `"peerGovernor": { "targetHot": 3, "maxHot": 4 }`, restart the
supervisor. The node resumes from its anchor (diffs reach it) and follows the network to the tip.

## 5. Acceptance at the tip (all read-only)

1. Node-to-client parity with the relay (expect 64/64 identical):
   ```
   bun scripts/n2c-compare.ts --ours $D/node.socket \
     --ref /media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket --magic 2
   ```
2. Store comparison with node 3036 (Mithril import) at their newest common block:
   ```
   bun scripts/store-compare.ts /media/bakon/data/cardano/gerolamo-preview-mithril2/ledger $D/ledger \
     --names 3036,3037 --placeholders --json $D/logs/store-compare-3036.json
   ```
   store-compare compares row forms canonically (the UTxO value-map / collateral-return forms,
   reduced pool margins, JSON key order, committee credentials typed vs bare, a zero DRep stake vs
   none: bugs 353–355). With `--placeholders` it also ignores the build metadata (pots `init_epoch`,
   governance `seededEpoch`, the pulser snapshot's `source`, past epochs' nonce resume checkpoints)
   and counts as "history only one store can hold" — not as differences — what only the store whose
   history starts earlier holds: decided governance actions with their votes and anchors
   (`gov_proposals`, `gov_votes`, `gov_constitution_anchor`), `pointer` (every registration pointer
   since epoch 0; neither store deletes pointers on deregistration, Conway resolves none),
   `pool_relays` (3036 only holds relays of pools registered after its import), and epoch-keyed rows
   before the later history start (`gov_enacted`, `pparam_props`). `meta` is informational
   (`ledger_source`, the genesis record). Everything else must be `ok`.

   Expected on 3036 and the producer until repaired (3036 / producer wrong, 3037 right — the relay and
   Koios decide; VALIDATION_STATUS bugs 350–356, 2026-10-04 at slot 124 493 197):
   - `utxo` / `utxo_addr` / `utxo_stats`: 4 phantoms only in 3036 — the Byron genesis output
     4843cf2e…#0 (bug 350) and d6dcaa35…#3, #5, dc1d31e2…#4 (bug 351) — and 54ca4d49…#0 with the
     lovelace column 1 below its `amount` (bug 352). Repair, node stopped:
     `bun scripts/store-repair-phantoms.ts <ledger> --socket <relay socket> --magic 2 --yes`
     (the dry run without `--yes` is read-only and lists exactly these five).
   - `drep_stake` epochs 1424 and 1435: DRep b25d7204… 1 000 ADA low in 3036's rows (computed before
     bug 155's fix; Koios `drep_voting_power_history` = 3037). History rows; not repaired.
   Anything else in `utxo*`, `stake*`, `deleg`, `reward`, `pool`, `pool_cbor`, `snap_*` (in window),
   `pots`, `pot_snap`, `pending_rew`, `gov_*`, `drep_stake`, `epoch_params`, `nonces`, `opcert`
   (counter) is a finding. To check a store against the relay alone (no second store):
   `bun scripts/store-repair-phantoms.ts $D/ledger --socket <relay socket> --magic 2` (≈ 4 min on
   preview; 3037 at 2026-10-04: 0 phantoms, 0 lovelace differences).
   The producer's store (a copy of 3036's from 2026-10-01) compares exactly like 3036.
3. Koios over the whole history: `bun scripts/ledger-koios-check.ts $D/ledger --network preview --from 1 --to <tip epoch − 1> --pools 10 --accounts 10 --bulk`;
   every `DIFF` line is a finding (`note pool-rew` lines are db-sync's paid-vs-computed split,
   informational; `skip` = Koios has no row yet, e.g. the last epoch's pool history). Without
   `--bulk` it makes 14 requests per epoch and the public tier's daily quota (≈ 5 000 requests,
   then HTTP 429 for the rest of the day) stops it after ≈ 350 epochs; `--bulk` fetches each history
   once (≈ a few hundred requests for the whole of preview) and waits out a 429 "Exceeded Tier
   Limit" (a rolling 24 h window). 3037, 2026-10-05: epochs 1–1439, 0 differences.

## 6. Exactness

A store built from genesis records `ledger_source = "genesis"`; the balance-dependent rules
(bugs 272–277: withdrawal amounts, `current_treasury_value`, zero-balance deregistration, σ leader
threshold) stay report-only on it. When §5.1–5.3 pass, add `"genesisExact": true` to
`$D/config.json` (or `--genesis-exact` after the supervisor's `--`) and restart: `ledgerStateExact()` then reports the store exact and those rules
become strict, as on a snapshot import. Remove it again if a later check finds a difference.

## 7. Undo

Stop the supervisor and the node by pid; `rm -rf $D` removes everything (no other node reads it).

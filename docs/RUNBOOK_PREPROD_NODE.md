# Runbook — a Gerolamo preprod node on a fresh machine (2026-09-21)

Target: a preprod data node in block-store + LMDB mode, bootstrapped from a Mithril snapshot,
kept alive by the supervisor, verified against the network — then, once it has passed an epoch
boundary, promoted to a block producer with the existing preprod pool keys. Preview keeps running
on the laptop as the fast-feedback net (its epochs are a day; preprod's are five).

## 0. Machine

- Linux x86_64, 8+ cores, 32 GB RAM (a full validating sync uses ~4–6 GB RSS; the supervisor
  restarts the node above `max_rss_gb`), NVMe with ≥ 150 GB free for preprod (chunks ~45 GB,
  LMDB ~5 GB, SQLite projection ~10 GB, snapshots ~40 GB during bootstrap).
- Packages: `liblmdb0` (the FFI binding loads the system liblmdb), `git`, `curl`, optionally
  `cardano-cli` for node-to-client checks. Bun ≥ 1.4 (`curl -fsSL https://bun.sh/install | bash`).
- Open inbound TCP for the node-to-node port you choose (3001 below) if the node will be a
  producer's relay or serve peers; outbound only is enough for a data node.

## 1. Repository

```
git clone <repo> gerolamo && cd gerolamo
bun install                      # vendor/*.tgz are pinned; no network fetch of HarmonicLabs packages
bunx tsc --noEmit -p tsconfig.json && bun test src/ledger src/storage   # sanity
```

## 2. Node directory and config

```
D=/srv/cardano/gerolamo-preprod; mkdir -p $D/logs
```

`$D/config.json` (data node; producer fields come later):

```json
{
  "role": "relay",
  "syncFromTip": false, "syncFromGenesis": true, "syncFromPoint": false,
  "topologyFile": "/srv/cardano/gerolamo-preprod/topology.json",
  "logs": { "logToFile": false, "logToConsole": true, "logLevel": "INFO" },
  "n2n": { "enabled": true, "host": "0.0.0.0", "port": 3001 },
  "sync": { "quorum": 2, "maliciousHoldMs": 3600000, "skipIndexWhileBehind": true },
  "peerGovernor": { "targetHot": 3, "maxHot": 4, "targetWarm": 24, "maxWarm": 28, "targetCold": 128, "maxCold": 256 },
  "n2cSocketPath": "/srv/cardano/gerolamo-preprod/node.socket",
  "blockStoreMode": "primary",
  "relayStore": "chunks",
  "ledgerStore": "dual"
}
```

`$D/topology.json`: `bootstrapPeers` `preprod-node.play.dev.cardano.org:3001`, `publicRoots`
`preprod1-node.play.dev.cardano.org:3001` … `preprod3-…`; add a `localRoots` entry for a local
cardano-node if one runs on the box (it is used as an always-on verifier and light-query source).

## 3. Bootstrap from Mithril (chunks + ledger state)

```
bun src/index.ts mithril-bootstrap --network preprod --db $D/preprod.db --download-dir $D/snapshots \
  --block-store $D/db --ledger-state --ledger $D/ledger --include-ancillary --download-concurrency 8
```

What it does: verifies the certificate chain from the genesis verification key, downloads and
digest-checks every immutable chunk (never delete a downloaded chunk directory — a rerun with
`--skip-download` reuses it), puts the chunk files in place as the block store, trims them to the
snapshot's ledger slot and pins the selected tip, then imports the UTxO set and the
NewEpochState **straight into the LMDB store** (`--ledger`), anchored at the snapshot's block.
Expect 30–60 min on a good link. No SQLite ledger tables are created; use
`"ledgerStore": "lmdb"` and `"ledgerSqlWrites": false` in config.json (or launch the supervisor
with `-- --no-ledger-sql-writes`, step 4) so they never are. Without `--ledger` the importer
writes SQLite as before and a `dual`-mode node seeds its store from it at first start.

## 4. Run under the supervisor

```
setsid bash scripts/run-supervised.sh preprod 3040 $D 14 preprod.log -- --no-ledger-sql-writes > /dev/null 2>&1 < /dev/null &
```

The supervisor relaunches the node on exit and restarts it above 14 GB RSS. It passes
`--network preprod --port 3040 --db-path $D/preprod.db --config $D/config.json` itself; node flags
go after `--` (docs/CONFIG.md). The first start logs
`ledger store … (lmdb): anchor slot <snapshot slot>, 0 volatile diff(s)`, then `Block store is
PRIMARY`, then ranges; the node should reach the network tip within minutes (the snapshot is at
most a few hours old). (A `dual`-mode node seeded from SQLite logs `seeded … rows from SQLite` first.)

Stop a node by pid only (never `pkill bun`): find it by its command line
(`start-gerolamo … --port 3040`, e.g. `pgrep -af 'start-gerolamo.*--port 3040'`), `kill <pid>`; the supervisor relaunches it. Stop the supervisor first
(its cmdline is `bash scripts/run-supervised.sh preprod 3040 …`) when you want it down.

## 5. Verify

- `curl localhost:3040/health`, `/metrics` (`tipSlot`, `sync.halted`, `ledgerStore` with mode,
  anchor slot, volatile diffs = k once warm, dual-run counters), `/stats` in a browser.
- `bun scripts/ledger-compare.ts $D` — every ledger table SQLite vs LMDB (small skews on a live
  node are read timing; the in-process dual verifier is exact and halts on a real difference).
- `cardano-cli conway query tip --socket-path $D/node.socket --testnet-magic 1`.
- Watch one epoch boundary (preprod: every 5 days at 00:00 UTC) in dual mode: `Epoch N begins`,
  `reward update for epoch N−2 applied`, `ledger dual-run … 0 difference(s)`.

## 6. Cut over to LMDB

After a clean boundary: set `"ledgerStore": "lmdb"`, restart the node (diffs reload in
< 1 s, no reseed). After a day, set `"ledgerSqlWrites": false` in config.json (or relaunch the
supervisor with `-- --no-ledger-sql-writes`) to stop the SQLite ledger writes; the SQLite file then holds only the frozen
tables and the mini-Blockfrost projection.

## 7. Producer

1. Keys: cold verification key, KES signing key, VRF signing key, operational certificate for the
   preprod pool (never copy the cold signing key onto the server). Put them under `$D/keys` with
   mode 600.
2. Add to `config.json`: `"role": "producer"`, `"producer": { "coldVkeyFile", "kesSkeyFile",
   "vrfSkeyFile", "opcertFile", "stateFile": "$D/producer-state.json", "dryRun": true,
   "headerProtocolVersion": { "major": <current>, "minor": 67 } }`, and
   `"n2n.publicAddress": "<public ip>:3001"` matching the pool's registered relay.
3. Restart; check the log for the opcert counter/period line and the epoch schedule
   (`Block producer: epoch N schedule: k leader slot(s)`), then
   `bun scripts/forge-dry-run.ts $D/config.json --db-path $D/preprod.db --network preprod`
   (it reads `"ledgerStore": "lmdb"` from that config.json)
   must print `validateHeader (VRF / leader / KES / opcert): PASS`.
4. Set `"dryRun": false` and restart before the first scheduled slot. Confirm the forged block on
   a public explorer and on the node's own `/metrics` (`producer.leaderSlots` outcomes).

## Known limits (2026-09-21)

- Byron-era replay from genesis is SQLite-only; use the snapshot path.
- Node-to-client `GetStakeDistribution`, `GetStakePoolParams` and `GetGovState` are not served
  yet; `cardano-cli query tip / utxo / protocol-parameters / stake-pools` work.

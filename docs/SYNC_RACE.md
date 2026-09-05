# Sync race: Gerolamo vs Dingo vs Amaru

How to compare sync speed on one machine, and what the first run showed.

## Binaries

Downloaded 2026-09-03 into `/media/bakon/data/cardano/`:

| Node | Version | Path |
|---|---|---|
| Dingo | v0.70.5 (Go, Blink Labs) | `dingo/dingo` |
| Amaru | 10.11.20260903 (Rust, Pragma) | `amaru/amaru-10.11.20260903-linux-x86_64/bin/amaru` |

## Running each one

Gerolamo's inbound N2N port is 3001 and its HTTP port 3030, so the others get
different ports.

```sh
# Dingo, mainnet from genesis (Prometheus metrics on :12798)
cd /media/bakon/data/cardano/dingo
./dingo serve --network mainnet --data-dir $PWD/data --port 3003 --private-port 3004 \
  --metrics-port 12798 --storage-mode core > logs/dingo-mainnet.log 2>&1

# Amaru cannot start from genesis: it bootstraps from a published ledger
# snapshot (preprod: epochs 270 and 307 were available) and syncs forward.
cd /media/bakon/data/cardano/amaru
A=$PWD/amaru-10.11.20260903-linux-x86_64/bin/amaru
$A node bootstrap --network preprod --epoch 270 \
  --ledger-dir $PWD/preprod-e270/ledger.db --chain-dir $PWD/preprod-e270/chain.db
AMARU_LOG="error,amaru=info,amaru_pure_stage=warn" $A node run --network preprod \
  --ledger-dir $PWD/preprod-e270/ledger.db --chain-dir $PWD/preprod-e270/chain.db \
  --listen-address 127.0.0.1:3000 > logs/amaru-preprod-e270-run.log 2>&1
```

Do not pass `--with-json-traces` to Amaru for a long run: it logs every stage
at DEBUG regardless of `AMARU_LOG`, about 20 MB a minute.

## Measuring

`scripts/sync-race.mjs` samples every node on one clock and prints seconds to
each block height plus average blocks/s:

```sh
bun scripts/sync-race.mjs \
  --gerolamo http://127.0.0.1:3030 \
  --dingo http://127.0.0.1:12798 \
  --amaru /media/bakon/data/cardano/amaru/logs/amaru-preprod-e270-run.log \
  --every 10 --duration 600 --out /tmp/sync-race.csv
```

Sources: Gerolamo `/api/v0/blocks/latest`; Dingo's Prometheus
`cardano_node_metrics_blockNum_int`; Amaru has no metrics endpoint, so the
newest `tip.adopt` line in its log (`block_height`, `slot`) is used.

For a fair number run them one at a time against the same upstream relay.
Everything below ran concurrently with the user's own Gerolamo mainnet sync,
so absolute rates are depressed for all of them.

## First run, 2026-09-03

- **Dingo, mainnet from genesis.** About 165 blocks/s through the early Byron
  epochs (block 20 000 after 2 minutes, 453 000 after 25 minutes), then a hard
  stall at block 453 543: every peer is dropped with
  `block-fetch: received block outside requested range: slot=453600`.
  Slot 453 600 is the epoch 21 boundary block (EBB), which shares its slot
  with the epoch's first block. Dingo rejects it as out of range, backs off,
  reconnects and hits it again; 14 such drops over about 15 minutes before it
  got past the boundary. That is a Dingo bug, not a peer problem, and every
  Byron epoch boundary is a candidate for it. Gerolamo handles the same case
  (EBB deferral in `CandidateSet`).
- **Amaru, preprod from epoch 306 snapshot.** Bootstrap (470 MB download +
  import) took 202 s. Forward sync of the remaining ~1 650 blocks to the tip ran
  at roughly 10 blocks/s in Conway with full validation. Too short a distance
  to call a rate; the epoch-270 run below covers ~37 epochs.
- **Gerolamo, mainnet from genesis (the user's node).** 313 blocks/s average over
  the 49 minutes since its restart (920 k blocks); 40 to 80 blocks/s while the
  other two were running alongside it.

## Can Amaru sync from genesis? No (tested 2026-09-04)

Tried on mainnet with empty databases, Amaru 10.11.20260903:

| Attempt | Result |
|---|---|
| `node run --network mainnet` | refuses: no ledger directory |
| `mithril sync --network mainnet` | refuses: "Failed to create ledger. Did you bootstrap your node?" |
| `node bootstrap --epoch 0` / `--epoch 1` | refuses: "target epoch is too young; Amaru needs at least 3 past epochs" |
| `node bootstrap --epoch 3` / `208` | refuses: "only 600, 640, 650 are available for bootstrap on this network" |

Mainnet bootstrap points are epochs 600, 640 and 650 (Conway, 2026); preprod
has 270 and 307. The snapshots are ledger states dumped by cardano-node's
`db-analyser` (docs/BOOTSTRAP.md); `amaru snapshot create` can build one for
another epoch but it runs `db-analyser` to do so, and Amaru has no Byron ledger
rules at all, so the earliest state it could ever load is a Shelley-era one
computed by the Haskell node. Amaru is a from-snapshot node by design.

# Devnet

A private single-node chain where the pool has stake from genesis, so the producer can be
exercised end to end without waiting for a public network's snapshot window.

    docker run -d --name gerolamo-devnet-producer \
      -v /home/don/gerolamo-devnet:/data \
      -v /path/to/pool-keys:/keys:ro \
      -p 127.0.0.1:3052:3030 -p 3015:3001 \
      gerolamo --network devnet --bootstrap genesis --port 3030 --role producer

`--bootstrap genesis` matters: the entrypoint's default is a Mithril import, which would pull a
public snapshot into a network that has none.

## What is in `src/config/devnet/`

| File | Purpose |
|---|---|
| `shelley-genesis.json` | the chain: `epochLength`, `activeSlotsCoeff`, `securityParam`, `initialFunds`, the pool and its delegation |
| `byron-genesis.json`, `alonzo-genesis.json`, `conway-genesis.json` | the other eras' genesis |
| `node-config.json` | a cardano-node config whose `Test*HardForkAtEpoch` are all 0: every era is active from epoch 0 |
| `config.json` | Gerolamo's own config (role, ports, producer key paths) |
| `topology.json` | empty: a single node has no peers |

A network name that is not `preview`/`preprod`/`mainnet` makes the node take its slot and epoch
geometry from these files (`setCustomEpochGeometry`), which is what makes a private chain work at all.

## The geometry rules that matter

Three constraints fight each other; this is the combination that satisfies all of them:

1. **Epoch 0 cannot forge.** `poolStakeForEpoch(epoch)` reads the snapshot taken at `epoch - 1`, so
   epoch 0 would ask for `taken_at = -1` and always find nothing. The first epoch that can forge is
   the one after the first boundary: epoch 2 with `epochLength = 600`.
2. **The opcert's KES period must be current.** A certificate issued on a live network declares a
   period in the thousands (ours: 1071), so the devnet's current period has to be at least that.
   With `slotsPerKESPeriod = 1` the period is the slot number, and epoch 2 is past 1071.
3. **The KES evolution must stay inside `maxKESEvolutions`.** Evolving from 1071 to ~1200 is ~130
   steps, so `maxKESEvolutions` is raised to 2000.

`systemStart` is set to the time the chain is created; `activeSlotsCoeff = 1.0` means every slot has
a leader slot, so the first forged block is expected at the epoch-2 boundary, about 20 minutes in.

## The genesis root

A genesis-start chain has no first block, so the producer has no parent to build on and refuses with
`leader for slot N but not forging: no chain tip`. `config.json` therefore carries a
`genesisBlockHash`: while the chain is empty the producer forges block 1 on that root, and the applier
skips its parent check (the store is empty, so there is nothing for the block to extend).

It is an explicit config value, not a derived one. Deriving a Byron genesis block hash correctly is a
consensus-critical computation and getting it wrong is worse than not having it: the node would forge
a block its own validator rejects. Any stable 32-byte hex works for a single-node testnet; all zeros
means "unset" and restores the old behaviour (no forging on an empty chain).

## Checking it works

    curl -s http://127.0.0.1:3052/api/v0/gerolamo/status     # tip slot > 0 means a block exists
    docker logs gerolamo-devnet-producer | grep -i "epoch .* schedule"

A healthy producer logs `epoch N schedule: N leader slot(s)`; a pool with stake that is failing to
forge logs `0 leader slot(s)` once the snapshot exists, which points at the VRF key or the
delegation rather than at the clock.

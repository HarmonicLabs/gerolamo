# Gerolamo watchdog

One pass per minute from a systemd **user** timer (lingering is on, so it runs after a reboot
without a login). Relaunches missing node supervisors; alerts on halts, lag, unreachable nodes,
lost leader slots and on any divergence from the local cardano-node relay (continuous verification,
below) via `notify-send` and, optionally, an ntfy topic on your phone.

    mkdir -p ~/.config/systemd/user ~/.config/gerolamo
    cp scripts/watchdog/gerolamo-watchdog.{service,timer} ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now gerolamo-watchdog.timer
    bun scripts/watchdog.ts /media/bakon/data/cardano/watchdog/config.json --test

Phone alerts: install the ntfy app, subscribe to a hard-to-guess topic, then
set `"ntfyUrl": "https://ntfy.sh/<topic>"` in the watchdog config.json.
Log: `/media/bakon/data/cardano/watchdog/watchdog.log`. Stop: `systemctl --user disable --now gerolamo-watchdog.timer`.
Node list: `/media/bakon/data/cardano/watchdog/config.json` (add the preprod node there on the new server).

## KES rotation (the `…:kes` alert)

    bun scripts/pool-register.ts rotate-kes --dir <pool keys> --node http://127.0.0.1:3035
    # copy kes.skey, kes.vkey, node.cert to the producer's key paths (config.json producer.*File), then:
    kill -HUP <producer node pid>

The node reloads the KES key and operational certificate on SIGHUP, as cardano-node does, and
logs `Block producer: credentials reloaded: opcert counter a → b, KES period …`. It first checks
the new pair (issued by the pool's cold key, certifying this KES key, valid for the current KES
period, counter equal to the chain's or one above) and keeps the running pair if any check fails
(`… reload rejected, keeping counter …: <reason>`). No restart, no missed slots. The pid: the
`bun` process whose command line is `start-gerolamo ... --port <port>` (the watchdog alert prints it); never
`pkill` — other bun processes run on this machine. SIGHUP also re-reads topology.json.


## Continuous verification against the relay (`…:parity`, `…:schedule`, `…:forge-<slot>` alerts)

The watchdog checks every Gerolamo node against the local cardano-node relay (the reference oracle),
on by default for each node that has an N2C socket (`n2cSocketPath` in the node's `config.json`) and
a relay of its network. The tick itself never talks to a node: it reads `parity-history.json` next
to the state file, raises problems from it, and starts `scripts/parity-probe.ts` detached (lock file
`parity.lock`, output `parity.log`) when a check is due. The probe writes the history atomically
and one summary line per check into the watchdog log (`parity …`, `schedule …`, `forge …`).

| check | when | alert |
|---|---|---|
| **parity**: the `n2c-compare` query set (61 queries: every Conway BlockQuery, hard-fork and top-level queries) on the node and on the relay, both acquired at one block (the relay acquires our tip, retried while it catches up; else we acquire its tip; else own tips with live answers retried) | every 30 min per node; after each epoch boundary from +3 min, retried every 3 min until a run acquired a block of the new epoch (≤ 30 min); never on a producer within 180 s of its next leader slot, never while the node is > 10 min behind | `<node>: N N2C answers differ from cardano-node` when a query differs in **two consecutive** runs (names, sizes, first differing byte); `OK again` when a run is clean. `<node>: parity probe failing / not running` (non-urgent) after two failed runs or 2 h without one |
| **schedule**: the producer's leader slots (`/metrics producer.leaderSlots`) against `cardano-cli conway query leadership-schedule --current` on the relay socket, with the producer config's `producer.vrfSkeyFile` *path* (cardano-cli reads the key; only slot numbers are kept or logged) | once per epoch, as soon as the producer has scheduled it, again after each producer restart (`uptimeSec`), retried 15 min after a failure; every tick compares the producer's live schedule with the stored answer | `<node>: leader schedule differs from cardano-node` with the slots only cardano-cli has and only we have; `leader schedule check failing` after two failures |
| **forge**: each forged block the producer has settled — `adopted`/`confirmed` (it says the block is on the chain) or `ghosted`/`stolen` (it says it is not) — against the relay's chain (node-to-client ChainSync `FindIntersect` at our block) | once the relay's tip is 15 min past the slot, then every 30 min for 36 h, and whenever the producer's outcome changes | `<node>: forged slot S: producer and relay disagree` (one of the two is on a fork); `OK again` when they agree |

Big queries: `GetUTxOWhole`, `DebugEpochState` and `DebugNewEpochState` (hundreds of MB on preview)
are not run unless `"huge": true`; the rest is ~11 MB of answers per side per run on preview
(~4 s per node; 2 nodes every 30 min ≈ 1 GB/day read from the relay over its local socket).

By hand (same checks now, results in the history; `--force` ignores the schedule):

    bun scripts/parity-probe.ts /media/bakon/data/cardano/watchdog/config.json --force parity,schedule,forge [--node "preview producer"]
    jq '.nodes["preview data node"].runs[-1] | {point, same, total, diffs}' /media/bakon/data/cardano/watchdog/parity-history.json

Configuration (all optional; shown with the defaults). Without a `relays` entry the relay is the
`processes` entry whose command names the network and has `--socket-path` (its socket, the
`cardano-cli` next to its `cardano-node`, the `ShelleyGenesisFile` of its `--config`):

    "parity": {
      "enabled": true, "intervalMin": 30, "boundaryDelayMin": 3, "boundaryWindowMin": 30, "retryMin": 3,
      "huge": false, "skip": [], "quietSec": 180, "maxLagSec": 600,
      "leaderSchedule": true, "scheduleRetryMin": 15, "postForge": true, "forgeSettleSec": 900, "forgeWindowHours": 36,
      "historyRuns": 48, "detailRuns": 4, "maxRuntimeMin": 15,
      "relays": { "preview": { "socket": "/media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket",
                               "cardanoCli": "/media/bakon/data/cardano/cardano-node/bin/cardano-cli",
                               "shelleyGenesis": "/media/bakon/data/cardano/cardano-node/share/preview/shelley-genesis.json" } }
    }

Per node: `"parity": false` leaves it out; `"n2cSocketPath"` and (producer) `"vrfSkeyFile"` override
the node's `config.json`. The history keeps 48 runs per node (the newest 4 with every query's
result, older ones only their differences), the last schedule check and the forge checks of the
window. A stuck probe exits after `maxRuntimeMin`; a lock whose process is gone is taken over.

# ops — the .173 runbook scripts

These are the operational scripts that keep the Gerolamo preprod fleet on
`192.168.1.173` alive. They were written in place on the box and had no copy in
git until this directory existed. The copies here are byte-for-byte identical to
the live files (see the table below for the live path); edit here, then deploy
with `scp`, so a lost disk is no longer a lost runbook.

Absolute paths (`/home/don/gerolamo/...`) are intentional: they match the live
layout, and the systemd units call the scripts by that path.

## What runs, and how

| Script | Live path | Cadence | Emits |
|---|---|---|---|
| `gerolamo-health.sh` | `node/gerolamo-health.sh` | loop, 300 s | `ALERT` lines: relay unhealthy twice, explorer index lag > 5000 slots, active stake with 0 blocks in a new epoch, KES evolution >= 50/62, disk < 20 GB |
| `node-log-watch.sh` | `node/node-log-watch.sh` | loop, 300 s | `ALERT` lines: container down/unhealthy/restarted, hard ERROR lines, rollbacks that delete data; routine peer noise filtered |
| `health-log.sh` | `node/health-log.sh` | loop, 300 s | one status line per container (status, tip, lag, halt, producer next slot / KES, memory); restarts a halted or > 900 s stale node, at most once per hour |
| `deploy-preprod.sh` | `node/deploy-preprod.sh` | manual | rebuilds `gerolamo:preprod` and recreates relay + producer with the maintenance marker set |
| `after-gapfill.sh`, `start-dingo-preprod.sh`, `start-dingo-v93.sh` | `node/` | one-shot | chained bring-up of the dingo reference relay, serialised against the explorer gap-fill |
| `devnet_forge_watch.sh` | `node/` | one-shot watch | waits for the devnet's first forged block |

Two systemd units (`systemd/`) run the watchers and append stdout/stderr to
`logs/alerts.log`:

```
gerolamo-health.service    ExecStart=/usr/bin/bash /home/don/gerolamo/node/gerolamo-health.sh
gerolamo-logwatch.service  ExecStart=/usr/bin/bash /home/don/gerolamo/node/node-log-watch.sh
```

Install with:

```bash
sudo cp ops/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gerolamo-health.service gerolamo-logwatch.service
```

## The maintenance marker protocol

`deploy-preprod.sh` touches `node/.maintenance` before recreating containers and
removes it on exit. While the marker exists, `node-log-watch.sh` advances every
container cursor and stays quiet, so a deliberate replacement does not page as an
incident. Any deploy that bypasses the script (a bare `docker compose up`) will
alert; use the script.

## Dependencies

`bash`, `docker` + `docker compose`, `curl`, `python3` (the health watchers parse
the node API with it). No secrets: keys live in the containers' mounted
`/keys` and `/greeting` directories; the scripts only name them (`cold.skey`
for opcert rotation).

## What these do not cover

They watch the node, not the ledger: a halt or a fork is caught here, but a
wrong block is caught by the consensus tests, not by a shell script.

# Standalone Gerolamo desktop UI

Electrobun + SolidJS control center for **this repo**. Not The Lab. Not TxPipe.

## Run

```bash
cd path/to/gerolamo   # your checkout of this repo
bun run ui:dev
# or:
cd desktop && bun install && bun run dev
```

Linux + Bun. First start uses `desktop/node_modules`.

## Two planes

| Plane | Process |
|-------|---------|
| Control | Electrobun app (`desktop/`) — detect, config, Mithril child, start/stop |
| Data | `bun src/index.ts start-gerolamo` — MiniBF HTTP, optional N2C |

- App metadata: `~/.local/share/gerolamo/app.db`
- Instance dir: `~/.local/share/gerolamo/<id>/`
- Chain DB: **you pick** (absolute). Default `<instance>/data/gerolamo.db`
- Snapshot dir: default **repo `snapshots/mithril`** if that tree exists (avoids re-download), else `<instance>/snapshots`

## Steps in the UI

1. Runtime (Bun + this checkout)
2. Write instance (network, port, **DB path**, snapshot dir)
3. Mithril bootstrap (`--engine ts`) **or Skip**
4. Start node → one ops panel (health / tip / peers / Open `/docs` + `/stats`)

Never two writers on one SQLite file. Never fake Mithril percent. Soft ledger ≠ consensus.

## Tests

```bash
cd desktop && bun test src
bun run typecheck
```

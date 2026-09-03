# Standalone Gerolamo desktop UI

Electrobun + SolidJS control center for **this repo**. Not The Lab. Not TxPipe.

## Run

```bash
cd path/to/gerolamo   # your checkout of this repo
bun run ui:dev
# or:
cd desktop && bun install && bun run dev
```

Requires Linux + Bun. First start installs `desktop/node_modules`.

## Two planes

| Plane | Process |
|-------|---------|
| Control | Electrobun app (`desktop/`) — detect, config, Mithril child, start/stop |
| Data | `bun src/index.ts start-gerolamo` — MiniBF HTTP, optional N2C |

Instance metadata: `~/.local/share/gerolamo/app.db`  
Instance dir: `~/.local/share/gerolamo/<id>/`  
Chain DB: **you pick** (absolute path). Default `<instance>/data/gerolamo.db`.

## Steps in the UI

1. Runtime (Bun + this checkout)
2. Write instance (network, port, **DB path**, snapshot dir)
3. Mithril bootstrap (`--engine ts`) **or Skip**
4. Start node → one ops panel (health / tip / peers / Open `/docs` + `/stats`)

Never two writers on one SQLite file. Never fake Mithril percent.

## Tests

```bash
cd desktop && bun test src
bun run typecheck
```

Do **not** point the first smoke at `.live/test.db` (64G). Use `/tmp/gerolamo-ui-smoke.db`.

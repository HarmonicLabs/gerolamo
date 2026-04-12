<p align="center">
    <p align="center">
        <img width="200px" src="https://github.com/HarmonicLabs/gerolamo/blob/closeout-demo/assets/gerolamo-logo.svg" align="center"/>
        <h1 align="center">Gerolamo</h1>
    </p>
  <p align="center">Cardano TypeScript node implementation</p>

<p align="center">
    <img src="https://img.shields.io/github/commit-activity/m/HarmonicLabs/gerolamo?style=for-the-badge" />
    <a href="https://twitter.com/hlabs_tech">
      <img src="https://img.shields.io/twitter/follow/hlabs_tech?style=for-the-badge&logo=twitter" />
    </a>
  </p>
</p>

Gerolamo is a modular **Cardano node** implementation in **TypeScript** on the
**Bun** runtime. It includes a production monitoring dashboard and a standalone
Chrome extension for exploring the Cardano blockchain.

## Components

| Component | Stack | Description |
|-----------|-------|-------------|
| **Node** (`src/`) | Bun + TypeScript + SQLite | Ouroboros P2P node with Praos consensus |
| **Dashboard** (`dashboard/`) | React + shadcn/ui + Tailwind | 10-page monitoring UI with SSE live updates |
| **Dashboard Server** (`scripts/dashboard-server.ts`) | Bun HTTP + SSE | REST API + event stream on port 3050 |
| **Gerolamino Extension** (`extension-gerolamo/`) | SolidJS + WXT + Tailwind | Standalone Chrome extension (Koios API, no key required) |

## Quick Start

### Prerequisites

- **Bun** v1.3+ — [bun.sh](https://bun.sh)
- No separate Node.js or SQLite install needed (Bun bundles `bun:sqlite`)

### Run the Node

```bash
git clone https://github.com/HarmonicLabs/gerolamo.git
cd gerolamo
bun install
bun src/start.ts
```

Syncs **preprod** by default. Edit `src/config/preprod/config.json` or set
`NETWORK=mainnet` for mainnet.

### Run the Dashboard

```bash
cd dashboard && bun install && bun run build
cd .. && bun scripts/dashboard-server.ts
# Open http://localhost:3050
```

The dashboard server serves the static build and provides REST + SSE endpoints
reading from the node's SQLite database.

### Build the Chrome Extension

```bash
cd extension-gerolamo
bun install
bun run build
# Load .output/chrome-mv3/ as unpacked extension in Chrome
```

The extension auto-connects to Cardano preprod via
[Koios](https://koios.rest) — no API keys or external services required.

## Node

### Features

- **P2P networking** — Ouroboros mini-protocols: Handshake, ChainSync,
  BlockFetch, KeepAlive, TxSubmission, PeerSharing
- **Praos consensus** — VRF verification, KES signature validation, stake
  distribution checks
- **Multi-era chain sync** — Byron through Conway, from genesis/tip/point
- **Block & header parsing** — `@harmoniclabs/cardano-ledger-ts`
- **SQLite WAL storage** — volatile blocks with immutable chunk GC
- **State bootstrap** — Mithril snapshots + Blockfrost era boundaries
- **Peer management** — hot/warm/cold/bootstrap peer categorization

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/block/{slot\|hash}` | Raw CBOR block by slot number or hash |
| `GET` | `/utxo/{txhash:index}` | UTxO details (address, amount, assets) |
| `POST` | `/txsubmit` | Submit a CBOR-encoded transaction |

### Configuration

Edit `src/config/{preprod,mainnet}/config.json`:

```jsonc
{
  "network": "preprod",
  "networkMagic": 1,
  "topologyFile": "./src/config/preprod/topology.json",
  "dbPath": "./store/db/preprod/Gerolamo.db",
  "syncFromTip": false,
  "syncFromPoint": true,
  "syncFromPointSlot": 3542390,
  "syncFromPointBlockHash": "f93e682d..."
}
```

### Architecture

```
start.ts → initDB (SQLite WAL) → peerBlockServer (HTTP :3030)
         → startPeerManager → peerManagerWorker
           ├─ parseTopology → addPeers (hot/bootstrap)
           └─ spawn → peerClientWorker → PeerClient (per peer)
              ├── Handshake
              ├── ChainSync (rollForward / rollBack)
              └── BlockFetch → parse → batch insert → GC
```

**Key modules:**
- `src/consensus/` — Praos validation, StableState (~600 LOC)
- `src/network/` — P2P layer, 6 mini-protocols
- `src/state/` — Blockfrost + Mithril bootstrap
- `src/db.ts` — SQLite WAL with volatile → immutable GC

## Dashboard

React 18 monitoring frontend with cyberpunk dark theme.

**10 pages:** Overview, Node, Blocks, Peers, Mempool, Explorer (UTxO lookup),
Wallet, Chain Diagram, Logs, Settings

- SSE subscriptions for live block/peer/mempool updates
- React Query hooks for all API endpoints
- Vite dev proxy to dashboard server

### Dashboard Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Node sync status, tip slot, height, era |
| `GET` | `/api/blocks` | Recent blocks with slot, hash, size, tx count |
| `GET` | `/api/peers` | Connected peers with latency and state |
| `GET` | `/api/mempool` | Pending transactions |
| `GET` | `/api/chain-state` | Stake, delegation, pool, treasury stats |
| `GET` | `/api/logs` | Recent log entries |
| `GET` | `/api/deltas` | SSE stream of live updates |

## Gerolamino Chrome Extension

Standalone Cardano blockchain explorer — works without running a node.

**9 tabs:** Overview, Node, Blocks, Network, Explorer, Wallet, Pebble, Logs,
Settings

- **SolidJS** + TanStack Solid Query + Tailwind CSS + WXT (Chrome MV3)
- Background service worker polls [Koios](https://koios.rest) for chain data
- Auto-connects on install — zero configuration
- UTxO lookup and transaction submission
- Wallet key generation (`@harmoniclabs/cardano-ledger-ts` + `bip32_ed25519`)
- [Pebble](https://pluts.harmoniclabs.tech/) smart contract compiler (in-browser)
- Preprod and mainnet support
- 537 KB zipped

## Scripts & Tools

Located in `scripts/`:

- `dashboard-server.ts` — REST + SSE server for the dashboard
- `bootstrap-client.ts` — LMDB bootstrap data streaming
- `utxo-query.ts` — Direct UTxO lookups against the node DB
- `integration-test.ts` — Comprehensive test suite (database, wallet, API, SSE)
- LMDB FFI tools for low-level storage operations

## Development

```bash
# Run node with debug inspector
bun --inspect src/start.ts

# Dashboard dev mode (hot reload)
cd dashboard && bun run dev

# Extension dev mode
cd extension-gerolamo && bun run dev

# Tail logs
tail -f logs/preprod/*.jsonl | jq -r '.level, .args[] | @text'

# Inspect DB
sqlite3 store/db/preprod/Gerolamo.db "SELECT COUNT(*) FROM volatile_blocks;"
```

## Funding

- [Catalyst Fund 11 #1100158](https://projectcatalyst.io/) — Cardano consensus in TypeScript
- Intersect 2025 — Node diversity initiative

## Resources

- [Cardano Ouroboros](https://ouroboros-network.cardano.intersectmbo.org/)
- [Harmonic Labs](https://github.com/HarmonicLabs)
- [ouroboros-miniprotocols-ts](https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts)
- [cardano-ledger-ts](https://github.com/HarmonicLabs/cardano-ledger-ts)
- [Pebble](https://pluts.harmoniclabs.tech/)
- [Koios API](https://koios.rest)
- [Bun Docs](https://bun.sh/docs)

## License

Harmonic Labs S.R.L.

# Changelog

All notable changes on branch **`The-Lab`** (Lab integration). Format: Keep a Changelog–ish.

## [Unreleased]

### Added

- **N2C Phase 1** — `src/network/n2c/`: Unix `node.socket` server + `HandshakeResponder` (Accept/Refuse).
  - Enable: `GEROLAMO_N2C_SOCKET=/path`, or `n2c.enabled=true` + `n2c.socketPath` in config.
  - Disable: `GEROLAMO_N2C=0`. Distinct from HTTP `unixSocket`.
- **N2C Phases 2–5** (data-node surface; hosts wired after Handshake Accept):
  - Phase 2: `GerolamoChainDb` (`IChainDb` over SQLite) + `LocalChainSyncHost` (mini-protocol 5).
  - Phase 3: `LocalTxSubmitHost` (protocol 6) → `GlobalSharedMempool` Accept/Reject.
  - Phase 4: `LocalStateQueryHost` (protocol 7) — Acquire/Acquired/Release/Done + minimal tip query result.
  - Phase 5: `LocalTxMonitorHost` (protocol 9) — Acquire snapshot, NextTx, HasTx, GetSizes.
- `docs/N2C_IMPLEMENTATION_PLAN.md` — phased plan for Ouroboros N2C `node.socket` (Handshake → LocalChainSync → LocalTxSubmit → LSQ).
- `src/sql.ts` — shared SQLite client (`initSql`, `getSqlFilename`); honors `DATABASE_URL` / `GEROLAMO_DB_PATH`.
- `GET /health` and `GET /healthz` on peer block server (JSON: healthy, network, port, uptimeSec).
- Lab env overrides in start path: `DATABASE_URL`, `GEROLAMO_DB_PATH`, `PORT` / `GEROLAMO_PORT`.
- `GerolamoMempoolAdapter` — bridges shared-mempool package typo (`getAviableSpace` / `aviableSpace`) to ouroboros `IMempool` (`getAvailableSpace` / `availableSpace`).
- `PROJECT_MEMORY.md`, `GEROLAMO_THE_LAB_CONTEXT.md` — agent/branch policy and Lab handoff.
- `wasm-kes-0.2.2.tgz` dependency path (was 0.2.1 local tgz).

### Changed

- `@harmoniclabs/cardano-ledger-ts`: local `0.4.0-dev16.tgz` → registry `^0.4.3`.
- All chain SQL importers use `../sql` / `./sql` instead of `bun` default Postgres `sql`.
- Consensus public exports: `compareChainsPraos`, `findIntersection`; types `ChainComparison`, `ChainSelectionMode`.
- `tsconfig.json`: include `src/**/*` only; exclude `dashboard`, `scripts`, `dist`, `node_modules`.
- `.gitignore`: ignore `ledger/` runtime DB directory.
- Config preprod/mainnet: optional `n2c` block (`enabled` default false).

### Fixed

- Mempool API surface for TxSubmitClient (`getTxs`, correct space getters, `bytes` vs `cbor` on tx payload).
- N2C handshake parse uses `n2n=false` (library `handshakeMessageFromCborObj` defaults N2N and misreads N2C VersionData).

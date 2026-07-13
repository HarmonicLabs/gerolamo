# Changelog

All notable changes on branch **`The-Lab`** (Lab integration). Format: Keep a Changelog–ish.

## [Unreleased]

### Added

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

### Fixed

- Mempool API surface for TxSubmitClient (`getTxs`, correct space getters, `bytes` vs `cbor` on tx payload).

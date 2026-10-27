# Gerolamo settings

Generated from `src/config/settings.ts` (`bun src/index.ts settings-doc`). Gerolamo reads no environment variables.
Each setting is a command-line flag and a config.json key; the flag wins, then config.json (the network's bundled
file with `--config` merged over it), then the default. Any other config.json key can be set from the command line
with `--set key.path=value`. Secrets have no plain flag: put them in config.json or pass `--…-file <path>`.

## Instance

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--network <preview\|preprod\|mainnet>` | `networkName` | `"preprod"` | Network; picks the bundled config src/config/<network>/config.json | `NETWORK` |
| `--config <path>` | - | - | Instance config file merged over the network's bundled config.json | `GEROLAMO_CONFIG_PATH` |
| `--db-path <path>` | `dbPath` | `"./.live/test.db"` | SQLite database file | `DATABASE_URL`, `GEROLAMO_DB_PATH` |
| `--port <int>` | `port` | `3030` | HTTP port (API, /stats, dashboards) | `PORT`, `GEROLAMO_PORT` |
| `--heap-dir <path>` | `heapDir` | `"."` | Directory for SIGUSR2 heap summaries | `GEROLAMO_HEAP_DIR` |
| `--failed-block-dir <path>` | `failedBlockDir` | `"./logs"` | Directory where blocks that fail validation are written | `GEROLAMO_FAILED_BLOCK_DIR` |
| `--blockfrost-project-id-file <path>` | `blockfrostProjectId` | - | Blockfrost project id for era and epoch fetches | `BLOCKFROST_PROJECT_ID` |

## Servers

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--n2c` / `--no-n2c` | `n2c.enabled` | `true` | Serve node-to-client on the N2C socket (when a socket path is set) | `GEROLAMO_N2C` |
| `--n2c-socket <path>` | `n2cSocketPath` | - | N2C node.socket path | `GEROLAMO_N2C_SOCKET` |
| `--n2n` / `--no-n2n` | `n2n.enabled` | - | Inbound node-to-node listener (default: on for role relay or producer) | `GEROLAMO_N2N` |
| `--n2n-port <int>` | `n2n.port` | `3001` | N2N listen port | `GEROLAMO_N2N_PORT` |
| `--n2n-host <string>` | `n2n.host` | `"0.0.0.0"` | N2N bind address | `GEROLAMO_N2N_HOST` |
| `--n2n-ws` / `--no-n2n-ws` | `n2n.ws.enabled` | `false` | N2N over WebSocket (browser nodes) | - |
| `--n2n-ws-port <int>` | `n2n.ws.port` | `3002` | N2N-over-WebSocket port | `GEROLAMO_N2N_WS_PORT` |
| `--n2n-ws-host <string>` | `n2n.ws.host` | `"0.0.0.0"` | N2N-over-WebSocket bind address | `GEROLAMO_N2N_WS_HOST` |
| `--prometheus <string>` | - | - | Prometheus endpoint: host:port, a port, or off (overrides config prometheus.*) | `GEROLAMO_PROMETHEUS` |
| `--utxorpc <string>` | - | - | UTxO RPC: on, off, host:port or a port (overrides config utxorpc.*) | `GEROLAMO_UTXORPC` |
| `--mithril-artifacts <string>` | - | - | Serve a Mithril artifact store from this directory, or off (overrides config mithril.*) | `GEROLAMO_MITHRIL_ARTIFACTS` |
| `--mithril-progress-file <path>` | `mithril.progressFile` | - | Mithril bootstrap progress JSON shown in /stats | `GEROLAMO_MITHRIL_PROGRESS` |
| `--explorer-worker` / `--no-explorer-worker` | `explorer.worker` | `true` | Write the explorer index in a worker (off: inline) | `GEROLAMO_EXPLORER_WORKER` |
| `--keepalive-timeout-ms <int>` | `keepAliveTimeoutMs` | `60000` | Keep-alive reply deadline per peer | `GEROLAMO_KEEPALIVE_TIMEOUT_MS` |

## Storage

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--block-store` / `--no-block-store` | `blockStore` | `true` | Keep blocks in cardano-node chunk files | `GEROLAMO_BLOCK_STORE` |
| `--block-store-dir <path>` | `blockStoreDir` | - | Block store directory (default: <dir of db-path>/db) | `GEROLAMO_BLOCK_STORE_DIR` |
| `--block-store-mode <mirror\|primary>` | `blockStoreMode` | `"primary"` | Block store role | `GEROLAMO_BLOCK_STORE_MODE` |
| `--relay-store <sqlite\|chunks>` | `relayStore` | `"sqlite"` | Store the N2N servers read blocks from | `GEROLAMO_RELAY_STORE` |
| `--block-fsync <batch\|block\|none>` | `blockFsync` | `"batch"` | fsync policy for block files | `GEROLAMO_BLOCK_FSYNC` |
| `--ledger-store <sqlite\|dual\|lmdb>` | `ledgerStore` | `"sqlite"` | Ledger state backend | `GEROLAMO_LEDGER_STORE` |
| `--ledger-dir <path>` | `ledgerDir` | - | LMDB ledger directory (default: <dir of db-path>/ledger) | `GEROLAMO_LEDGER_DIR` |
| `--ledger-sql-writes` / `--no-ledger-sql-writes` | `ledgerSqlWrites` | `true` | Also write ledger state to SQLite in lmdb mode | `GEROLAMO_LEDGER_SQL_WRITES` |
| `--ledger-keep-epochs <int>` | `ledgerKeepEpochs` | `30` | Epochs of report history kept (at least 4) | `GEROLAMO_LEDGER_KEEP_EPOCHS` |
| `--ledger-diff-fsync <batch\|block\|none>` | `ledgerDiffFsync` | `"batch"` | fsync policy for ledger diffs | `GEROLAMO_LEDGER_DIFF_FSYNC` |
| `--genesis-exact` / `--no-genesis-exact` | `genesisExact` | `false` | The store was synced from genesis: treat its ledger as exact | `GEROLAMO_GENESIS_EXACT` |
| `--utxo-index` / `--no-utxo-index` | `utxoIndex` | `true` | Maintain the LMDB UTxO indexes | `GEROLAMO_UTXO_INDEX` |
| `--lmdb-lib <path>` | `lmdbLib` | - | Path to liblmdb (default: search the standard library paths) | `LMDB_LIB` |
| `--sync-sql` / `--no-sync-sql` | `syncSql` | `true` | Use the synchronous bun:sqlite writer (off: Bun.SQL) | `GEROLAMO_SYNC_SQL` |
| `--apply-skip-deltas` / `--no-apply-skip-deltas` | `applySkipDeltas` | `false` | Skip utxo_deltas rows while applying blocks | `APPLY_SKIP_DELTAS` |
| `--apply-skip-index` / `--no-apply-skip-index` | `applySkipIndex` | `false` | Skip the tx, address and explorer indexes while applying blocks | `APPLY_SKIP_INDEX` |

## Consensus

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--experimental-hard-forks` / `--no-experimental-hard-forks` | `experimentalHardForksEnabled` | - | Make the Dijkstra era reachable | `GEROLAMO_EXPERIMENTAL_HARD_FORKS` |
| `--chain-selection <legacy\|shadow\|praos>` | `consensus.chainSelection` | `"legacy"` | Chain selection | `GEROLAMO_CHAIN_SELECTION` |
| `--consensus-mode <praos\|genesis>` | `consensus.mode` | `"praos"` | Consensus mode | `GEROLAMO_CONSENSUS_MODE` |
| `--csj` / `--no-csj` | `consensus.csj` | `true` | ChainSync Jumping in genesis mode | `GEROLAMO_CSJ` |
| `--defer-vrf` / `--no-defer-vrf` | `consensus.deferVrf` | `true` | Defer VRF checks of epoch-boundary headers (off: hold them) | `GEROLAMO_DEFER_VRF` |
| `--rules-ahead` / `--no-rules-ahead` | `consensus.rulesAhead` | `true` | Run ledger rules ahead in workers | `GEROLAMO_RULES_AHEAD` |
| `--gov-rules <strict\|report>` | `consensus.govRules` | `"strict"` | Governance rules: reject, or only report, violations | `GEROLAMO_GOV_RULES` |

## Plutus

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--plutus-phase2 <enforce\|report\|off>` | `plutus.phase2` | `"enforce"` | Plutus phase-2 validation | `GEROLAMO_PLUTUS_PHASE2` |
| `--plutus-shadow-ms <int>` | `plutus.shadowMs` | `2000` | Wall-clock cap per redeemer (at least 50) | `GEROLAMO_PLUTUS_SHADOW_MS` |
| `--plutus-shadow-sample <int>` | `plutus.shadowSample` | `1` | Evaluate every n-th Plutus transaction | `GEROLAMO_PLUTUS_SHADOW_SAMPLE` |
| `--plutus-shadow-max-cpu <string>` | `plutus.shadowMaxCpu` | `"3000000000"` | Skip a redeemer declaring more CPU than this | `GEROLAMO_PLUTUS_SHADOW_MAX_CPU` |
| `--plutus-shadow-step-cpu <string>` | `plutus.shadowStepCpu` | `"20000000"` | Refuse a single builtin step costing more CPU than this | `GEROLAMO_PLUTUS_SHADOW_STEP_CPU` |
| `--plutus-legacy-shadow` / `--no-plutus-legacy-shadow` | `plutus.legacyShadow` | `false` | Use the legacy shadow evaluator | `GEROLAMO_PLUTUS_LEGACY_SHADOW` |
| `--plutus-dump-dir <path>` | `plutus.dumpDir` | - | Write applied Plutus programs here as hex | `GEROLAMO_PLUTUS_DUMP_DIR` |

## Local state query

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--lsq-nonmyopic-seed <path>` | `lsq.nonmyopicSeed` | - | cardano-node ledger-state file that seeds the non-myopic rewards state | `GEROLAMO_LSQ_NONMYOPIC_SEED` |
| `--lsq-gov-cache <path>` | `lsq.govCache` | - | Governance index cache file ("" = memory only; default <ledger-dir>/../lsq-gov-index.json) | `GEROLAMO_LSQ_GOV_CACHE` |
| `--lsq-pulser-backfill` / `--no-lsq-pulser-backfill` | `lsq.pulserBackfill` | `false` | Backfill a missing pulser snapshot | `GEROLAMO_LSQ_PULSER_BACKFILL` |
| `--shelley-genesis-file <path>` | `shelleyGenesisFile` | - | Shelley genesis file (default: the bundled one) | `GEROLAMO_SHELLEY_GENESIS` |
| `--conway-genesis-file <path>` | `conwayGenesisFile` | - | Conway genesis file (default: the bundled one) | `GEROLAMO_CONWAY_GENESIS` |

## Traces

| Flag | config.json | Default | Meaning | Replaces |
|---|---|---|---|---|
| `--trace-headers` / `--no-trace-headers` | `trace.headers` | `false` | Log every header that passes validation | `GEROLAMO_HEADER_TRACE` |
| `--trace-tx-submission` / `--no-trace-tx-submission` | `trace.txSubmission` | `false` | Trace tx-submission messages | `GEROLAMO_TXSUB_TRACE` |
| `--trace-n2n-chain-sync` / `--no-trace-n2n-chain-sync` | `trace.n2nChainSync` | `true` | Trace the first chain-sync messages of each inbound N2N peer | `GEROLAMO_N2N_TRACE` |
| `--trace-sql` / `--no-trace-sql` | `trace.sql` | `false` | Log the time of every SQL statement | `GEROLAMO_SQL_PROFILE` |
| `--trace-plutus <int>` | `trace.plutus` | `0` | Plutus builtin cost trace: 0 off, 1 summary, 2 every step | `GEROLAMO_PLUTUS_TRACE` |
| `--trace-plutus-builtins` / `--no-trace-plutus-builtins` | `trace.plutusBuiltins` | `false` | One log line per Plutus builtin call | `GEROLAMO_PLUTUS_BUILTIN_TRACE` |
| `--trace-plutus-builtins-full` / `--no-trace-plutus-builtins-full` | `trace.plutusBuiltinsFull` | `false` | Do not truncate bytes in the builtin trace | `GEROLAMO_PLUTUS_BUILTIN_TRACE_FULL` |


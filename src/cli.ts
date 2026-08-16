import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { ensureInitialized } from "./db";
import { initSql, getSqlFilename } from "./sql";

import { start } from "./network";

import { Logger, LogLevel } from "./utils/logger";
import { parse, resolve } from "node:path";
import { readdir } from "node:fs/promises";

import {
    processChunk,
    loadLedgerStateFromAncilliary,
    streamTablesToUtxo,
    resolveTablesPath,
} from "./state";
import {
    runMithrilBootstrap,
    type MithrilEngine,
} from "./mithril";

/**
 * Mithril snapshot bootstrap (hybrid):
 *   --engine wasm  — list/verify via @mithril-dev/mithril-client-wasm; download via HTTP+zstd+tar
 *   --engine bin   — external mithril-client binary (full multi-GB restore)
 *   --engine auto  — prefer wasm, fall back to bin
 * Then optional processChunk apply into Gerolamo SQLite.
 * Ancillary UTxO extract remains blocked (A2) — see src/state/mithril.ts.
 */
export async function getCbor(dbPath: string, snapshotRoot: string) {
    console.error(
        [
            "Use the optional mithril-bootstrap command instead:",
            "  bun src/index.ts mithril-bootstrap --network preprod --engine wasm --limit-chunks 1 --skip-apply",
            "  bun src/index.ts mithril-bootstrap --network preprod --download-dir ./snapshots/preprod",
            "Or apply already-downloaded chunks:",
            "  bun src/index.ts read-raw-chunks <immutable_dir>",
            `Snapshot root: ${snapshotRoot}`,
            `DB path: ${dbPath}`,
        ].join("\n"),
    );
}

program.name("gerolamo");

export function Main() {
    program
        .command("import-ledger-state")
        .description(
            "Import ledger state from Blockfrost for a specific block",
        )
        .argument(
            "<blockHash>",
            "block hash to import ledger state for",
        )
        .option(
            "--project-id [id]",
            "Blockfrost project ID (optional, uses custom backend if not provided)",
        )
        .option(
            "--custom-backend <url>",
            "Custom Blockfrost backend URL",
            // no default hard-coded URL; use config.blockfrostUrl or explicit arg
        )
        .option(
            "--import-chain",
            "Import chain blocks starting from specified slot",
        )
        .option(
            "--from-slot <number>",
            "Starting slot for chain import",
            parseInt,
        )
        .option("--count <number>", "Number of blocks to import", parseInt)
        .action(async (
            blockHash: string,
            options: {
                dbPath: string;
                projectId?: string;
                customBackend?: string;
                importChain?: boolean;
                fromSlot?: number;
                count?: number;
            },
        ) => {
            await ensureInitialized();
            await initNewEpochState();
            await importFromBlockfrost(blockHash, options);
        });

    program
        .command("start-gerolamo")
        .description(
            "Start the gerolamo node based on config.json settings",
        )
        .action(start);

    program
        .command("read-raw-chunks")
        .description(
            "Bootstrap from Cardano immutable chunk files (primary bootstrap path; Mithril is external)",
        )
        .argument(
            "<immutable_dir>",
            "Directory containing the .primary, .secondary, .chunk files",
        )
        .option(
            "--from-chunk <n>",
            "First chunk number (inclusive)",
            (v) => parseInt(v, 10),
            0,
        )
        .option(
            "--to-chunk <n>",
            "Last chunk number (inclusive); default = max present",
            (v) => parseInt(v, 10),
        )
        .action(
            async (
                immutableDir: string,
                options: { fromChunk?: number; toChunk?: number },
            ) => {
                await ensureInitialized();
                const dir = resolve(immutableDir);

                const logger = new Logger({ logLevel: LogLevel.INFO });
                const names = await readdir(dir);
                const chunkNos = names
                    .map((v) => parseInt(parse(v).name, 10))
                    .filter((n) => Number.isFinite(n) && n >= 0);
                if (chunkNos.length === 0) {
                    throw new Error(`No chunk files found in ${dir}`);
                }
                const maxChunkNo = Math.max(...chunkNos);
                const from = Math.max(0, options.fromChunk ?? 0);
                const to = Math.min(
                    maxChunkNo,
                    options.toChunk ?? maxChunkNo,
                );
                if (from > to) {
                    throw new Error(
                        `Invalid chunk range: from=${from} to=${to} (max=${maxChunkNo})`,
                    );
                }
                logger.info(
                    `read-raw-chunks: dir=${dir} chunks ${from}..${to} (max=${maxChunkNo})`,
                );

                for (let chunkNo = from; chunkNo <= to; chunkNo++) {
                    await processChunk(dir, chunkNo, logger);
                }
            },
        );

    program
        .command("load-ancillary")
        .description("Load ledger state from ancillary LMDB database")
        .argument(
            "<ledger_path>",
            "Path to the ledger directory (e.g., ./db/ledger)",
        )
        .action(async (ledgerPath: string) => {
            await ensureInitialized();
            await loadLedgerStateFromAncilliary(ledgerPath);
        });

    /**
     * A2 partial UTxO extract: stream utxohd-mem tables → SQLite utxo.
     * Inserts tag0/tag2 fully-decoded rows only (datum/script still blocked).
     * Prefer a temp --db for smoke; full apply to .live is opt-in.
     */
    program
        .command("apply-ancillary-utxo")
        .description(
            "Stream Mithril ancillary tables file into SQLite utxo (partial: tag0/2 only)",
        )
        .argument(
            "<ledger_or_tables>",
            "Path to ledger dir (…/ledger/<slot>) or tables file",
        )
        .option(
            "--db <path>",
            "SQLite path (default: temp under /tmp — not .live)",
            process.env.A2_UTXO_DB || "",
        )
        .option(
            "--limit <n>",
            "Max map entries to scan (smoke); omit = full file",
            (v) => parseInt(v, 10),
        )
        .option(
            "--batch-size <n>",
            "Rows per SQLite transaction",
            (v) => parseInt(v, 10),
            2000,
        )
        .action(
            async (
                ledgerOrTables: string,
                options: {
                    db?: string;
                    limit?: number;
                    batchSize?: number;
                },
            ) => {
                const logger = new Logger({ logLevel: LogLevel.INFO });
                const root = resolve(ledgerOrTables);
                // Accept tables file or ledger dir containing tables
                let tablesPath = root;
                try {
                    const { statSync } = await import("node:fs");
                    const st = statSync(root);
                    if (st.isDirectory()) {
                        const resolved = await resolveTablesPath(root);
                        if (!resolved || resolved.kind === "missing") {
                            throw new Error(
                                `no tables file under ledger dir: ${root}`,
                            );
                        }
                        tablesPath = resolved.path;
                    }
                } catch (e) {
                    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
                        throw e;
                    }
                }

                const dbPath = resolve(
                    options.db?.trim() ||
                        process.env.A2_UTXO_DB ||
                        `/tmp/a2-utxo-smoke-${Date.now()}.db`,
                );
                logger.info(`tables=${tablesPath}`);
                logger.info(`db=${dbPath}`);
                if (dbPath.includes(".live/test.db") && options.limit == null) {
                    logger.warn(
                        "Full apply into .live/test.db — single writer; partial UTxO only (tag0/2)",
                    );
                }

                const result = streamTablesToUtxo({
                    tablesPath,
                    dbPath,
                    limit: options.limit,
                    batchSize: options.batchSize ?? 2000,
                    logger: {
                        info: (m) => logger.info(m),
                        warn: (m) => logger.warn(m),
                    },
                });

                logger.info(
                    `apply-ancillary-utxo complete scanned=${result.scanned} ` +
                        `inserted=${result.inserted} skipped=${result.skipped} ` +
                        `errors=${result.decodeErrors} ` +
                        `utxoExtracted=${result.utxoExtracted} partial=${result.partial} ` +
                        `elapsedMs=${result.elapsedMs}`,
                );
                logger.info(
                    `byTag=${JSON.stringify(result.byTag)} insertedByTag=${JSON.stringify(result.insertedByTag)}`,
                );
            },
        );

    /**
     * Optional Mithril bootstrap:
     *   --engine ts    — production: HTTP + pure-TS cert verify (default)
     *   --engine wasm  — debug: IOG WASM verify
     *   --engine both  — ts verify + WASM compare
     *   --engine bin   — external mithril-client binary
     * Then optional processChunk apply into Gerolamo SQLite.
     */
    program
        .command("mithril-bootstrap")
        .description(
            "Download/verify Mithril Cardano DB (pure-TS default; wasm/bin optional), then optionally apply immutable chunks",
        )
        .option(
            "--network <name>",
            "preprod | mainnet (selects aggregator + genesis vkey)",
            process.env.NETWORK || "preprod",
        )
        .option(
            "--download-dir <path>",
            "Directory for snapshot download / extract",
            "./snapshots/mithril",
        )
        .option(
            "--digest <digest>",
            "Snapshot digest/hash (default: latest)",
            "latest",
        )
        .option(
            "--engine <engine>",
            "ts | wasm | both | bin | auto (default: ts)",
            "ts",
        )
        .option(
            "--client <path>",
            "Path to mithril-client binary for --engine bin (or set MITHRIL_CLIENT)",
        )
        .option(
            "--aggregator <url>",
            "Override aggregator endpoint",
        )
        .option(
            "--genesis-vkey <path-or-url>",
            "Genesis verification key file path or HTTPS URL",
        )
        .option(
            "--skip-download",
            "Skip download; only apply chunks already under --download-dir",
        )
        .option(
            "--skip-apply",
            "Only list/verify/download; do not apply chunks to Gerolamo DB",
        )
        .option(
            "--from-chunk <n>",
            "First immutable file number (inclusive)",
            (v) => parseInt(v, 10),
            0,
        )
        .option(
            "--to-chunk <n>",
            "Last immutable file number (inclusive); default = snapshot beacon max",
            (v) => parseInt(v, 10),
        )
        .option(
            "--limit-chunks <n>",
            "Download/apply at most N chunks from --from-chunk (smoke)",
            (v) => parseInt(v, 10),
        )
        .option(
            "--include-ancillary",
            "Also download ancillary ledger archive (probe only — UTxO extract still A2 blocked)",
        )
        .option(
            "--db <path>",
            "SQLite path for apply (default: GEROLAMO_DB_PATH or .live/test.db)",
            process.env.GEROLAMO_DB_PATH || "./.live/test.db",
        )
        .action(
            async (options: {
                network?: string;
                downloadDir?: string;
                digest?: string;
                engine?: string;
                client?: string;
                aggregator?: string;
                genesisVkey?: string;
                skipDownload?: boolean;
                skipApply?: boolean;
                fromChunk?: number;
                toChunk?: number;
                limitChunks?: number;
                includeAncillary?: boolean;
                db?: string;
            }) => {
                const logger = new Logger({ logLevel: LogLevel.INFO });
                const engineRaw = (options.engine || "ts").toLowerCase();
                const engine = (
                    engineRaw === "ts" ||
                        engineRaw === "wasm" ||
                        engineRaw === "bin" ||
                        engineRaw === "both" ||
                        engineRaw === "auto"
                        ? engineRaw
                        : "ts"
                ) as MithrilEngine;

                // Apply path needs DB; download-only does not.
                // Prefer --db / GEROLAMO_DB_PATH / .live/test.db (own Mithril path).
                if (!options.skipApply) {
                    const dbPath = resolve(
                        options.db ||
                            process.env.GEROLAMO_DB_PATH ||
                            "./.live/test.db",
                    );
                    initSql(dbPath);
                    logger.info(`DB: ${getSqlFilename()}`);
                    await ensureInitialized();
                }

                const result = await runMithrilBootstrap(
                    {
                        network: options.network || process.env.NETWORK || "preprod",
                        downloadDir: resolve(
                            options.downloadDir || "./snapshots/mithril",
                        ),
                        digest: options.digest || "latest",
                        engine,
                        clientBin: options.client,
                        aggregator:
                            options.aggregator ||
                            process.env.AGGREGATOR_ENDPOINT,
                        genesisVkey: options.genesisVkey,
                        skipDownload: !!options.skipDownload,
                        skipApply: !!options.skipApply,
                        fromChunk: options.fromChunk,
                        toChunk: options.toChunk,
                        limitChunks: options.limitChunks,
                        includeAncillary: !!options.includeAncillary,
                    },
                    logger,
                );

                logger.info(
                    `mithril-bootstrap complete engine=${result.engine} ` +
                        `verified=${result.verified} snapshot=${result.snapshotHash} ` +
                        `cert=${result.certificateHash} ` +
                        `downloaded=${result.downloadedChunks.length} ` +
                        `applied=${result.appliedChunks.length} ` +
                        `immutable=${result.immutableDir ?? "(none)"} ` +
                        `ancillary=${result.ancillaryDir ?? "(none)"}`,
                );
                if (result.immutableDir && options.skipApply) {
                    logger.info(
                        `Next: bun src/index.ts read-raw-chunks ${result.immutableDir}`,
                    );
                }
                if (result.ancillaryDir) {
                    logger.info(
                        `Ancillary probe only (A2): bun src/index.ts load-ancillary ${result.ancillaryDir}`,
                    );
                }
            },
        );

    program.parse(process.argv);
}

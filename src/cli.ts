import { program } from "commander";
import { registerSettingFlags, settingsMarkdown } from "./config/settings";
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
 *   --engine bin   — external mithril-client binary (full multi-GB restore)
 * Then optional processChunk apply into Gerolamo SQLite.
 * Ancillary UTxO extract remains blocked (A2) — see src/state/mithril.ts.
 */
export async function getCbor(dbPath: string, snapshotRoot: string) {
    console.error(
        [
            "Use the optional mithril-bootstrap command instead:",
            "  bun src/index.ts mithril-bootstrap --network preprod --limit-chunks 1 --skip-apply",
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

    const startCmd = program
        .command("start-gerolamo")
        .description(
            "Start the node. Every setting is a flag here and a config.json key (flag first, then config.json, then the default); see docs/CONFIG.md",
        );
    registerSettingFlags(startCmd);
    startCmd.action((opts: Record<string, unknown>) => start(opts));

    program
        .command("settings-doc")
        .description("Print docs/CONFIG.md: every setting with its flag, config.json key and default")
        .action(() => { console.log(settingsMarkdown()); });

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
            "",
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
     *   --engine bin   — external mithril-client binary
     * Then optional processChunk apply into Gerolamo SQLite.
     */
    program
        .command("extract")
        .description("Parse-only extractor: immutable chunks → explorer (mb_*) database, no ledger rules (PLAN_SNAPSHOT_BOOTSTRAP)")
        .requiredOption("--immutable-dir <dir>", "Directory with the .chunk/.primary/.secondary files")
        .requiredOption("--explorer <path>", "Explorer SQLite file to write (created if missing)")
        .option("--from-chunk <n>", "First chunk (inclusive)", (v) => parseInt(v, 10))
        .option("--to-chunk <n>", "Last chunk (inclusive)", (v) => parseInt(v, 10))
        .option("--workers <n>", "Decoder workers (default: cores − 2)", (v) => parseInt(v, 10))
        .option("--finalize-only", "Only run the finalize pass (spent marks, input-side address rows, cursor)")
        .option("--no-finalize", "Skip the finalize pass")
        .action(async (o: any) => {
            const { runExtract } = await import("./mithril/extract");
            const r = await runExtract({
                immutableDir: o.immutableDir, explorerPath: o.explorer, fromChunk: o.fromChunk, toChunk: o.toChunk, workers: o.workers,
                finalizeOnly: !!o.finalizeOnly, noFinalize: o.finalize === false, log: (m) => console.log(m),
            });
            console.log(`extract: ${r.chunks} chunk(s), ${r.blocks} block(s), ${r.txs} tx(s), ${r.errors} error(s), finalized=${r.finalized}, ${r.seconds.toFixed(1)}s`);
        });

    program
        .command("import-utxo")
        .description("Snapshot bootstrap phase B: a Mithril ancillary `tables` file (utxohd-mem) → the utxo table of a database with our schema")
        .requiredOption("--tables <path>", "ledger/<slot>/tables of the ancillary snapshot")
        .requiredOption("--db <path>", "Target SQLite database (created with our schema if missing)")
        .option("--limit <n>", "Import only the first n entries (testing)", (v) => parseInt(v, 10))
        .option("--batch-size <n>", "Rows per transaction (default 5000)", (v) => parseInt(v, 10))
        .action(async (o: any) => {
            const { initSql } = await import("./sql");
            const { ensureInitialized } = await import("./db");
            initSql(o.db);
            await ensureInitialized();
            const { closeSql } = await import("./sql").then((m: any) => ({ closeSql: m.closeSql ?? (async () => {}) }));
            await closeSql();
            const { importUtxoFromTables } = await import("./mithril/importUtxo");
            const r = await importUtxoFromTables({ tablesPath: o.tables, dbPath: o.db, limit: o.limit, batchSize: o.batchSize, log: (m) => console.log(m) });
            console.log(`import-utxo: ${r.entries} entries, ${r.inserted} rows, ${r.errors} error(s), tags ${JSON.stringify(r.byTag)}, ${r.lovelace} lovelace, ${r.seconds.toFixed(1)}s`);
        });

    program
        .command("import-state")
        .description("Snapshot bootstrap phase C: a Mithril ancillary `state` file (NewEpochState + header state) → the ledger tables of a database with our schema")
        .requiredOption("--state <path>", "ledger/<slot>/state of the ancillary snapshot")
        .requiredOption("--db <path>", "Target SQLite database (created with our schema if missing)")
        .option("--meta <path>", "ledger/<slot>/meta of the snapshot (records the node version)")
        .action(async (o: any) => {
            const { initSql } = await import("./sql");
            const { ensureInitialized } = await import("./db");
            initSql(o.db);
            await ensureInitialized();
            const { closeSql } = await import("./sql").then((m: any) => ({ closeSql: m.closeSql ?? (async () => {}) }));
            await closeSql();
            const { decodeLedgerSnapshot } = await import("./mithril/nesDecoder");
            const { importLedgerState } = await import("./mithril/importState");
            let nodeVersion: string | null = null;
            if (o.meta) { try { nodeVersion = String(JSON.parse(await Bun.file(o.meta).text())?.cardano_node_version ?? "") || null; } catch { /* optional */ } }
            const t0 = performance.now();
            const snapshot = decodeLedgerSnapshot(await Bun.file(o.state).bytes());
            console.log(`import-state: decoded epoch ${snapshot.epoch} slot ${snapshot.slot} in ${((performance.now() - t0) / 1000).toFixed(1)}s${nodeVersion ? ` (node ${nodeVersion})` : ""}`);
            const r = importLedgerState({ dbPath: o.db, snapshot, nodeVersion, log: (m) => console.log(m) });
            console.log(`import-state: done in ${r.seconds.toFixed(1)}s, ${r.warnings.length} warning(s)`);
        });

    program
        .command("mithril-bootstrap")
        .description(
            "Download/verify Mithril Cardano DB (pure-TS; external mithril-client binary optional), then optionally apply immutable chunks",
        )
        .option(
            "--network <name>",
            "preprod | preview | mainnet (selects aggregator + genesis vkey)",
            "preprod",
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
            "ts | bin (default: ts)",
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
            "--progress-file <path>",
            "Progress JSON for the dashboard (default <download-dir>/progress.json)",
        )
        .option(
            "--download-concurrency <n>",
            "Parallel chunk downloads (default 8)",
            (v) => parseInt(v, 10),
        )
        .option(
            "--blocks-only",
            "Store the certified blocks only (block store for scripts/serve-chain.ts); no ledger apply",
        )
        .option(
            "--ledger-state",
            "Snapshot bootstrap: verify the ancillary manifest, store the certified blocks, import the UTxO set and the ledger state (implies --blocks-only --include-ancillary)",
        )
        .option(
            "--ancillary-vkey <key>",
            "Ancillary verification key (hex-of-JSON, file or URL; default: the network's published key)",
        )
        .option(
            "--block-store <dir>",
            "cardano-node-format block store (<nodeDir>/db): the chunks become the store as they are, nothing is applied into SQLite; with --ledger-state the ledger tables are imported and the node's tip pinned to the state's block",
        )
        .option(
            "--ledger <dir>",
            "LMDB ledger directory (<nodeDir>/ledger): with --ledger-state the UTxO set and the ledger state go straight into the store; SQLite gets no ledger tables",
        )
        .option(
            "--db <path>",
            "SQLite path for apply",
            "./.live/test.db",
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
                blocksOnly?: boolean;
                ledgerState?: boolean;
                ancillaryVkey?: string;
                progressFile?: string;
                downloadConcurrency?: number;
                db?: string;
                blockStore?: string;
                ledger?: string;
            }) => {
                const logger = new Logger({ logLevel: LogLevel.INFO });
                const engineRaw = (options.engine || "ts").toLowerCase();
                const engine: MithrilEngine =
                    engineRaw === "bin" ? "bin" : "ts";

                // Apply path needs DB; download-only does not.
                const dbPath = resolve(options.db || "./.live/test.db");
                if (!options.skipApply) {
                    initSql(dbPath);
                    logger.info(`DB: ${getSqlFilename()}`);
                    await ensureInitialized();
                }

                const result = await runMithrilBootstrap(
                    {
                        network: options.network || "preprod",
                        dbPath,
                        downloadDir: resolve(
                            options.downloadDir || "./snapshots/mithril",
                        ),
                        digest: options.digest || "latest",
                        engine,
                        clientBin: options.client,
                        aggregator: options.aggregator,
                        genesisVkey: options.genesisVkey,
                        skipDownload: !!options.skipDownload,
                        skipApply: !!options.skipApply,
                        blockStore: options.blockStore ? resolve(options.blockStore) : undefined,
                        ledger: options.ledger ? resolve(options.ledger) : undefined,
                        fromChunk: options.fromChunk,
                        toChunk: options.toChunk,
                        limitChunks: options.limitChunks,
                        includeAncillary: !!options.includeAncillary || !!options.ledgerState,
                        blocksOnly: !!options.blocksOnly || !!options.ledgerState,
                        ledgerState: !!options.ledgerState,
                        ancillaryVkey: options.ancillaryVkey,
                        progressFile: options.progressFile,
                        downloadConcurrency: options.downloadConcurrency,
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

    program
        .command("mithril-produce")
        .description(
            "Produce cardano-database v2 artifacts (immutable archives, digests, snapshot record) from a chunk store and certify them: the local Merkle root must be the one a real Mithril certificate signed (chain verified to the genesis key). Read-only on the chunk store.",
        )
        .requiredOption("--immutable-dir <dir>", "Chunk store immutable directory (Gerolamo <nodeDir>/db/immutable or cardano-node db/immutable); opened read-only")
        .requiredOption("--out <dir>", "Artifact store directory (served by the node when mithril.serveArtifacts is on)")
        .option("--network <name>", "preprod | preview | mainnet", "preprod")
        .option("--aggregator <url>", "Aggregator to certify against (default: the network's)")
        .option("--genesis-vkey <key-path-or-url>", "Genesis verification key (default: the network's published key)")
        .option("--immutable <n>", "Certified immutable file number to produce (default: the newest one the store has complete)", (v) => parseInt(v, 10))
        .option("--archive-from <n>", "First immutable archive to build (default 0)", (v) => parseInt(v, 10))
        .option("--archive-to <n>", "Last immutable archive to build (default: the beacon)", (v) => parseInt(v, 10))
        .action(async (options: { immutableDir: string; out: string; network: string; aggregator?: string; genesisVkey?: string; immutable?: number; archiveFrom?: number; archiveTo?: number }) => {
            const { produceCertifiedSnapshot } = await import("./mithril/cdb/certify");
            const { ArtifactStore } = await import("./mithril/cdb/store");
            const r = await produceCertifiedSnapshot({
                immutableDir: resolve(options.immutableDir),
                store: new ArtifactStore(resolve(options.out)),
                network: options.network,
                aggregator: options.aggregator,
                genesisVkey: options.genesisVkey,
                immutable: options.immutable,
                archiveRange: options.archiveFrom != null || options.archiveTo != null ? { from: options.archiveFrom ?? 0, to: options.archiveTo ?? Number.MAX_SAFE_INTEGER } : undefined,
                log: (m) => console.log(m),
            });
            console.log(
                `mithril-produce: snapshot ${r.snapshot.hash} e${r.snapshot.beacon.epoch}/i${r.snapshot.beacon.immutable_file_number} ` +
                    `merkle root ${r.merkleRoot} certified by ${r.target.certificate.hash} ` +
                    `(${r.digests.length} files, ${r.archivesWritten} archives written, ${r.archivesReused} reused, ${r.seconds.toFixed(1)} s)`,
            );
        });

    program.parse(process.argv);
}

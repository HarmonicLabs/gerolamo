import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { ensureInitialized } from "./db";

import { start } from "./network";

import { Logger, LogLevel } from "./utils/logger";
import { parse, resolve } from "node:path";
import { readdir, access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { processChunk, loadLedgerStateFromAncilliary } from "./state";

/**
 * Mithril snapshot download/verify uses the external `mithril-client` binary.
 * Gerolamo does not reimplement cert verification — it orchestrates the client
 * then applies immutable chunks via read-raw-chunks.
 */
export async function getCbor(dbPath: string, snapshotRoot: string) {
    console.error(
        [
            "Use the optional mithril-bootstrap command instead:",
            "  bun src/index.ts mithril-bootstrap --network preprod --download-dir ./snapshots/preprod",
            "Or apply already-downloaded chunks:",
            "  bun src/index.ts read-raw-chunks <immutable_dir>",
            `Snapshot root: ${snapshotRoot}`,
            `DB path: ${dbPath}`,
        ].join("\n"),
    );
}

/** Resolve mithril-client binary: MITHRIL_CLIENT env, then PATH. */
function resolveMithrilClient(explicit?: string): string | null {
    if (explicit && existsSync(explicit)) return explicit;
    const envPath = process.env.MITHRIL_CLIENT;
    if (envPath && existsSync(envPath)) return envPath;
    // which-style: check PATH
    const pathEnv = process.env.PATH || "";
    for (const dir of pathEnv.split(":")) {
        const candidate = resolve(dir, "mithril-client");
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function networkToAggregator(network: string): {
    aggregator: string;
    genesisVkeyUrl: string;
    runMode: string;
} {
    const n = network.toLowerCase();
    if (n === "mainnet") {
        return {
            aggregator:
                "https://aggregator.release-mainnet.api.mithril.network/aggregator",
            genesisVkeyUrl:
                "https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/release-mainnet/genesis.vkey",
            runMode: "release-mainnet",
        };
    }
    // preprod / testnet default
    return {
        aggregator:
            "https://aggregator.release-preprod.api.mithril.network/aggregator",
        genesisVkeyUrl:
            "https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/release-preprod/genesis.vkey",
        runMode: "release-preprod",
    };
}

async function runCmd(
    cmd: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
): Promise<number> {
    return new Promise((resolveExit, reject) => {
        const child = spawn(cmd, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: "inherit",
        });
        child.on("error", reject);
        child.on("close", (code) => resolveExit(code ?? 1));
    });
}

/** Find db/immutable under downloadDir (mithril-client layout varies). */
async function findImmutableDir(root: string): Promise<string | null> {
    const candidates = [
        resolve(root, "db", "immutable"),
        resolve(root, "immutable"),
        resolve(root, "db"),
    ];
    for (const c of candidates) {
        try {
            await access(c, fsConstants.R_OK);
            const names = await readdir(c);
            if (names.some((n) => /\.(chunk|primary|secondary)$/.test(n) || /^\d+$/.test(parse(n).name))) {
                // if this is db/, prefer db/immutable if present
                if (c.endsWith(`${"/"}db`) || c.endsWith("\\db")) {
                    const imm = resolve(c, "immutable");
                    try {
                        await access(imm, fsConstants.R_OK);
                        return imm;
                    } catch {
                        /* fall through */
                    }
                }
                return c;
            }
        } catch {
            /* try next */
        }
    }
    // shallow walk one level
    try {
        const top = await readdir(root, { withFileTypes: true });
        for (const ent of top) {
            if (!ent.isDirectory()) continue;
            const found = await findImmutableDir(resolve(root, ent.name));
            if (found) return found;
        }
    } catch {
        /* ignore */
    }
    return null;
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
     * Optional Mithril bootstrap — wraps external mithril-client, then applies
     * immutable chunks into Gerolamo SQLite via processChunk.
     *
     * Honesty: Gerolamo does NOT reimplement Mithril cert verification.
     * Requires `mithril-client` on PATH (or --client / MITHRIL_CLIENT).
     */
    program
        .command("mithril-bootstrap")
        .description(
            "Optional: download Mithril Cardano DB via mithril-client, then apply immutable chunks",
        )
        .option(
            "--network <name>",
            "preprod | mainnet (selects aggregator + genesis vkey)",
            process.env.NETWORK || "preprod",
        )
        .option(
            "--download-dir <path>",
            "Directory for mithril-client download",
            "./snapshots/mithril",
        )
        .option(
            "--digest <digest>",
            "Snapshot digest (default: latest)",
            "latest",
        )
        .option(
            "--client <path>",
            "Path to mithril-client binary (or set MITHRIL_CLIENT)",
        )
        .option(
            "--aggregator <url>",
            "Override AGGREGATOR_ENDPOINT",
        )
        .option(
            "--genesis-vkey <path-or-url>",
            "Genesis verification key file path or HTTPS URL",
        )
        .option(
            "--skip-download",
            "Skip mithril-client download; only apply chunks from --download-dir",
        )
        .option(
            "--skip-apply",
            "Only download/verify; do not apply chunks to Gerolamo DB",
        )
        .option(
            "--from-chunk <n>",
            "First chunk to apply (inclusive)",
            (v) => parseInt(v, 10),
            0,
        )
        .option(
            "--to-chunk <n>",
            "Last chunk to apply (inclusive); default = max present",
            (v) => parseInt(v, 10),
        )
        .action(
            async (options: {
                network?: string;
                downloadDir?: string;
                digest?: string;
                client?: string;
                aggregator?: string;
                genesisVkey?: string;
                skipDownload?: boolean;
                skipApply?: boolean;
                fromChunk?: number;
                toChunk?: number;
            }) => {
                const logger = new Logger({ logLevel: LogLevel.INFO });
                const network = (options.network || "preprod").toLowerCase();
                const downloadDir = resolve(
                    options.downloadDir || "./snapshots/mithril",
                );
                const netCfg = networkToAggregator(network);
                const aggregator =
                    options.aggregator ||
                    process.env.AGGREGATOR_ENDPOINT ||
                    netCfg.aggregator;
                const digest = options.digest || "latest";

                await mkdir(downloadDir, { recursive: true });

                if (!options.skipDownload) {
                    const clientBin = resolveMithrilClient(options.client);
                    if (!clientBin) {
                        console.error(
                            [
                                "mithril-client binary not found.",
                                "Install: https://mithril.network/doc/manual/getting-started/bootstrap-cardano-node",
                                "  curl --proto '=https' --tlsv1.2 -sSf \\",
                                "    https://raw.githubusercontent.com/input-output-hk/mithril/refs/heads/main/mithril-install.sh \\",
                                "    | sh -s -- -c mithril-client -d latest -p $HOME/.local/bin",
                                "Or pass --client /path/to/mithril-client / set MITHRIL_CLIENT.",
                                "Or use --skip-download with an existing snapshot and apply chunks only.",
                            ].join("\n"),
                        );
                        process.exitCode = 1;
                        return;
                    }

                    // Resolve genesis verification key
                    let genesisKey = process.env.GENESIS_VERIFICATION_KEY || "";
                    const gvk = options.genesisVkey || netCfg.genesisVkeyUrl;
                    if (gvk.startsWith("http://") || gvk.startsWith("https://")) {
                        logger.info(`Fetching genesis vkey from ${gvk}`);
                        const res = await fetch(gvk);
                        if (!res.ok) {
                            throw new Error(
                                `Failed to fetch genesis vkey: HTTP ${res.status}`,
                            );
                        }
                        genesisKey = (await res.text()).trim();
                    } else if (existsSync(gvk)) {
                        genesisKey = (
                            await Bun.file(gvk).text()
                        ).trim();
                    } else if (!genesisKey) {
                        throw new Error(
                            `Genesis vkey not found at ${gvk}; set --genesis-vkey or GENESIS_VERIFICATION_KEY`,
                        );
                    }

                    logger.info(
                        `mithril-bootstrap: client=${clientBin} network=${network} digest=${digest}`,
                    );
                    logger.info(`  aggregator=${aggregator}`);
                    logger.info(`  download-dir=${downloadDir}`);

                    // Prefer cardano-db download (v1); try cdb alias path used by recent clients.
                    // Layout: mithril-client cardano-db download <digest> --download-dir <dir>
                    const env = {
                        AGGREGATOR_ENDPOINT: aggregator,
                        GENESIS_VERIFICATION_KEY: genesisKey,
                    };
                    const args = [
                        "cardano-db",
                        "download",
                        digest,
                        "--download-dir",
                        downloadDir,
                    ];
                    logger.info(
                        `Running: ${clientBin} ${args.join(" ")}`,
                    );
                    const code = await runCmd(
                        clientBin,
                        args,
                        env,
                        downloadDir,
                    );
                    if (code !== 0) {
                        // Fallback: older CLI used `cardano-db snapshot download`
                        logger.info(
                            "cardano-db download failed; trying cardano-db snapshot download…",
                        );
                        const args2 = [
                            "cardano-db",
                            "snapshot",
                            "download",
                            digest,
                            "--download-dir",
                            downloadDir,
                        ];
                        const code2 = await runCmd(
                            clientBin,
                            args2,
                            env,
                            downloadDir,
                        );
                        if (code2 !== 0) {
                            throw new Error(
                                `mithril-client exited ${code2}. Check aggregator/genesis and client version.`,
                            );
                        }
                    }
                    logger.info("mithril-client download finished");
                } else {
                    logger.info(
                        `mithril-bootstrap: --skip-download; using ${downloadDir}`,
                    );
                }

                if (options.skipApply) {
                    logger.info(
                        "mithril-bootstrap: --skip-apply; not applying chunks",
                    );
                    const imm = await findImmutableDir(downloadDir);
                    if (imm) {
                        logger.info(`Immutable dir ready: ${imm}`);
                        logger.info(
                            `Next: bun src/index.ts read-raw-chunks ${imm}`,
                        );
                    } else {
                        logger.info(
                            "Could not locate immutable/ under download dir — inspect manually",
                        );
                    }
                    return;
                }

                await ensureInitialized();
                const immutableDir = await findImmutableDir(downloadDir);
                if (!immutableDir) {
                    throw new Error(
                        `No immutable chunk dir found under ${downloadDir}. ` +
                            `Use --skip-apply and inspect, or pass chunks to read-raw-chunks.`,
                    );
                }
                logger.info(`Applying chunks from ${immutableDir}`);

                const names = await readdir(immutableDir);
                const chunkNos = names
                    .map((v) => parseInt(parse(v).name, 10))
                    .filter((n) => Number.isFinite(n) && n >= 0);
                if (chunkNos.length === 0) {
                    throw new Error(
                        `No chunk files found in ${immutableDir}`,
                    );
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
                    `mithril-bootstrap apply: chunks ${from}..${to} (max=${maxChunkNo})`,
                );
                for (let chunkNo = from; chunkNo <= to; chunkNo++) {
                    await processChunk(immutableDir, chunkNo, logger);
                }
                logger.info("mithril-bootstrap complete");
            },
        );

    program.parse(process.argv);
}

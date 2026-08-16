/**
 * Mithril bootstrap orchestrator.
 *
 * Engine paths:
 *   ts   — production: HTTP list/get + pure-TS cert-chain verify;
 *          download via HTTP + fzstd/tar-stream
 *   wasm — debug: list/verify via @mithril-dev/mithril-client-wasm
 *   both — ts verify required, then WASM compare (debug)
 *   bin  — external mithril-client (full multi-GB restore)
 *   auto — ts
 */

import { mkdir, readdir } from "node:fs/promises";
import { parse, resolve } from "node:path";

import { processChunk } from "../state";
import { probeAncillaryLedger } from "../state/mithril";
import type { Logger } from "../utils/logger";
import {
    createMithrilClient,
    fetchGenesisVkey,
    networkConfig,
    selectSnapshot,
} from "./client";
import { createTsMithrilClient } from "./httpClient";
import { dualRunCertificateChain } from "./dualRun";
import { persistMithrilCertificate } from "./certStore";
import {
    downloadAncillary,
    downloadImmutableRange,
    findAncillaryLedgerDir,
    findImmutableDir,
    resolveMithrilClientBin,
    runMithrilClientBin,
} from "./download";
import type {
    MithrilBootstrapOptions,
    MithrilBootstrapResult,
    MithrilEngine,
} from "./types";

function logInfo(logger: Logger | undefined, msg: string): void {
    if (logger?.info) logger.info(msg);
    else console.log(msg);
}

function logWarn(logger: Logger | undefined, msg: string): void {
    if (logger?.warn) logger.warn(msg);
    else console.warn(msg);
}

async function applyChunkRange(
    immutableDir: string,
    from: number,
    to: number,
    logger: Logger,
): Promise<number[]> {
    const applied: number[] = [];
    for (let n = from; n <= to; n++) {
        await processChunk(immutableDir, n, logger);
        applied.push(n);
    }
    return applied;
}

/** Discover chunk numbers present on disk under immutableDir. */
async function listPresentChunks(immutableDir: string): Promise<number[]> {
    const names = await readdir(immutableDir);
    const set = new Set<number>();
    for (const n of names) {
        const base = parse(n).name;
        const num = parseInt(base, 10);
        if (Number.isFinite(num) && num >= 0) set.add(num);
    }
    return [...set].sort((a, b) => a - b);
}

async function runTsBootstrap(
    opts: MithrilBootstrapOptions,
    logger: Logger,
    compareWasm: boolean,
): Promise<MithrilBootstrapResult> {
    const cfg = networkConfig(opts.network);
    const aggregator = opts.aggregator || cfg.aggregator;
    const engine: MithrilEngine = compareWasm ? "both" : "ts";

    logInfo(logger, `mithril-bootstrap engine=${engine} aggregator=${aggregator}`);

    const client = await createTsMithrilClient({
        network: opts.network,
        aggregator,
        genesisVkey: opts.genesisVkey,
        genesisVkeyUrl: opts.genesisVkey ? undefined : cfg.genesisVkeyUrl,
    });

    logInfo(logger, "Listing Cardano DB snapshots (HTTP)…");
    const list = await client.listCardanoDatabaseV2();
    const selected = selectSnapshot(list, opts.digest);
    logInfo(
        logger,
        `Selected snapshot hash=${selected.hash} epoch=${selected.beacon.epoch} ` +
            `immutable_file_number=${selected.beacon.immutable_file_number} ` +
            `size≈${selected.total_db_size_uncompressed}`,
    );

    logInfo(
        logger,
        `Verifying certificate chain (pure-TS) cert=${selected.certificate_hash}…`,
    );
    const { cert, pureTs } = await client.verifyCertificateChain(
        selected.certificate_hash,
    );
    logInfo(
        logger,
        `Certificate chain OK (pure-TS) cert.hash=${cert.hash} ` +
            `epoch=${cert.epoch ?? "?"} reason=${pureTs.reason}`,
    );

    if (compareWasm) {
        logInfo(logger, "Debug compare: WASM dual-run…");
        const wasm = await createMithrilClient({
            network: opts.network,
            aggregator,
            genesisVkey: client.genesisVkey,
        });
        try {
            const dual = await dualRunCertificateChain(
                wasm,
                selected.certificate_hash,
                {
                    fetcher: (h) => client.fetchCertificate(h),
                    genesisVkey: client.genesisVkey,
                    runChainWalk: true,
                },
            );
            logInfo(
                logger,
                `WASM compare match=${dual.match} wasmOk=${dual.wasm.ok} ` +
                    `error=${dual.wasm.error ?? "none"}`,
            );
            if (!dual.match) {
                logWarn(
                    logger,
                    "WASM compare diverged — production still accepted the pure-TS result",
                );
            }
        } finally {
            wasm.free();
        }
    }

    try {
        await persistMithrilCertificate(cert, {
            network: opts.network,
            wasmOk: compareWasm ? undefined : false,
            stagesOk: true,
            source: "mithril-bootstrap-ts",
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(logger, `Certificate persist failed (non-fatal): ${msg}`);
    }

    const downloadDir = resolve(opts.downloadDir);
    await mkdir(downloadDir, { recursive: true });

    let immutableDir: string | null = null;
    let ancillaryDir: string | null = null;
    let downloaded: number[] = [];
    let detail: Awaited<ReturnType<typeof client.getCardanoDatabaseV2>> | null =
        null;

    const maxBeacon = selected.beacon.immutable_file_number;
    let from = Math.max(0, opts.fromChunk ?? 0);
    let to = Math.min(maxBeacon, opts.toChunk ?? maxBeacon);
    if (opts.limitChunks != null && opts.limitChunks > 0) {
        to = Math.min(to, from + opts.limitChunks - 1);
    }
    if (from > to) {
        throw new Error(
            `Invalid chunk range from=${from} to=${to} (beacon max=${maxBeacon})`,
        );
    }

    if (opts.skipDownload) {
        logInfo(logger, `--skip-download; scanning ${downloadDir}`);
        immutableDir = await findImmutableDir(downloadDir);
        if (!immutableDir) {
            throw new Error(
                `No immutable/ under ${downloadDir}. Drop --skip-download or point --download-dir at a snapshot.`,
            );
        }
        ancillaryDir = await findAncillaryLedgerDir(downloadDir);
    } else {
        logInfo(logger, `Fetching snapshot detail for locations…`);
        detail = await client.getCardanoDatabaseV2(selected.hash);
        logInfo(
            logger,
            `Downloading immutable chunks ${from}..${to} → ${downloadDir}`,
        );
        const r = await downloadImmutableRange({
            snapshot: detail,
            downloadDir,
            fromChunk: from,
            toChunk: to,
            log: (m) => logInfo(logger, m),
        });
        immutableDir = r.immutableDir;
        downloaded = r.downloaded;

        if (opts.includeAncillary) {
            logInfo(
                logger,
                "Downloading ancillary ledger snapshot (--include-ancillary)…",
            );
            try {
                const anc = await downloadAncillary({
                    snapshot: detail,
                    downloadDir,
                    log: (m) => logInfo(logger, m),
                });
                ancillaryDir = anc.ancillaryDir;
                logInfo(
                    logger,
                    `Ancillary landed at ${ancillaryDir} (${(anc.bytes / 1e6).toFixed(1)} MB raw archive)`,
                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logWarn(
                    logger,
                    `Ancillary download failed (UTxO still A2 blocked): ${msg}`,
                );
            }
        }
    }

    if (ancillaryDir) {
        try {
            const probe = await probeAncillaryLedger(ancillaryDir, {
                log: (m) => logInfo(logger, m),
            });
            logInfo(
                logger,
                `Ancillary probe: utxoExtracted=${probe.utxoExtracted} ` +
                    `state=${probe.stateShape?.kind ?? "?"} ` +
                    `tvar=${probe.files.tvar.exists}(${probe.files.tvar.size})`,
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logWarn(logger, `Ancillary probe failed: ${msg}`);
        }
    }

    let applied: number[] = [];
    if (opts.skipApply) {
        logInfo(
            logger,
            `--skip-apply; immutable ready at ${immutableDir ?? "(none)"}`,
        );
    } else if (immutableDir) {
        const present = await listPresentChunks(immutableDir);
        const targets = present.filter((n) => n >= from && n <= to);
        if (targets.length === 0) {
            throw new Error(
                `No chunk files in range ${from}..${to} under ${immutableDir}`,
            );
        }
        logInfo(
            logger,
            `Applying ${targets.length} chunks from ${immutableDir}…`,
        );
        for (const n of targets) {
            await processChunk(immutableDir, n, logger);
            applied.push(n);
        }
    }

    return {
        engine,
        snapshotHash: selected.hash,
        certificateHash: selected.certificate_hash,
        immutableDir,
        ancillaryDir,
        downloadedChunks: downloaded,
        appliedChunks: applied,
        verified: true,
    };
}

async function runWasmBootstrap(
    opts: MithrilBootstrapOptions,
    logger: Logger,
): Promise<MithrilBootstrapResult> {
    // pure-TS extract (fzstd + tar-stream) — no system zstd/tar required
    const cfg = networkConfig(opts.network);
    const aggregator = opts.aggregator || cfg.aggregator;

    logInfo(logger, `mithril-bootstrap engine=wasm aggregator=${aggregator}`);

    const client = await createMithrilClient({
        network: opts.network,
        aggregator,
        genesisVkey: opts.genesisVkey,
        genesisVkeyUrl: opts.genesisVkey ? undefined : cfg.genesisVkeyUrl,
    });

    try {
        logInfo(logger, "Listing Cardano DB snapshots (WASM)…");
        const list = await client.listCardanoDatabaseV2();
        const selected = selectSnapshot(list, opts.digest);
        logInfo(
            logger,
            `Selected snapshot hash=${selected.hash} epoch=${selected.beacon.epoch} ` +
                `immutable_file_number=${selected.beacon.immutable_file_number} ` +
                `size≈${selected.total_db_size_uncompressed}`,
        );

        logInfo(
            logger,
            `Verifying certificate chain cert=${selected.certificate_hash}…`,
        );
        const cert = await client.verifyCertificateChain(
            selected.certificate_hash,
        );
        logInfo(
            logger,
            `Certificate chain OK cert.hash=${cert.hash} epoch=${cert.epoch ?? "?"}`,
        );
        // Audit trail: persist verified tip cert (WASM verdict; not SoT cutover)
        try {
            await persistMithrilCertificate(cert, {
                network: opts.network,
                wasmOk: true,
                source: "mithril-bootstrap",
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logWarn(logger, `Certificate persist failed (non-fatal): ${msg}`);
        }

        const downloadDir = resolve(opts.downloadDir);
        await mkdir(downloadDir, { recursive: true });

        let immutableDir: string | null = null;
        let ancillaryDir: string | null = null;
        let downloaded: number[] = [];
        let detail: Awaited<
            ReturnType<typeof client.getCardanoDatabaseV2>
        > | null = null;

        const maxBeacon = selected.beacon.immutable_file_number;
        let from = Math.max(0, opts.fromChunk ?? 0);
        let to = Math.min(maxBeacon, opts.toChunk ?? maxBeacon);
        if (opts.limitChunks != null && opts.limitChunks > 0) {
            to = Math.min(to, from + opts.limitChunks - 1);
        }
        if (from > to) {
            throw new Error(
                `Invalid chunk range from=${from} to=${to} (beacon max=${maxBeacon})`,
            );
        }

        if (opts.skipDownload) {
            logInfo(logger, `--skip-download; scanning ${downloadDir}`);
            immutableDir = await findImmutableDir(downloadDir);
            if (!immutableDir) {
                throw new Error(
                    `No immutable/ under ${downloadDir}. Drop --skip-download or point --download-dir at a snapshot.`,
                );
            }
            ancillaryDir = await findAncillaryLedgerDir(downloadDir);
        } else {
            logInfo(logger, `Fetching snapshot detail for locations…`);
            detail = await client.getCardanoDatabaseV2(selected.hash);
            logInfo(
                logger,
                `Downloading immutable chunks ${from}..${to} → ${downloadDir}`,
            );
            const r = await downloadImmutableRange({
                snapshot: detail,
                downloadDir,
                fromChunk: from,
                toChunk: to,
                log: (m) => logInfo(logger, m),
            });
            immutableDir = r.immutableDir;
            downloaded = r.downloaded;

            // Phase 3: optional ancillary download (files only — UTxO A2 blocked)
            if (opts.includeAncillary) {
                logInfo(
                    logger,
                    "Downloading ancillary ledger snapshot (--include-ancillary)…",
                );
                try {
                    const anc = await downloadAncillary({
                        snapshot: detail,
                        downloadDir,
                        log: (m) => logInfo(logger, m),
                    });
                    ancillaryDir = anc.ancillaryDir;
                    logInfo(
                        logger,
                        `Ancillary landed at ${ancillaryDir} (${(anc.bytes / 1e6).toFixed(1)} MB raw archive)`,
                    );
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    logWarn(
                        logger,
                        `Ancillary download failed (UTxO still A2 blocked): ${msg}`,
                    );
                }
            }
        }

        // Safe probe only — never inserts UTxO
        if (ancillaryDir) {
            try {
                const probe = await probeAncillaryLedger(ancillaryDir, {
                    log: (m) => logInfo(logger, m),
                });
                logInfo(
                    logger,
                    `Ancillary probe: utxoExtracted=${probe.utxoExtracted} ` +
                        `state=${probe.stateShape?.kind ?? "?"} ` +
                        `tvar=${probe.files.tvar.exists}(${probe.files.tvar.size})`,
                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logWarn(logger, `Ancillary probe failed: ${msg}`);
            }
        }

        let applied: number[] = [];
        if (opts.skipApply) {
            logInfo(
                logger,
                `--skip-apply; immutable ready at ${immutableDir ?? "(none)"}`,
            );
        } else if (immutableDir) {
            // If we skipped download, apply present chunks in range
            const present = await listPresentChunks(immutableDir);
            const targets = present.filter((n) => n >= from && n <= to);
            if (targets.length === 0) {
                throw new Error(
                    `No chunk files in range ${from}..${to} under ${immutableDir}`,
                );
            }
            logInfo(
                logger,
                `Applying ${targets.length} chunks from ${immutableDir}…`,
            );
            for (const n of targets) {
                await processChunk(immutableDir, n, logger);
                applied.push(n);
            }
        }

        return {
            engine: "wasm",
            snapshotHash: selected.hash,
            certificateHash: selected.certificate_hash,
            immutableDir,
            ancillaryDir,
            downloadedChunks: downloaded,
            appliedChunks: applied,
            verified: true,
        };
    } finally {
        client.free();
    }
}

async function runBinBootstrap(
    opts: MithrilBootstrapOptions,
    logger: Logger,
): Promise<MithrilBootstrapResult> {
    const cfg = networkConfig(opts.network);
    const aggregator = opts.aggregator || cfg.aggregator;
    const downloadDir = resolve(opts.downloadDir);
    await mkdir(downloadDir, { recursive: true });

    const clientBin = resolveMithrilClientBin(opts.clientBin);
    if (!clientBin && !opts.skipDownload) {
        throw new Error(
            [
                "mithril-client binary not found.",
                "Install: https://mithril.network/doc/manual/getting-started/bootstrap-cardano-node",
                "  curl --proto '=https' --tlsv1.2 -sSf \\",
                "    https://raw.githubusercontent.com/input-output-hk/mithril/refs/heads/main/mithril-install.sh \\",
                "    | sh -s -- -c mithril-client -d latest -p $HOME/.local/bin",
                "Or pass --client /path/to/mithril-client / set MITHRIL_CLIENT.",
                "Or use --engine wasm (no external binary).",
            ].join("\n"),
        );
    }

    let genesisKey = opts.genesisVkey?.trim() || "";
    if (!genesisKey && process.env.GENESIS_VERIFICATION_KEY?.trim()) {
        genesisKey = process.env.GENESIS_VERIFICATION_KEY.trim();
    }
    if (!genesisKey) {
        genesisKey = await fetchGenesisVkey(cfg.genesisVkeyUrl);
    }

    if (!opts.skipDownload && clientBin) {
        logInfo(
            logger,
            `mithril-bootstrap engine=bin client=${clientBin} digest=${opts.digest || "latest"}`,
        );
        await runMithrilClientBin({
            clientBin,
            aggregator,
            genesisKey,
            digest: opts.digest || "latest",
            downloadDir,
            log: (m) => logInfo(logger, m),
        });
    } else {
        logInfo(logger, `--skip-download; using ${downloadDir}`);
    }

    const immutableDir = await findImmutableDir(downloadDir);
    if (!immutableDir) {
        throw new Error(
            `No immutable chunk dir found under ${downloadDir}. Inspect download or use --engine wasm.`,
        );
    }
    logInfo(logger, `Immutable dir: ${immutableDir}`);

    let applied: number[] = [];
    if (opts.skipApply) {
        logInfo(logger, `--skip-apply; not applying chunks`);
    } else {
        const present = await listPresentChunks(immutableDir);
        if (present.length === 0) {
            throw new Error(`No chunk files in ${immutableDir}`);
        }
        let from = Math.max(0, opts.fromChunk ?? Math.min(...present));
        let to = Math.min(
            Math.max(...present),
            opts.toChunk ?? Math.max(...present),
        );
        if (opts.limitChunks != null && opts.limitChunks > 0) {
            to = Math.min(to, from + opts.limitChunks - 1);
        }
        const targets = present.filter((n) => n >= from && n <= to);
        logInfo(logger, `Applying chunks ${targets[0]}..${targets[targets.length - 1]} (${targets.length})`);
        for (const n of targets) {
            await processChunk(immutableDir, n, logger);
            applied.push(n);
        }
    }

    const ancillaryDir = await findAncillaryLedgerDir(downloadDir);
    if (ancillaryDir) {
        logInfo(logger, `Ancillary ledger dir (bin layout): ${ancillaryDir}`);
        try {
            await probeAncillaryLedger(ancillaryDir, {
                log: (m) => logInfo(logger, m),
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logWarn(logger, `Ancillary probe failed: ${msg}`);
        }
    } else if (opts.includeAncillary) {
        logWarn(
            logger,
            "--include-ancillary: bin engine relies on mithril-client layout; no ledger/ found under download-dir",
        );
    }

    return {
        engine: "bin",
        snapshotHash: opts.digest || "latest",
        certificateHash: "(verified-by-mithril-client-bin)",
        immutableDir,
        ancillaryDir,
        downloadedChunks: [],
        appliedChunks: applied,
        // Binary performs cert verify internally; we don't re-verify in-process.
        verified: !opts.skipDownload,
    };
}

/**
 * Run Mithril bootstrap with selected engine.
 */
export async function runMithrilBootstrap(
    opts: MithrilBootstrapOptions,
    logger: Logger,
): Promise<MithrilBootstrapResult> {
    const engine: MithrilEngine = opts.engine || "ts";
    const downloadDir = resolve(opts.downloadDir);
    await mkdir(downloadDir, { recursive: true });

    if (engine === "bin") {
        return runBinBootstrap(opts, logger);
    }
    if (engine === "wasm") {
        return runWasmBootstrap(opts, logger);
    }
    if (engine === "both") {
        return runTsBootstrap(opts, logger, true);
    }
    // ts | auto
    return runTsBootstrap(opts, logger, false);
}

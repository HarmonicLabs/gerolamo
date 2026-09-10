/**
 * Mithril bootstrap orchestrator.
 *
 * Engine paths:
 *   ts   — production: HTTP list/get + pure-TS cert-chain verify;
 *          download via HTTP + fzstd/tar-stream
 *   bin  — external mithril-client (full multi-GB restore)
 */

import { mkdir, readdir } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

import { processChunk } from "../state";
import { writeMithrilProgress, type MithrilProgress } from "./progress";
import { epochForSlot, setEpochNetwork } from "../utils/epochFromSlotCalculations";
import { probeAncillaryLedger } from "../state/mithril";
import { ANCILLARY_VKEYS, verifyAncillary } from "./ancillaryManifest";
import type { Logger } from "../utils/logger";
import {
    fetchGenesisVkey,
    networkConfig,
    selectSnapshot,
} from "./client";
import { createTsMithrilClient } from "./httpClient";
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
    blocksOnly = false,
): Promise<number[]> {
    const applied: number[] = [];
    for (let n = from; n <= to; n++) {
        await processChunk(immutableDir, n, logger, undefined, { blocksOnly });
        applied.push(n);
    }
    return applied;
}

/**
 * Snapshot bootstrap, ledger side: refuse an ancillary set whose manifest does not verify
 * (SHA-256 of every file + the aggregator's Ed25519 signature over the manifest), then fill the
 * UTxO table from `tables` and every other ledger table from `state` (docs/PLAN_SNAPSHOT_BOOTSTRAP.md
 * phases B–D). The chunk store must already hold the blocks up to the snapshot slot.
 */
async function importLedgerStateFromAncillary(a: { downloadDir: string; ancillaryDir: string; network: string; vkey?: string; logger: Logger; prog: (p: Partial<MithrilProgress>) => void }): Promise<void> {
    const { logger } = a;
    const vkeyRaw = a.vkey ? (a.vkey.startsWith("http") || a.vkey.includes("/") ? await fetchGenesisVkey(a.vkey) : a.vkey) : ANCILLARY_VKEYS[a.network];
    if (!vkeyRaw) throw new Error(`--ledger-state: no ancillary verification key known for network ${a.network} (pass --ancillary-vkey)`);
    a.prog({ phase: "apply", message: "verifying the ancillary manifest" });
    const v = await verifyAncillary(a.downloadDir, vkeyRaw, (m) => logInfo(logger, m));
    if (!v.ok) throw new Error(`ancillary verification failed: ${v.errors.join("; ")}`);
    const slots = (await readdir(a.ancillaryDir)).filter((n) => /^\d+$/.test(n)).map(Number).sort((x, y) => x - y);
    const slot = slots[slots.length - 1];
    if (slot == null) throw new Error(`--ledger-state: no ledger/<slot> under ${a.ancillaryDir}`);
    const ledgerDir = join(a.ancillaryDir, String(slot));
    const dbPath = process.env.GEROLAMO_DB_PATH;
    if (!dbPath) throw new Error("--ledger-state: GEROLAMO_DB_PATH unset");
    const { closeSql } = await import("../sql");
    await closeSql(); // the importers write through their own bun:sqlite connection
    const { importUtxoFromTables } = await import("./importUtxo");
    const { decodeLedgerSnapshot } = await import("./nesDecoder");
    const { importLedgerState } = await import("./importState");
    a.prog({ phase: "apply", message: `importing the UTxO set at slot ${slot}` });
    const u = await importUtxoFromTables({ tablesPath: join(ledgerDir, "tables"), dbPath, log: (m) => logInfo(logger, m) });
    logInfo(logger, `UTxO import: ${u.inserted} rows, ${u.errors} error(s), ${u.seconds.toFixed(1)}s`);
    if (u.errors) throw new Error(`UTxO import: ${u.errors} error(s)`);
    let nodeVersion: string | null = null;
    try { nodeVersion = String(JSON.parse(await Bun.file(join(ledgerDir, "meta")).text())?.cardano_node_version ?? "") || null; } catch { /* optional */ }
    a.prog({ phase: "apply", message: `importing the ledger state at slot ${slot}` });
    const snapshot = decodeLedgerSnapshot(await Bun.file(join(ledgerDir, "state")).bytes());
    const r = importLedgerState({ dbPath, snapshot, nodeVersion, log: (m) => logInfo(logger, m) });
    for (const w of r.warnings) logWarn(logger, `import-state: ${w}`);
    // The chunk store may run past the state's slot (the last chunk holds blocks the state
    // does not include): drop them — the node fetches them again and applies them through the
    // rules — and give the stored blocks their chain heights (the blocks-only store numbers
    // from 1 when the range does not start at genesis).
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    try {
        const tip = db.query("SELECT hash AS h FROM blocks WHERE slot = ?").get(snapshot.slot) as { h: string } | null; // hash is hex text
        if (!tip || tip.h.toLowerCase() !== snapshot.blockHash) throw new Error(`block store has no block at the state's slot ${snapshot.slot} with hash ${snapshot.blockHash}`);
        const dropped = db.query("SELECT COUNT(*) AS n FROM blocks WHERE slot > ?").get(snapshot.slot) as { n: number };
        db.exec(`DELETE FROM utxo_deltas WHERE hex(block_hash) IN (SELECT upper(hash) FROM blocks WHERE slot > ${snapshot.slot})`); // deltas key by the hash bytes
        db.exec(`DELETE FROM blocks WHERE slot > ${snapshot.slot}`);
        db.exec(`UPDATE blocks SET block_no = ${snapshot.blockNo} - (SELECT COUNT(*) FROM blocks b2 WHERE b2.slot > blocks.slot AND b2.block_no IS NOT NULL) WHERE block_no IS NOT NULL`);
        logInfo(logger, `Block store trimmed to the state's slot (${dropped.n} later block(s) dropped) and renumbered up to height ${snapshot.blockNo}`);
    } finally {
        db.close();
    }
    a.prog({ phase: "done", lastSlot: snapshot.slot, lastEpoch: snapshot.epoch, etaSec: 0, message: `ledger state imported at slot ${snapshot.slot} (epoch ${snapshot.epoch})` });
    logInfo(logger, `Ledger state imported at slot ${snapshot.slot}, epoch ${snapshot.epoch}, block ${snapshot.blockNo}; the node continues from here`);
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
): Promise<MithrilBootstrapResult> {
    const cfg = networkConfig(opts.network);
    setEpochNetwork(opts.network);
    // Progress file for the dashboard (scripts/dashboard-server.ts --mithril-progress).
    const progressFile = opts.progressFile ?? join(resolve(opts.downloadDir), "progress.json");
    const startedAt = new Date().toISOString();
    let progressBase: Partial<MithrilProgress> = { network: opts.network, blocksOnly: !!opts.blocksOnly, db: process.env.GEROLAMO_DB_PATH };
    const prog = (p: Partial<MithrilProgress>): void => {
        progressBase = { ...progressBase, ...p };
        writeMithrilProgress(progressFile, { phase: "certificate", network: opts.network, startedAt, updatedAt: startedAt, ...progressBase } as MithrilProgress);
    };
    prog({ phase: "certificate", message: "listing snapshots" });
    try {
        return await runTsBootstrapInner(opts, logger, prog);
    } catch (err) {
        prog({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        throw err;
    }
}

async function runTsBootstrapInner(
    opts: MithrilBootstrapOptions,
    logger: Logger,
    prog: (p: Partial<MithrilProgress>) => void,
): Promise<MithrilBootstrapResult> {
    const cfg = networkConfig(opts.network);
    const aggregator = opts.aggregator || cfg.aggregator;
    const engine: MithrilEngine = "ts";

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
    prog({ phase: "certificate", snapshotHash: selected.hash, snapshotEpoch: selected.beacon.epoch, beacon: selected.beacon.immutable_file_number, message: "verifying certificate chain" });

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
    prog({ certificateVerified: true, message: "certificate chain verified" });


    try {
        await persistMithrilCertificate(cert, {
            network: opts.network,
            wasmOk: undefined,
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
        // Per-chunk lines only for small ranges (a full chain is ~28 000 chunks); progress
        // goes to the log every 250 chunks and to the progress file.
        const verbose = to - from < 20;
        const dlStart = Date.now();
        let lastWrite = 0;
        const r = await downloadImmutableRange({
            snapshot: detail,
            downloadDir,
            fromChunk: from,
            toChunk: to,
            concurrency: opts.downloadConcurrency ?? 8,
            log: verbose ? (m) => logInfo(logger, m) : undefined,
            onProgress: (done, total, n) => {
                const elapsed = (Date.now() - dlStart) / 1000;
                const rate = elapsed > 0 ? done / elapsed : 0;
                const eta = rate > 0 ? Math.round((total - done) / rate) : null;
                if (done % 250 === 0 || done === total) logInfo(logger, `Downloaded ${done}/${total} chunks (${rate.toFixed(1)}/s, ETA ${eta != null ? `${Math.round(eta / 60)} min` : "?"})`);
                if (Date.now() - lastWrite > 2000 || done === total) { lastWrite = Date.now(); prog({ phase: "download", chunk: n, chunks: total, downloadedChunks: done, ratePerSec: rate, etaSec: eta, message: `downloading chunks ${from}..${to}` }); }
            },
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
        const apStart = Date.now();
        let blocks = 0;
        let lastSlot: number | undefined;
        for (const n of targets) {
            const r = await processChunk(immutableDir, n, logger, undefined, { blocksOnly: !!opts.blocksOnly });
            applied.push(n);
            blocks += r.applied;
            if (r.lastSlot != null) lastSlot = Number(r.lastSlot);
            const elapsed = (Date.now() - apStart) / 1000;
            const rate = elapsed > 0 ? applied.length / elapsed : 0;
            const eta = rate > 0 ? Math.round((targets.length - applied.length) / rate) : null;
            if (applied.length % 100 === 0 || applied.length === targets.length) logInfo(logger, `Applied ${applied.length}/${targets.length} chunks, ${blocks} blocks, slot ${lastSlot ?? "?"} (${rate.toFixed(1)} chunks/s, ETA ${eta != null ? `${Math.round(eta / 60)} min` : "?"})`);
            prog({ phase: "apply", chunk: n, chunks: targets.length, appliedChunks: applied.length, blocks, lastSlot, lastEpoch: lastSlot != null ? Number(epochForSlot(BigInt(lastSlot))) : undefined, ratePerSec: rate, etaSec: eta, message: opts.blocksOnly ? "storing certified blocks" : "applying blocks to the ledger" });
        }
        prog({ phase: "done", etaSec: 0, message: `${blocks} blocks stored` });
    }
    if (opts.ledgerState) {
        if (opts.skipApply) throw new Error("--ledger-state needs the apply step (drop --skip-apply)");
        if (!ancillaryDir) throw new Error(`--ledger-state: no ancillary ledger directory under ${downloadDir}`);
        await importLedgerStateFromAncillary({ downloadDir, ancillaryDir, network: opts.network, vkey: opts.ancillaryVkey, logger, prog });
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
                "Or use the default --engine ts (no external binary).",
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
            `No immutable chunk dir found under ${downloadDir}. Inspect download or use --engine ts.`,
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
            await processChunk(immutableDir, n, logger, undefined, { blocksOnly: !!opts.blocksOnly });
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
    return runTsBootstrap(opts, logger);
}

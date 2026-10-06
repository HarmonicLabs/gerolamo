import { installHardForkHistory, type HfcNodeConfig } from "../consensus/hfc/hfcNode";
import { startExplorerIndexer, stopExplorerIndexer } from "../db/minibf/explorerIndexer";
import * as path from "node:path/posix";

import {
    GerolamoConfig,
    createHttpPeerManager,
    initPeerManager,
    stopPeerManager,
} from "./peerManager";
import { calculatePreProdCardanoEpoch, setEpochNetwork } from "../utils/epochFromSlotCalculations";
import { setupKeyboard } from "../tui";
import { backfillBlockHeights, countGenesisUtxoRegistry, ensureInitialized, getMaxSlot, seedGenesisUtxosIfMissing } from "../db";
import { configureLedgerStore, sqlLedgerWrites } from "../ledger/nodeLedgerStore";
import { getByronGenesisConfig } from "../utils/paths";
import { byronGenesisUtxos, countFundedGenesisEntries } from "../consensus/byron/genesisUtxo";
import { populateEpochState } from "../state/blockfrost";
import { LogLevel, logger } from "../utils/logger";
import { startPeerBlockServer } from "./peerBlockServer";
import { closeSql, getSqlFilename, initSql } from "../sql";
import { startN2CServer, type N2CServerHandle } from "./n2c";
import { startN2NServer, type N2NServerHandle } from "./n2n";
import { duplexPullers, setDuplexResponderDeps } from "./n2n/DuplexResponders";
import { relayChainStoreOverride } from "../storage/nodeBlockStore";
import { getShelleyGenesisConfig } from "../utils/paths";
import { connect as netConnect } from "node:net";
import { GlobalSharedMempool } from "./SharedMempool";
import { initMempool, stopMempool } from "../mempool";
import { resolveN2NConfig } from "./n2n/config";
import { listShareablePeers, reloadTopology, setInboundN2NStatusProvider } from "./peerManager";
import { resolvePrometheusConfig, startPrometheusServer, type PrometheusHandle } from "./prometheus";
import { collectNodeMetrics } from "./nodePrometheus";
import { getBlockProducer } from "../pool/startBlockProducer";
import { resolveNodeRole } from "./nodeRole";
import { ignoredValidationKeys, resolveValidationPolicy } from "../consensus/validationPolicy";
import { getBuildInfo } from "../utils/buildInfo";

async function runSnapShotPopulation(config: GerolamoConfig) {
    console.log(
        `Snapshot population enabled (source: ${config.snapshot.source})`,
    );
    const maxSlot = await getMaxSlot();
    console.log(`Current DB max slot: ${maxSlot}`);
    const syncPointSlot = BigInt(config.syncFromPointSlot);
    console.log(`Sync point slot: ${syncPointSlot}`);
    if (maxSlot >= syncPointSlot) {
        console.log(
            "Database already contains data up to or beyond the sync point slot. Skipping snapshot population.",
        );
        return;
    }
    const targetEpoch = calculatePreProdCardanoEpoch(
        config.syncFromPointSlot,
    );
    const fromEpoch = (config.snapshot as any).fromEpoch || 1;
    console.log(
        `Populating snapshots from epoch ${fromEpoch} to ${targetEpoch}`,
    );
    for (let epoch = fromEpoch; epoch <= targetEpoch; epoch++) {
        await populateEpochState(
            epoch,
            {
                customBackend: config.blockfrostUrl!,
                projectId: undefined,
            },
        );
    }
    console.log(
        `NES snapshot population complete up to epoch ${targetEpoch}`,
    );
}

function mergeConfigOverlay(
    base: Record<string, unknown>,
    overlay: Record<string, unknown>,
): Record<string, unknown> {
    const nested = [
        "n2c",
        "n2n",
        "logs",
        "peerGovernor",
        "snapshot",
        "blockFetchBatch",
        "sync",
        "validation",
    ] as const;
    const out: Record<string, unknown> = { ...base, ...overlay };
    for (const key of nested) {
        const o = overlay[key];
        if (o && typeof o === "object") {
            const b = base[key];
            out[key] = {
                ...(b && typeof b === "object" ? (b as object) : {}),
                ...(o as object),
            };
        }
    }
    return out;
}

async function loadConfig(network: string): Promise<GerolamoConfig> {
    // Load config using Bun.file from the local config directory
    const configPath = `./src/config/${network}/config.json`;
    const configFile = Bun.file(configPath);
    if (!(await configFile.exists())) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    let configData = (await configFile.json()) as GerolamoConfig;

    // Instance overlay from the desktop Control Center (does not edit repo config.json)
    const overlayPath = process.env.GEROLAMO_CONFIG_PATH?.trim();
    if (overlayPath) {
        const overlayFile = Bun.file(overlayPath);
        if (await overlayFile.exists()) {
            const overlay = (await overlayFile.json()) as Record<string, unknown>;
            configData = mergeConfigOverlay(
                configData as unknown as Record<string, unknown>,
                overlay,
            ) as unknown as GerolamoConfig;
            logger.info(`Merged instance config overlay: ${overlayPath}`);
        }
    }

    // Lab / ops env overrides (instance isolation without editing repo config.json)
    // DATABASE_URL=sqlite:///abs/path  or  GEROLAMO_DB_PATH=/abs/path
    // PORT=3030
    let dbPath = configData.dbPath;
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl?.startsWith("sqlite://")) {
        dbPath = databaseUrl.slice("sqlite://".length);
    } else if (databaseUrl?.startsWith("file:")) {
        dbPath = databaseUrl.slice("file:".length);
    } else if (process.env.GEROLAMO_DB_PATH?.trim()) {
        dbPath = process.env.GEROLAMO_DB_PATH.trim();
    }

    const portEnv = process.env.PORT || process.env.GEROLAMO_PORT;
    const port = portEnv ? Number(portEnv) : (configData.port ?? 3030);

    // N2C node.socket (Ouroboros) — not HTTP unixSocket.
    // Priority: GEROLAMO_N2C=0 off → GEROLAMO_N2C_SOCKET → config n2cSocketPath
    // → config.n2c only when n2c.enabled === true (socketPath alone does not enable).
    const n2cDisabled =
        process.env.GEROLAMO_N2C === "0" ||
        process.env.GEROLAMO_N2C === "false";
    const n2cCfg = (configData as any).n2c as
        | { enabled?: boolean; socketPath?: string }
        | undefined;
    let n2cSocketPath: string | undefined;
    if (!n2cDisabled) {
        const fromEnv = process.env.GEROLAMO_N2C_SOCKET?.trim();
        const fromTop = (configData as any).n2cSocketPath?.trim?.() as
            | string
            | undefined;
        const fromNested =
            n2cCfg?.enabled === true
                ? n2cCfg.socketPath?.trim()
                : undefined;
        n2cSocketPath = fromEnv || fromTop || fromNested || undefined;
    }
    if (n2cSocketPath === "") n2cSocketPath = undefined;

    // role: "relay" turns the inbound N2N listener on; "data" leaves it to n2n.enabled / env.
    const n2nInput = { ...((configData as any).n2n ?? {}) };
    if (["relay", "producer"].includes(String((configData as any).role ?? "").toLowerCase())) n2nInput.enabled = true;
    const n2n = resolveN2NConfig(n2nInput, process.env);

    return {
        ...configData,
        dbPath,
        port: Number.isFinite(port) && port > 0 ? port : (configData.port ?? 3030),
        n2cSocketPath,
        n2n,
    } as GerolamoConfig;
}

/**
 * Bun (like Node ≥ 15) exits the process on an unhandled promise rejection or an
 * uncaught exception. A long-running node must log and carry on instead: every
 * subsystem (peers, ranges, workers) has its own recovery, and a stray rejection in
 * one of them must not take the whole sync down.
 */
function installCrashGuards(): void {
    process.on("unhandledRejection", (reason) => {
        logger.error("Unhandled promise rejection (node keeps running):", reason);
    });
    process.on("uncaughtException", (err) => {
        logger.error("Uncaught exception (node keeps running):", err);
    });
    // SIGUSR2 → heap summary (object count + bytes per class) into GEROLAMO_HEAP_DIR
    // (default: cwd). Cheap way to find what accumulates during a long sync.
    process.on("SIGUSR2", () => {
        try {
            const snap = Bun.generateHeapSnapshot() as unknown as { nodes: number[]; nodeClassNames: string[] };
            const agg = new Map<string, { count: number; bytes: number }>();
            for (let i = 0; i + 3 < snap.nodes.length; i += 4) {
                const name = snap.nodeClassNames[snap.nodes[i + 2]!] ?? "?";
                const a = agg.get(name) ?? { count: 0, bytes: 0 };
                a.count++;
                a.bytes += snap.nodes[i + 1]!;
                agg.set(name, a);
            }
            const rows = [...agg.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 60)
                .map(([name, a]) => ({ name, count: a.count, bytes: a.bytes }));
            const mem = process.memoryUsage();
            const out = { at: new Date().toISOString(), rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external, arrayBuffers: mem.arrayBuffers, top: rows };
            const dir = process.env.GEROLAMO_HEAP_DIR || ".";
            const file = `${dir}/heap-${Date.now()}.json`;
            require("node:fs").writeFileSync(file, JSON.stringify(out, null, 1));
            logger.warn(`Heap summary written to ${file} (rss ${Math.round(mem.rss / 1048576)} MB, heap ${Math.round(mem.heapUsed / 1048576)} MB)`);
        } catch (err) {
            logger.error("Heap summary failed:", err);
        }
    });
}

/**
 * SIGHUP, as cardano-node: re-read topology.json (roots, valencies, ledger-peer settings, peer
 * snapshot) and the block producer's KES key + operational certificate. Installed first thing:
 * without a handler SIGHUP would terminate the process.
 */
function installSighup(): void {
    let running = false;
    process.on("SIGHUP", () => {
        if (running) { logger.warn("SIGHUP: a reload is already running"); return; }
        running = true;
        void (async () => {
            logger.info("SIGHUP: reloading topology and block producer credentials");
            try { logger.info(`SIGHUP: ${await reloadTopology()}`); }
            catch (err) { logger.error("SIGHUP: topology reload failed (previous topology stays):", err); }
            const bp = getBlockProducer();
            if (bp) {
                const r = await bp.reloadCredentials();
                if (r.ok) logger.info(`SIGHUP: block producer now uses opcert counter ${r.counter}, KES period ${r.kesPeriod}`);
                else logger.error(`SIGHUP: block producer kept its credentials: ${r.reason}`);
            }
        })().finally(() => { running = false; });
    });
}

export async function start() {
    const network = process.env.NETWORK ?? "preprod";
    setEpochNetwork(network); // slot→epoch math for every later caller
    installCrashGuards();
    installSighup();
    console.log(
        `Gerolamo Network Node ${getBuildInfo().label} starting on ${network} network...`,
    );

    console.log(`Loading config for ${network} network`);

    const config = await loadConfig(network);
    await installHardForkHistory(config as unknown as HfcNodeConfig, network); // era boundaries from the genesis files + ledger (consensus/hfc)

    if (config.tuiEnabled) {
        setupKeyboard();
        logger.info(
            "TUI keyboard handler enabled (press 'q' to quit).",
        );
    }

    logger.setLogConfig(config.logs);
    logger.info(`Log level ${LogLevel[logger.logLevel] ?? logger.logLevel} (config.logs); validation workers log at INFO unless GEROLAMO_HEADER_TRACE=1`);
    logger.info("Configuration loaded successfully.");
    logger.info(`Database path: ${config.dbPath}`);
    if (config.tuiEnabled) {
        logger.setLogConfig({ logToConsole: false });
        logger.info(
            "TUI enabled - console logging disabled to prevent interference.",
        );
    }

    // Bun default sql is Postgres — force SQLite from config.dbPath (or DATABASE_URL).
    initSql(config.dbPath);
    logger.info(`SQLite client ready: ${getSqlFilename()}`);

    logger.info("Initializing database...");
    await ensureInitialized();
    // Explorer projection (mb_* tables) in its own file, written by a worker (GEROLAMO_EXPLORER_WORKER=0 → inline).
    await startExplorerIndexer(config.dbPath);
    await backfillBlockHeights();
    logger.info("Database initialized and ready.");

    // From-genesis ledger: the Byron genesis balances are the initial UTxO set.
    // Retroactive and idempotent — a DB that synced before seeding existed gets
    // the still-unspent genesis outputs added; spent ones are left absent.
    // With the LMDB ledger and no SQLite ledger writes the genesis UTxOs live in the store's genesis
    // state (ledger/genesisState.ts, bug 304); the SQLite seed below is for the SQLite ledger only.
    configureLedgerStore((config as { ledgerStore?: string }).ledgerStore);
    if (config.syncFromGenesis && !sqlLedgerWrites()) {
        logger.info("Genesis UTxOs: not seeded into SQLite (SQLite ledger writes are off; the LMDB store's genesis state or import holds the ledger)");
    } else if (config.syncFromGenesis) {
        const byronGenesis = await getByronGenesisConfig(config);
        if (byronGenesis) {
            // Deriving 14.5k mainnet redeem addresses (~15 s with the BigInt sha3, ~1 s since bug 305): do it once.
            // The registry table remembers every genesis output ever seeded.
            const expected = countFundedGenesisEntries(byronGenesis);
            const registered = await countGenesisUtxoRegistry();
            if (registered >= expected && expected > 0) {
                logger.info(`Genesis UTxOs already registered (${registered}); skipping derivation`);
            } else {
                const { utxos, nonAvvm, avvm } = byronGenesisUtxos(byronGenesis);
                const r = await seedGenesisUtxosIfMissing(utxos);
                if (r.skipped) logger.info(`Genesis UTxOs: not seeded (${r.skipped})`);
                else logger.info(
                    `Genesis UTxOs: ${utxos.length} (${nonAvvm} funded address(es), ${avvm} AVVM) — ${r.inserted} added, ${r.present} present, ${r.spent} already spent on chain (tip slot ${await getMaxSlot()})`,
                );
            }
        } else {
            logger.warn("syncFromGenesis but no byronGenesisFile configured: genesis UTxOs not seeded");
        }
    }

    // Run snapshot population if enabled
    if (config.snapshot.enable) {
        await runSnapShotPopulation(config);
    }

    {
        const vp = resolveValidationPolicy(config);
        (vp.ledgerComplete ? logger.info : logger.warn).call(logger, `Validation: ${vp.note}`);
        const ignored = ignoredValidationKeys(config);
        if (ignored.length) logger.warn(`config keys ignored (validation is not configurable): ${ignored.join(", ")}`);
    }
    logger.info(`Node role: ${resolveNodeRole(config)}${config.n2n ? ` (inbound N2N on ${config.n2n.host}:${config.n2n.port})` : " (no inbound N2N)"}`);
    if (config.n2n) {
        // Relay / producer: also serve our chain over the connections we open (duplex), so the
        // hot peers pull forged blocks without depending on inbound connections.
        setDuplexResponderDeps({
            store: relayChainStoreOverride(),
            sharePeers: (amount) => listShareablePeers(amount),
            mempool: GlobalSharedMempool.getInstance(),
            maxRangeBlocks: config.n2n.maxRangeBlocks,
        });
    }
    // Validating mempool before any transaction can arrive (N2C, N2N, HTTP); `mempool.validate:
    // false` in the config keeps the old parse-only store.
    if ((config as any).mempool?.validate !== false) {
        try { await initMempool(config); }
        catch (err) { logger.error("Validating mempool failed to start (transactions are stored unvalidated):", err); }
    }
    logger.info("Starting peer manager...");

    await initPeerManager(config);
    logger.info("Peer manager started.");
    logger.info("Starting peer block server...");

    await startPeerBlockServer(config, createHttpPeerManager());
    logger.info("Peer block server started.");

    // Prometheus text exposition with cardano-node metric names (hasPrometheus-style, own port).
    let promHandle: PrometheusHandle | undefined;
    const promCfg = resolvePrometheusConfig(config);
    if (promCfg) {
        try {
            const startedAtMs = Date.now() - Math.round(process.uptime() * 1000);
            const k = Number((await getShelleyGenesisConfig(config) as { securityParam?: number } | null)?.securityParam) || 2160;
            promHandle = startPrometheusServer(promCfg, () => collectNodeMetrics({ config, startedAtMs, securityParam: k }));
        } catch (err) {
            logger.error(`Prometheus endpoint ${promCfg.host}:${promCfg.port} failed to start:`, err);
        }
    }

    let n2nHandle: N2NServerHandle | undefined;
    if (config.n2n) {
        n2nHandle = await startN2NServer({
            store: relayChainStoreOverride(),
            ws: config.n2n.ws,
            lightQuery: { networkMagic: config.networkMagic, activeSlotsCoeff: Number((await getShelleyGenesisConfig(config) as { activeSlotsCoeff?: number } | null)?.activeSlotsCoeff ?? 0.05) },
            host: config.n2n.host,
            port: config.n2n.port,
            networkMagic: config.networkMagic,
            maxConnections: config.n2n.maxConnections,
            maxRangeBlocks: config.n2n.maxRangeBlocks,
            handshakeTimeoutMs: config.n2n.handshakeTimeoutMs,
            idleTimeoutMs: config.n2n.idleTimeoutMs,
            sharePeers: (amount) => listShareablePeers(amount),
            // Pull connecting peers' transactions into the shared mempool (fills the blocks we forge).
            mempool: GlobalSharedMempool.getInstance(),
        });
        logger.info(
            `Inbound N2N ready: ${n2nHandle.host}:${n2nHandle.port}`,
        );
        const h = n2nHandle;
        // Self-probe: can the world reach our public relay address? (2026-09-13: the VPN that
        // carries the port forward did not come back after a reboot; three blocks forged into
        // the void before anyone noticed "connection refused".)
        let publicReachable: { address: string; ok: boolean; checkedAt: number; error: string | null } | null = null;
        const publicAddress = config.n2n.publicAddress;
        if (publicAddress) {
            const [pHost, pPortStr] = publicAddress.split(":");
            const pPort = Number(pPortStr);
            const probe = () => new Promise<void>((resolve) => {
                const sock = netConnect({ host: pHost!, port: pPort });
                let settled = false;
                const done = (ok: boolean, error: string | null) => {
                    if (settled) return;
                    settled = true;
                    const was = publicReachable?.ok;
                    publicReachable = { address: publicAddress, ok, checkedAt: Date.now(), error };
                    if (!ok && was !== false) logger.error(`Public relay address ${publicAddress} is NOT reachable from here (${error}): no peer can pull our blocks over inbound — check the VPN / port forward`);
                    if (ok && was === false) logger.info(`Public relay address ${publicAddress} is reachable again`);
                    try { sock.destroy(); } catch { /* ignore */ }
                    resolve();
                };
                sock.setTimeout(5000, () => done(false, "timeout"));
                sock.once("connect", () => done(true, null));
                sock.once("error", (e) => done(false, e.message));
            });
            void probe();
            setInterval(() => { void probe(); }, 120_000).unref?.();
        }
        setInboundN2NStatusProvider(() => ({
            listening: true,
            publicReachable,
            duplexPullers: duplexPullers().map((d) => d.peer),
            clientList: h.clients(),
            host: h.host,
            port: h.port,
            clients: h.clientCount(),
        }));
    } else {
        logger.info(
            'Inbound N2N disabled (role "data"; set role "relay", n2n.enabled or GEROLAMO_N2N_PORT to accept peers)',
        );
        setInboundN2NStatusProvider(null);
    }

    if (config.producer) {
        // Block producer: forges when this pool leads a slot; blocks go through the node's own
        // strict validation (adoptLocalBlock) and are served to relays by the inbound N2N hosts.
        // After the HTTP server and the inbound listener: the schedule pass takes minutes and
        // neither /metrics (2026-09-10 06:14 UTC) nor inbound peers (2026-09-12 09:40 UTC, five
        // minutes without a listener after a reboot) may wait for it.
        try {
            const { startBlockProducer } = await import("../pool/startBlockProducer");
            await startBlockProducer(config);
        } catch (err) {
            logger.error("Block producer failed to start (node keeps running as a relay):", err);
        }
    }

    let n2cHandle: N2CServerHandle | undefined;
    if (config.n2cSocketPath) {
        logger.info(`Starting N2C server on ${config.n2cSocketPath}...`);
        n2cHandle = await startN2CServer({
            socketPath: config.n2cSocketPath,
            networkMagic: config.networkMagic,
        });
        logger.info(
            `N2C server ready: ${n2cHandle.socketPath} (networkMagic=${n2cHandle.networkMagic})`,
        );
    } else {
        logger.info(
            "N2C server disabled (set GEROLAMO_N2C_SOCKET or config n2c.socketPath)",
        );
    }

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return; // a second SIGTERM (desktop sends two) must not cut the first short
        shuttingDown = true;
        logger.info(`Received ${signal}; shutting down...`);
        // Never hang: a stuck subsystem still gets the process down, with a non-zero code.
        const deadline = setTimeout(() => {
            console.error("Shutdown did not complete within 30 s; exiting");
            process.exit(1);
        }, 30_000);
        try {
            promHandle?.stop();
        } catch { /* ignore */ }
        try {
            await n2nHandle?.stop();
        } catch (err) {
            logger.error("N2N shutdown error:", err);
        }
        try {
            await stopPeerManager(); // stops the applier (finishes its transaction), then peers
            stopMempool();
        } catch (err) {
            logger.error("PeerManager shutdown error:", err);
        }
        try {
            await n2cHandle?.stop();
        } catch (err) {
            logger.error("N2C shutdown error:", err);
        }
        try {
            await stopExplorerIndexer(); // flush the projection queue before the ledger closes
            await closeSql(); // checkpoint + close: no -wal left to recover on the next start
        } catch (err) {
            logger.error("DB close error:", err);
        }
        logger.info("Shutdown complete.");
        try {
            await logger.flushAll();
        } catch {
            /* ignore */
        }
        clearTimeout(deadline);
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    logger.info("Node is now running.");
}

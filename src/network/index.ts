import * as path from "node:path/posix";

import {
    GerolamoConfig,
    createHttpPeerManager,
    initPeerManager,
    stopPeerManager,
} from "./peerManager";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { setupKeyboard } from "../tui";
import { countGenesisUtxoRegistry, ensureInitialized, getMaxSlot, seedGenesisUtxosIfMissing } from "../db";
import { getByronGenesisConfig } from "../utils/paths";
import { byronGenesisUtxos, countFundedGenesisEntries } from "../consensus/byron/genesisUtxo";
import { populateEpochState } from "../state/blockfrost";
import { logger } from "../utils/logger";
import { startPeerBlockServer } from "./peerBlockServer";
import { getSqlFilename, initSql } from "../sql";
import { startN2CServer, type N2CServerHandle } from "./n2c";
import { startN2NServer, type N2NServerHandle } from "./n2n";
import { resolveN2NConfig } from "./n2n/config";
import { listShareablePeers, setInboundN2NStatusProvider } from "./peerManager";
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
    if (String((configData as any).role ?? "").toLowerCase() === "relay") n2nInput.enabled = true;
    const n2n = resolveN2NConfig(n2nInput, process.env);

    return {
        ...configData,
        dbPath,
        port: Number.isFinite(port) && port > 0 ? port : (configData.port ?? 3030),
        n2cSocketPath,
        n2n,
    } as GerolamoConfig;
}

export async function start() {
    const network = process.env.NETWORK ?? "preprod";
    console.log(
        `Gerolamo Network Node ${getBuildInfo().label} starting on ${network} network...`,
    );

    console.log(`Loading config for ${network} network`);

    const config = await loadConfig(network);

    if (config.tuiEnabled) {
        setupKeyboard();
        logger.info(
            "TUI keyboard handler enabled (press 'q' to quit).",
        );
    }

    logger.setLogConfig(config.logs);
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
    logger.info("Database initialized and ready.");

    // From-genesis ledger: the Byron genesis balances are the initial UTxO set.
    // Retroactive and idempotent — a DB that synced before seeding existed gets
    // the still-unspent genesis outputs added; spent ones are left absent.
    if (config.syncFromGenesis) {
        const byronGenesis = await getByronGenesisConfig(config);
        if (byronGenesis) {
            // Deriving 14.5k mainnet redeem addresses costs ~15 s of CPU: do it once.
            // The registry table remembers every genesis output ever seeded.
            const expected = countFundedGenesisEntries(byronGenesis);
            const registered = await countGenesisUtxoRegistry();
            if (registered >= expected && expected > 0) {
                logger.info(`Genesis UTxOs already registered (${registered}); skipping derivation`);
            } else {
                const { utxos, nonAvvm, avvm } = byronGenesisUtxos(byronGenesis);
                const r = await seedGenesisUtxosIfMissing(utxos);
                logger.info(
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
    logger.info("Starting peer manager...");

    await initPeerManager(config);
    logger.info("Peer manager started.");

    logger.info("Starting peer block server...");

    await startPeerBlockServer(config, createHttpPeerManager());
    logger.info("Peer block server started.");

    let n2nHandle: N2NServerHandle | undefined;
    if (config.n2n) {
        n2nHandle = await startN2NServer({
            host: config.n2n.host,
            port: config.n2n.port,
            networkMagic: config.networkMagic,
            maxConnections: config.n2n.maxConnections,
            maxRangeBlocks: config.n2n.maxRangeBlocks,
            handshakeTimeoutMs: config.n2n.handshakeTimeoutMs,
            idleTimeoutMs: config.n2n.idleTimeoutMs,
            sharePeers: (amount) => listShareablePeers(amount),
        });
        logger.info(
            `Inbound N2N ready: ${n2nHandle.host}:${n2nHandle.port}`,
        );
        const h = n2nHandle;
        setInboundN2NStatusProvider(() => ({
            listening: true,
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

    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}; shutting down...`);
        try {
            await n2nHandle?.stop();
        } catch (err) {
            logger.error("N2N shutdown error:", err);
        }
        try {
            await stopPeerManager();
        } catch (err) {
            logger.error("PeerManager shutdown error:", err);
        }
        try {
            await n2cHandle?.stop();
        } catch (err) {
            logger.error("N2C shutdown error:", err);
        }
        process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    logger.info("Node is now running.");
}

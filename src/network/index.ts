import * as path from "node:path/posix";

import { GerolamoConfig, initPeerManager } from "./peerManager";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { setupKeyboard } from "../tui";
import { ensureInitialized, getMaxSlot } from "../db";
import { populateEpochState } from "../state/blockfrost";
import { logger } from "../utils/logger";
import { startPeerBlockServer } from "./peerBlockServer";
import { getSqlFilename, initSql } from "../sql";

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

async function loadConfig(network: string): Promise<GerolamoConfig> {
    // Load config using Bun.file from the local config directory
    const configPath = `./src/config/${network}/config.json`;
    const configFile = Bun.file(configPath);
    if (!(await configFile.exists())) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    const configData = await configFile.json() as GerolamoConfig;

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

    return {
        ...configData,
        dbPath,
        port: Number.isFinite(port) && port > 0 ? port : (configData.port ?? 3030),
    } as GerolamoConfig;
}

export async function start() {
    const network = process.env.NETWORK ?? "preprod";
    console.log(
        `Gerolamo Network Node starting on ${network} network...`,
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

    // Run snapshot population if enabled
    if (config.snapshot.enable) {
        await runSnapShotPopulation(config);
    }

    logger.info("Starting peer manager...");

    await initPeerManager(config);
    logger.info("Peer manager started.");

    logger.info("Starting peer block server...");

    await startPeerBlockServer(config, null);
    logger.info("Peer block server started. Node is now running.");
}

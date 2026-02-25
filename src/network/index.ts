import * as path from "node:path/posix";

import { GerolamoConfig, initPeerManager } from "./peerManager";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { setupKeyboard } from "../tui";
import { ensureInitialized, getMaxSlot } from "../db";
import { populateEpochState } from "../state/blockfrost";
import { logger } from "../utils/logger";
import { startPeerBlockServer } from "./peerBlockServer";

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
    const configData = await configFile.json();
    return configData as GerolamoConfig;
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

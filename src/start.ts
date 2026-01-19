import path from 'path';
import { Database } from 'bun:sqlite';
import { startPeerManager } from "./network/peerManagerWorkers/startPeerManager";
import { DB } from "./db/DB";
import type { GerolamoConfig } from "./network/peerManagerWorkers/peerManagerWorker";
import { logger } from "./utils/logger";
import { getBasePath } from './utils/paths.js';
import { calculatePreProdCardanoEpoch } from "./utils/epochFromSlotCalculations";
import type { Worker } from "worker_threads";
import { setupKeyboard } from "./tui/tui";
setupKeyboard();
export const getConfigPath = (network: string): string => path.join(getBasePath(), 'config', network, 'config.json');
let configPath = "";

const network = process.env.NETWORK ?? "preprod";
logger.info(`Gerolamo Network Node starting on ${network} network...`);

configPath = process.env.GEROLAMO_CONFIG?? getConfigPath(network);
logger.info(`Loading config from ${configPath}`);

async function loadConfig(filePath: string): Promise<GerolamoConfig> {
    const configFile = Bun.file(filePath);
    if (!(await configFile.exists())) {
        throw new Error(`Config file not found: ${filePath}`);
    }
    const configData = await configFile.json();
    return configData as GerolamoConfig;
}

const config = await loadConfig(configPath);
logger.info("Configuration loaded successfully.");
if (config.tuiEnabled) {	
	logger.info("TUI keyboard handler enabled (press 'q' to quit).");
}
logger.info(`Database path: ${config.dbPath}`);
logger.setLogConfig(config.logs);
if (config.tuiEnabled) {
	logger.setLogConfig({ logToConsole: false });
	logger.info("TUI enabled - console logging disabled to prevent interference.");
}

//logger.info("Logger configured with log level and outputs.");

const db = new DB(config.dbPath);
logger.info("Initializing database...");
await db.ensureInitialized();
logger.info("Database initialized and ready.");

// Run snapshot population if enabled
if (config.snapshot.enable) 
{
   await runSnapShotPopulation();
}

logger.info("Starting peer manager...");
const managerWorker: Worker = await startPeerManager(config);
logger.info("Peer manager started.");

logger.info("Starting peer block server...");
const peerBlockServerMod = await import("./network/peerServer/peerBlockServer");
await peerBlockServerMod.startPeerBlockServer(config, managerWorker);
logger.info("Peer block server started. Node is now running.");

async function runSnapShotPopulation() {
    logger.info(`Snapshot population enabled (source: ${config.snapshot.source})`);
    const maxSlot = await db.getMaxSlot();
    logger.info(`Current DB max slot: ${maxSlot}`);
    const syncPointSlot = BigInt(config.syncFromPointSlot);
    logger.info(`Sync point slot: ${syncPointSlot}`);
    if (maxSlot >= syncPointSlot) {
        logger.info("Database already contains data up to or beyond the sync point slot. Skipping snapshot population.");
        return;
    };
    const targetEpoch = calculatePreProdCardanoEpoch(config.syncFromPointSlot);
    const fromEpoch = (config.snapshot as any).fromEpoch || 1;
    logger.info(`Populating snapshots from epoch ${fromEpoch} to ${targetEpoch}`);
    for (let epoch = fromEpoch; epoch <= targetEpoch; epoch++) {
        await import("./state/blockfrost/populateEpochState").then(m => m.populateEpochState(
            db.db, epoch, { 
            customBackend: config.blockfrostUrl!, projectId: undefined 
        }));
    }
    logger.info(`NES snapshot population complete up to epoch ${targetEpoch}`);    
    return;

};
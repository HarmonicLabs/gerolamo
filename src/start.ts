import path from 'path';
import { startPeerManager } from "./network/peerManagerWorkers/startPeerManager";
import { DB } from "./db/DB";
import type { GerolamoConfig } from "./network/peerManagerWorkers/peerManagerWorker";
import { logger } from "./utils/logger";
import { getBasePath } from './utils/paths.js';
import { importFromBlockfrost } from "./state/blockfrost/index";
import { calculatePreProdCardanoEpoch } from "./utils/epochFromSlotCalculations";
import { Database } from "bun:sqlite";

export const getConfigPath = (network: string): string => path.join(getBasePath(), 'config', network, 'config.json');

const network = process.env.NETWORK ?? "preprod";
const configFilePath = getConfigPath(network);

async function loadConfig(filePath: string): Promise<GerolamoConfig> {
    const configFile = Bun.file(filePath);
    if (!(await configFile.exists())) {
        throw new Error(`Config file not found: ${filePath}`);
    }
    const configData = await configFile.json();
    return configData as GerolamoConfig;
}

const config = await loadConfig(configFilePath);
logger.setLogConfig(config.logs);
await new DB(config.dbPath).ensureInitialized();

// Run snapshot population if enabled
if (config.snapshot.enable) {
    logger.debug(`Snapshot enabled with source: ${config.snapshot.source}`);
    if (config.syncFromPoint) {
        const targetEpoch = calculatePreProdCardanoEpoch(config.syncFromPointSlot);
        logger.debug(`Populating NES snapshot for epoch ${targetEpoch} from block ${config.syncFromPointBlockHash}`);
        const db = new Database(config.dbPath);
        await importFromBlockfrost(db, config.syncFromPointBlockHash, { customBackend: "https://blockfrost-preprod.onchainapps.io/" });
    } else {
        logger.warn("Snapshot enabled but syncFromPoint is false. Snapshot requires a sync point.");
    }
}

await import("./network/peerServer/peerBlockServer.ts");
await startPeerManager(config);
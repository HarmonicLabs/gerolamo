import path from 'path';
import { startPeerManager } from "./network/peerManagerWorkers/startPeerManager";
import { DB } from "./db/DB";
import type { GerolamoConfig } from "./network/peerManagerWorkers/peerManagerWorker";
import { logger } from "./utils/logger";
import { getBasePath } from './utils/paths.js';

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
await import("./network/peerServer/peerBlockServer.ts");
await startPeerManager(config);
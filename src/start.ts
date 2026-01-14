import { startPeerManager } from "./network/peerManagerWorkers/startPeerManager"
import type { GerolamoConfig } from "./network/peerManagerWorkers/peerManagerWorker";
import { initDB } from "./db/initDB";
import "./network/peerServer/peerBlockServer.ts";

// const BASE_PATH: string = path.resolve(__dirname, `./`);
// const resolvePath = (relativePath: string): string => path.join(BASE_PATH, relativePath);

await initDB();
async function loadConfig(filePath: string): Promise<GerolamoConfig> {
    const configFile = Bun.file(filePath);
    if (!(await configFile.exists())) {
        throw new Error(`Config file not found: ${filePath}`);
    }
    const configData = await configFile.json();
    // Validate or cast to GerolamoConfig (add checks as needed)
    return configData as GerolamoConfig;
}
const configFilePath = "./src/config/preprod/config.json"; // Adjust path as needed

const config = await loadConfig(configFilePath);

await startPeerManager(config);
import path from "path";
import { fileURLToPath } from "node:url";
import type { GerolamoConfig } from "../network/peerManager";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import type { ByronGenesisConfig } from "../consensus/byron/ByronOBFT";
import { logger } from "./logger";

const shelleyGenesisByPath = new Map<string, Promise<ShelleyGenesisConfig>>();
const byronGenesisByPath = new Map<string, Promise<ByronGenesisConfig>>();

export const getBasePath = (): string => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, ".."); // src/utils/paths.ts → src/
};

export function getShelleyGenesisConfig(
    config: GerolamoConfig,
): Promise<ShelleyGenesisConfig> {
    const genesisPath = path.resolve(config.shelleyGenesisFile);
    const cached = shelleyGenesisByPath.get(genesisPath);
    if (cached) return cached;

    logger.debug("Preloading Shelley Genesis Config from:", genesisPath);
    const loading = Bun.file(genesisPath)
        .json()
        .then((value) => value as ShelleyGenesisConfig);
    shelleyGenesisByPath.set(genesisPath, loading);
    void loading.catch(() => {
        if (shelleyGenesisByPath.get(genesisPath) === loading) {
            shelleyGenesisByPath.delete(genesisPath);
        }
    });
    return loading;
}

/**
 * Byron genesis (heavyDelegation, protocolConsts). Resolves null when the
 * network config does not name a `byronGenesisFile`.
 */
export function getByronGenesisConfig(
    config: GerolamoConfig,
): Promise<ByronGenesisConfig | null> {
    const file = config.byronGenesisFile?.trim();
    if (!file) return Promise.resolve(null);
    const genesisPath = path.resolve(file);
    const cached = byronGenesisByPath.get(genesisPath);
    if (cached) return cached;
    logger.debug("Preloading Byron Genesis Config from:", genesisPath);
    const loading = Bun.file(genesisPath)
        .json()
        .then((value) => value as ByronGenesisConfig);
    byronGenesisByPath.set(genesisPath, loading);
    void loading.catch(() => {
        if (byronGenesisByPath.get(genesisPath) === loading) {
            byronGenesisByPath.delete(genesisPath);
        }
    });
    return loading;
}

import path from 'path';
import { fileURLToPath } from 'node:url';
import type { GerolamoConfig } from '../network/peerManagerWorkers/peerManagerWorker';
import { logger } from './logger';

export const getBasePath = (): string => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	return path.resolve(__dirname, '..');  // src/utils/paths.ts → src/
};

export async function getShelleyGenesisConfig(config: GerolamoConfig) {
	logger.debug("Loading Shelley Genesis Config from:", config.shelleyGenesisFile);
	const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile);
	const shelleyGenesisConfig = await shelleyGenesisFile.json();
	return shelleyGenesisConfig;
};
import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { DB } from "./db/DB";
import { Database } from "bun:sqlite";
import path from 'path';
import type { GerolamoConfig } from "./network/peerManager";
import { initPeerManager } from "./network/peerManager";
import { getBasePath } from './utils/paths.js';
import { calculatePreProdCardanoEpoch } from "./utils/epochFromSlotCalculations";

import { setupKeyboard } from "./tui";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { Logger, LogLevel } from "./utils/logger";
import { mkdir } from "fs/promises";

export const getConfigPath = (network: string): string => path.join(getBasePath(), 'config', network, 'config.json');

interface RawChunkBlock {
    slotNo: bigint;
    headerHash: Uint8Array;
    blockHash: Uint8Array;
    blockCbor: Uint8Array;
    headerOffset: number;
    headerSize: number;
    crc: number;
};

async function parseChunk(dirPath: string, chunkNo: number): Promise<RawChunkBlock[]> {
	const chunkStr = chunkNo.toString().padStart(5, "0");
	const primaryPath = `${dirPath}/${chunkStr}.primary`;
	const secondaryPath = `${dirPath}/${chunkStr}.secondary`;
	const chunkPath = `${dirPath}/${chunkStr}.chunk`;

	const primaryBytes = await Bun.file(primaryPath).arrayBuffer();
	const primaryDV = new DataView(primaryBytes);
	if (primaryDV.getUint8(0) !== 1) 
	{
		throw new Error(`Invalid primary version in chunk ${chunkStr}`);
	};
	const numOffsets = (primaryBytes.byteLength - 1) / 4;
	const offsets: number[] = [];
	for (let i = 0; i < numOffsets; i++) {
		offsets.push(primaryDV.getUint32(1 + i * 4, false)); // BE
	};

	const filledRelSlots: number[] = [];
	for (let i = 0; i < offsets.length - 1; i++) {
		if (offsets[i] !== offsets[i + 1]) {
		filledRelSlots.push(i);
		};
	};

	const secondaryBytes = await Bun.file(secondaryPath).arrayBuffer();
	const secondaryDV = new DataView(secondaryBytes);
	const chunkBytes = await Bun.file(chunkPath).arrayBuffer();
	const chunkDV = new DataView(chunkBytes);
	const chunkSize = chunkBytes.byteLength;

	const blocks: RawChunkBlock[] = [];
	const blockOffs: bigint[] = [];

	for (const relSlot of filledRelSlots) {
		const secOff = offsets[relSlot];
		const blockOff = secondaryDV.getBigUint64(secOff, false);
		const headerOffset = Number(secondaryDV.getUint16(secOff + 8, false));
		const headerSize = Number(secondaryDV.getUint16(secOff + 10, false));
		const crc = secondaryDV.getUint32(secOff + 12, false);
		const headerHash = new Uint8Array(secondaryBytes.slice(secOff + 16, secOff + 48));
		const slotNo = secondaryDV.getBigUint64(secOff + 48, false);

		blockOffs.push(blockOff);
		blocks.push({
			slotNo,
			headerHash,
			blockHash: headerHash, // Cardano block ID = header hash
			blockCbor: new Uint8Array(0), // to be sliced
			headerOffset,
			headerSize,
			crc,
		});
	};

	// Slice block CBORs
	for (let i = 0; i < blocks.length; i++) {
		const startOff = Number(blockOffs[i]);
		const endOff = i < blocks.length - 1 ? Number(blockOffs[i + 1]) : chunkSize;
		const blockCbor = new Uint8Array(chunkBytes, startOff, endOff - startOff);
		blocks[i].blockCbor = blockCbor;
	};

	const logger = new Logger({ logLevel: LogLevel.INFO });
	logger.info(`Parsed chunk ${chunkStr}: ${blocks.length} blocks, slots ${String(blocks[0]?.slotNo ?? 0n)} to ${String(blocks[blocks.length - 1]?.slotNo ?? 0n)}, total size ${chunkSize} bytes`);

	if (blocks.length > 0) 
	{
		logger.info(`Example block 0: hash ${toHex(blocks[0].blockHash)}, size ${blocks[0].blockCbor.length}, slot ${String(blocks[0].slotNo)}`);
	};

	return blocks;
};

async function outputBlocks(blocks: RawChunkBlock[], outDir: string, chunkStr: string) {
	await mkdir(outDir, { recursive: true });
	for (const block of blocks) {
		console.log("block: ", block);
		const slotStr = String(block.slotNo);
		const hashHex = toHex(block.blockHash);
		const fileName = `chunk${chunkStr}_slot${slotStr}_${hashHex}.cbor`;
		const filePath = path.join(outDir, fileName);
		await Bun.write(filePath, block.blockCbor);
		const logger = new Logger({ logLevel: LogLevel.INFO });
		logger.info(`Wrote ${fileName} (${block.blockCbor.length} bytes)`);
	};
};

export async function getCbor(dbPath: string, snapshotRoot: string) {
    // TODO: Implement Mithril snapshot import
    console.log(
        `Mithril import not implemented yet. Snapshot: ${snapshotRoot}, DB: ${dbPath}`,
    );
}

program.name("gerolamo");

export function Main() {
    program
        .command("import-ledger-state")
        .description(
            "Import ledger state from Blockfrost for a specific block",
        )
        .argument(
            "<blockHash>",
            "block hash to import ledger state for",
        )
        .option(
            "--project-id [id]",
            "Blockfrost project ID (optional, uses custom backend if not provided)",
        )
        .option(
            "--custom-backend <url>",
            "Custom Blockfrost backend URL"
            // no default hard-coded URL; use config.blockfrostUrl or explicit arg
        )
        .option(
            "--import-chain",
            "Import chain blocks starting from specified slot",
        )
        .option(
            "--from-slot <number>",
            "Starting slot for chain import",
            parseInt,
        )
        .option("--count <number>", "Number of blocks to import", parseInt)
        .action(async (
            blockHash: string,
            options: {
                dbPath: string;
                projectId?: string;
                customBackend?: string;
                importChain?: boolean;
                fromSlot?: number;
                count?: number;
            },
        ) => {
            const db = new DB(options.dbPath);
            await db.ensureInitialized();
            await initNewEpochState();
            await importFromBlockfrost(db as unknown as Database, blockHash, options);
        });

    program
        .command("start-gerolamo")
        .description(
            "Start the gerolamo node based on config.json settings",
        )
        .action(async () => {
            setupKeyboard();

            const network = process.env.NETWORK ?? "preprod";
            console.log(`Gerolamo Network Node starting on ${network} network...`);

            const configPath = process.env.GEROLAMO_CONFIG ?? getConfigPath(network);
            console.log(`Loading config from ${configPath}`);

            async function loadConfig(filePath: string): Promise<GerolamoConfig> {
                const configFile = Bun.file(filePath);
                if (!(await configFile.exists())) {
                    throw new Error(`Config file not found: ${filePath}`);
                }
                const configData = await configFile.json();
                return configData as GerolamoConfig;
            }

            const config = await loadConfig(configPath);
            const { logger } = await import("./utils/logger");
            logger.setLogConfig(config.logs);
            logger.info("Configuration loaded successfully.");
            if (config.tuiEnabled) {	
            	logger.info("TUI keyboard handler enabled (press 'q' to quit).");
            }
            logger.info(`Database path: ${config.dbPath}`);
            if (config.tuiEnabled) {
            	logger.setLogConfig({ logToConsole: false });
            	logger.info("TUI enabled - console logging disabled to prevent interference.");
            }

            const db = new DB(config.dbPath);
            logger.info("Initializing database...");
            await db.ensureInitialized();
            logger.info("Database initialized and ready.");

            async function runSnapShotPopulation() {
                console.log(`Snapshot population enabled (source: ${config.snapshot.source})`);
                const maxSlot = await db.getMaxSlot();
                console.log(`Current DB max slot: ${maxSlot}`);
                const syncPointSlot = BigInt(config.syncFromPointSlot);
                console.log(`Sync point slot: ${syncPointSlot}`);
                if (maxSlot >= syncPointSlot) {
                    console.log("Database already contains data up to or beyond the sync point slot. Skipping snapshot population.");
                    return;
                };
                const targetEpoch = calculatePreProdCardanoEpoch(config.syncFromPointSlot);
                const fromEpoch = (config.snapshot as any).fromEpoch || 1;
                console.log(`Populating snapshots from epoch ${fromEpoch} to ${targetEpoch}`);
                for (let epoch = fromEpoch; epoch <= targetEpoch; epoch++) {
                    await import("./state/blockfrost/populateEpochState").then(m => m.populateEpochState(
                        db.db, epoch, { 
                        customBackend: config.blockfrostUrl!, projectId: undefined 
                    }));
                }
                console.log(`NES snapshot population complete up to epoch ${targetEpoch}`);    
                return;

            };

            // Run snapshot population if enabled
            if (config.snapshot.enable) 
            {
               await runSnapShotPopulation();
            }

            logger.info("Starting peer manager...");
            await initPeerManager(config);
            logger.info("Peer manager started.");

            logger.info("Starting peer block server...");
            const peerBlockServerMod = await import("./network/peerBlockServer");
            await peerBlockServerMod.startPeerBlockServer(config, null);
            logger.info("Peer block server started. Node is now running.");
        });

    program
        .command("read-raw-chunks")
        .description("Read and optionally output raw blocks from Cardano immutable chunk files")
        .argument("<immutable_dir>", "Directory containing the .primary, .secondary, .chunk files")
        .argument("<chunkNo>", "Chunk number to read")
        .option("--out-dir <dir>", "Directory to output individual block CBOR files")
        .action(async (immutableDir: string, chunkNoStr: string, options: { outDir?: string }) => {
            const chunkNo = parseInt(chunkNoStr);
            if (isNaN(chunkNo)) {
                console.error("Invalid chunk number");
                process.exit(1);
            }
            try {
                const blocks = await parseChunk(immutableDir, chunkNo);
                if (options.outDir) {
                    const chunkStr = chunkNo.toString().padStart(5, "0");
                    await outputBlocks(blocks, options.outDir, chunkStr);
                }
            } catch (err) {
                console.error(err);
                process.exit(1);
            }
        });

    program.parse(process.argv);
}

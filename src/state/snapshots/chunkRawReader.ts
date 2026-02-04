import { toHex } from "@harmoniclabs/uint8array-utils";
import { Logger, LogLevel } from "../../utils/logger";
import { blockParser } from "../../consensus/blockHeaderParser";
import { AllegraHeader, AlonzoHeader, BabbageHeader, ConwayHeader, MaryHeader, MultiEraHeader, ShelleyHeader, MultiEraBlock, BabbageHeaderBody, ConwayHeaderBody } from "@harmoniclabs/cardano-ledger-ts";
const logger = new Logger({ logLevel: LogLevel.INFO });

interface RawChunkBlock {
    slotNo: bigint;
    headerHash: Uint8Array;
    blockHash: Uint8Array;
    blockCbor: Uint8Array;
    headerOffset: number;
    headerSize: number;
    crc: number;
};

export async function parseChunk(dirPath: string, chunkNo: number): Promise<RawChunkBlock[]> {
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

	logger.info(`Parsed chunk ${chunkStr}: ${blocks.length} blocks, slots ${String(blocks[0]?.slotNo ?? 0n)} to ${String(blocks[blocks.length - 1]?.slotNo ?? 0n)}, total size ${chunkSize} bytes`);

	if (blocks.length > 0) 
	{
		logger.info(`Example block 0: hash ${toHex(blocks[0].blockHash)}, size ${blocks[0].blockCbor.length}, slot ${String(blocks[0].slotNo)}, cbor" ${toHex(blocks[0].blockCbor)}`);
	};

	return blocks;
};

async function outputBlocks(blocks: RawChunkBlock[], outDir: string, chunkStr: string) {
	for (const block of blocks) {
		// console.log("block: ", toHex(block.blockCbor));
		const newMultiEraBlock = MultiEraBlock.fromCbor(block.blockCbor);
		console.log("parsed block: ", newMultiEraBlock);
	};	
};

if (import.meta.main) 
{
	const [, , dir, chunkNoStr, outDir] = Bun.argv;
	if (!dir || !chunkNoStr) 
	{
		console.error("Usage: bun src/state/snapshots/chunkRawReader.ts <immutable_dir> <chunkNo> [outDir]");
		process.exit(1);
	}
	const chunkNo = parseInt(chunkNoStr);
	parseChunk(dir, chunkNo)
	.then(async (blocks) => {
		if (outDir) 
		{
			const chunkStr = chunkNo.toString().padStart(5, "0");
			await outputBlocks(blocks, outDir, chunkStr);
		};
	})
	.catch((err) => {
		logger.error(err);
		console.error(err);
		process.exit(1);
	});
};

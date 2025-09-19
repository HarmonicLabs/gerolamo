import { parentPort } from "worker_threads";
import { Cbor, CborArray, CborBytes, CborTag, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { AllegraHeader, AlonzoHeader, BabbageHeader, ConwayHeader, MaryHeader, MultiEraHeader, ShelleyHeader } from "@harmoniclabs/cardano-ledger-ts";
import { logger } from "../../utils/logger";
import { calculateCardanoEpoch, calculatePreProdCardanoEpoch } from "../utils/epochCalculations";
import { validateHeader } from "../../consensus/BlockHeaderValidator";
import { blockFrostFetchEra } from "../utils/blockFrostFetchEra";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { fetchBlock } from "../fetchBlocks";
import { putBlock } from "../lmdbWorkers/lmdb";
import { PeerManager } from '../PeerManager';

parentPort!.on("message", async (msg: any) => {
    if (msg.type === "validateHeader") {
        const { peerId, data, shelleyGenesis, tip } = msg;
        // logger.debug(`Worker received data `, );
        try {
            const dataCbor = Cbor.parse(data);
            
            // ERA directly from Multiplxer ChainSyncRollForward the ERA Enum starts at 0.
            if (!(
                dataCbor instanceof CborArray
            )) throw new Error("Not cboor array");
            // logger.debug("dataCbor", dataCbor.array[1]);
            
            const blockHeaderData: Uint8Array = Cbor.encode(dataCbor.array[1]).toBuffer();
           //  logger.debug("blockHeaderData", toHex(blockHeaderData));
            const lazyHeader = Cbor.parseLazy(blockHeaderData);
            // logger.debug("Lazy Header: ", lazyHeader);
            
            if (!(
                lazyHeader instanceof LazyCborArray
            )) throw new Error("invalid CBOR for header");

            const blockHeaderParsed = Cbor.parse(lazyHeader.array[1]);
            // logger.debug("Block Header Parsed: ", blockHeaderParsed);
            
            if (!(
                blockHeaderParsed instanceof CborTag &&
                blockHeaderParsed.data instanceof CborBytes
            )) throw new Error("invalid CBOR for header body");

            const blockHeaderBodyLazy = Cbor.parseLazy(blockHeaderParsed.data.bytes);
            if (!(
                blockHeaderBodyLazy instanceof LazyCborArray
            )) throw new Error("invalid CBOR for header body");
            // logger.debug("Block Header Body Lazy: ", blockHeaderBodyLazy.array);
            /*
            * We add +1 to era in multiplexer because it enums starts at 0 for the HFC.
            */
            const blcokHeaderBodyEra = lazyHeader.array[0][0] + 1;
            // logger.debug("Header Era: ", blcokHeaderBodyEra);
            // Parse the header based on era
            let parsedHeader;
            switch (blcokHeaderBodyEra) {
                case 2:
                    parsedHeader = ShelleyHeader.fromCbor(blockHeaderParsed.data.bytes);
                    break;
                case 3:
                    parsedHeader = AllegraHeader.fromCbor(blockHeaderParsed.data.bytes);
                    break;
                case 4:
                    parsedHeader = MaryHeader.fromCbor(blockHeaderParsed.data.bytes);
                    break;
                case 5:
                    parsedHeader = AlonzoHeader.fromCbor(blockHeaderParsed.data.bytes);
                    break;
                case 6:
                    parsedHeader = BabbageHeader.fromCbor(blockHeaderParsed.data.bytes);
                    break;
                case 7:
                    parsedHeader = ConwayHeader.fromCbor(blockHeaderParsed.data.bytes);
                    break;
                default:
                    parentPort!.postMessage({ type: "error", id: msg.id, error: "Unsupported era" });
                    return;
            }
            // This is what I need for multiEraHeader
            const multiEraHeader = new MultiEraHeader({
                era: blcokHeaderBodyEra,
                header: parsedHeader,
            });
            // logger.debug("MultiEraHeader: ", multiEraHeader);

            const blockHeaderHash = blake2b_256(blockHeaderParsed.data.bytes);
            const headerEpoch = calculatePreProdCardanoEpoch(Number(multiEraHeader.header.body.slot));
            const epochNonce = await blockFrostFetchEra(headerEpoch as number);
            const slot = multiEraHeader.header.body.slot;

            const validateHeaderRes = await validateHeader(multiEraHeader, fromHex(epochNonce.nonce), shelleyGenesis);
            // logger.debug("Header validation result: ", validateHeaderRes);
            
            logger.debug(`Validated - Era: ${multiEraHeader.era} - Epoch: ${headerEpoch} - Slot: ${slot} of ${tip} - Percent Complete: ${((Number(slot) / Number(tip)) * 100).toFixed(2)}%`);
            
            if (!validateHeaderRes) {
                parentPort!.postMessage({ type: "done", status: "error", id: msg.id, error: "Header validation failed"});
                return;
            }
            
            /*
            const block = await fetchBlock(peerId, slot, blockHeaderHash);
            // logger.debug("Fetched block: ", block.blockData);
            if (block) {
                // Do Block Validation, then apply it to NES then save it to DB.
                await putBlock(blockHeaderHash, block.blockData); // Assuming block is MultiEraBlock; adjust if needed
                // logger.debug(`Stored block for hash ${blockHeaderHash} from peer ${peerId}`);
            } else {
                logger.error(`Failed to fetch block for hash ${blockHeaderHash} from peer ${peerId}`);
                //return ({ slot, blockHeaderHash, multiEraHeader });
            }
            */
            parentPort!.postMessage({ type: "done", status: "ok", id: msg.id, slot, blockHeaderHash});
            
        } catch (error) {
            logger.error("Validation error:", error);
            parentPort!.postMessage({ type: "error", id: msg.id, error: error.message });
        }
    }
});
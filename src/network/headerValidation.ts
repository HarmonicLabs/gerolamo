import { Cbor, CborArray, CborBytes, CborTag, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { AllegraHeader, AlonzoHeader, BabbageHeader, ConwayHeader, MaryHeader, MultiEraHeader, ShelleyHeader } from "@harmoniclabs/cardano-ledger-ts";
import { ChainSyncRollForward } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../utils/logger";
import { calculateCardanoEpoch, calculatePreProdCardanoEpoch } from "./utils/epochCalculations";
import { validateHeader } from "../consensus/BlockHeaderValidator";
import { blockFrostFetchEra } from "./utils/blockFrostFetchEra";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes"
import { RawNewEpochState } from "../rawNES";

export async function headerValidation(data: ChainSyncRollForward, shelleyGenesis: ShelleyGenesisConfig, lState: RawNewEpochState) {
    if (!(
        data.data instanceof CborArray
    )) throw new Error("invalid CBOR for header");
    const tipSlot = data.tip.point.blockHeader?.slotNumber;
    const blockHeaderData: Uint8Array = Cbor.encode(data.data).toBuffer();
    
    const lazyHeader = Cbor.parseLazy(blockHeaderData);
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

    const blcokHeaderBodyEra = lazyHeader.array[0][0];
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
            return null;
    }
    // This is what I need for multiEraHeader
    const multiEraHeader = new MultiEraHeader({
        era: blcokHeaderBodyEra,
        header: parsedHeader,
    });
    // logger.debug("MultiEraHeader: ", multiEraHeader);

	const blockHeaderHash = blake2b_256( blockHeaderParsed.data.bytes );
	const headerEpoch = calculatePreProdCardanoEpoch(Number(multiEraHeader.header.body.slot));
	const epochNonce = await blockFrostFetchEra(headerEpoch as number);
	const slot = multiEraHeader.header.body.slot;
	    
    const validateHeaderRes = await validateHeader(multiEraHeader, fromHex(epochNonce.nonce), shelleyGenesis, lState);
    // logger.debug("Header validation result: ", validateHeaderRes);
    
    logger.debug(
        `Validated - Era: ${blcokHeaderBodyEra} - Epoch: ${headerEpoch} - Slot: ${slot} of ${tipSlot} - Percent Complete: ${
            ((Number(slot) / Number(tipSlot)) * 100).toFixed(2)
        }% \n`,
    );

    if (!validateHeaderRes) return null;

    return ({ slot, blockHeaderHash, multiEraHeader });
};

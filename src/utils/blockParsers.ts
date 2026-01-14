import { Cbor, CborArray, CborBytes, CborTag, LazyCborArray } from "@harmoniclabs/cbor";
import { BlockFetchBlock, BlockFetchNoBlocks } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { AllegraHeader, AlonzoHeader, BabbageHeader, ConwayHeader, MaryHeader, MultiEraHeader, ShelleyHeader, MultiEraBlock, BabbageHeaderBody, ConwayHeaderBody } from "@harmoniclabs/cardano-ledger-ts";
import { ChainSyncRollForward } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "./logger";
import { calculateCardanoEpoch, calculatePreProdCardanoEpoch } from "./epochFromSlotCalculations";
import { blockFrostFetchEra } from "./blockFrostFetchEra";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

export async function headerParser(rollForward: Uint8Array) {
    // ERA directly from Multiplxer ChainSyncRollForward the ERA Enum starts at 0.
    const data = ChainSyncRollForward.fromCbor(toHex(rollForward));
    // logger.debug("Header Parser Data: ", data.data);

    if (!(
        data.data instanceof CborArray
    )) throw new Error("invalid CBOR for header");

    const blockHeaderData: Uint8Array = Cbor.encode(data.data).toBuffer();
    // logger.debug("blockHeaderData", toHex(blockHeaderData));
    const lazyHeader = Cbor.parseLazy(blockHeaderData);
    // logger.debug("Lazy Header: ", lazyHeader);
    if (!(
        lazyHeader instanceof LazyCborArray
    ) || !lazyHeader.array[1]) throw new Error("invalid CBOR for header");

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
    if (!(
        lazyHeader.array[0] !== undefined && lazyHeader.array[0][0] !== undefined
    )) throw new Error("Missing Era in MultiEra header");
    const blcokHeaderBodyEra = lazyHeader.array[0][0] + 1;
    // logger.debug("Multiplexer Era: ", toHex(lazyHeader.array[1]), " Header Era: ", blcokHeaderBodyEra);
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

    const multiEraHeader = new MultiEraHeader({
        era: blcokHeaderBodyEra,
        header: parsedHeader,
    });

    const headerEpoch = calculatePreProdCardanoEpoch(
        Number(multiEraHeader.header.body.slot),
    );
    // const epochNonce = await blockFrostFetchEra(headerEpoch as number);

    const blockHeaderHash = blake2b_256(blockHeaderParsed.data.bytes);
    // logger.debug("validator bytes", toHex(blockHeaderParsed.data.bytes))
    const slot = multiEraHeader.header.body.slot;
    // logger.debug("\nBlockheader hash from validation: ", toHex(blockHeaderHash));
    // logger.debug("Multiera Header: ", multiEraHeader);

    return ({   
        slot,
        blockHeaderHash,
        era: blcokHeaderBodyEra,
    });
}

export async function blockParser(
    newBlock: BlockFetchNoBlocks | BlockFetchBlock,
)
{
    if (!(
        newBlock instanceof BlockFetchBlock
    )) return;

    const lazyBlock = Cbor.parseLazy(newBlock.blockData);
    if (!(
        lazyBlock instanceof LazyCborArray
    )) throw new Error("invalid CBOR for block");
    
    const newMultiEraBlock = MultiEraBlock.fromCbor(newBlock.blockData);

    return newMultiEraBlock;
};

//** Calculating block_body_hash **//
/**
     
     * The block_body_hash is not a simple blake2b_256 hash of the entire serialized block body.
     * Instead, it is a Merkle root-like hash (often referred to as a "Merkle triple root" or quadruple root, depending on the era) of the key components of the block body.
     * This design allows for efficient verification of the block's contents (transactions, witnesses, metadata, etc.) without re-serializing the entire body,
     * while enabling segregated witness handling (introduced in the Alonzo era and carried forward).
     * blake2b_256(
        concatUint8Arr(
            blake2b_256( tx_bodies ),
            blake2b_256( tx_witnesses ),
            blake2b_256( tx_metadatas ),
            blake2b_256( tx_invalidTxsIdxs ),
        )
    )
*/

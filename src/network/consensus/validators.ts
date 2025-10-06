import {
    Cbor,
    CborArray,
    CborBytes,
    CborTag,
    LazyCborArray,
} from "@harmoniclabs/cbor";
import {
    BlockFetchBlock,
    BlockFetchNoBlocks,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { AllegraHeader, AlonzoHeader, BabbageHeader, ConwayHeader, MaryHeader, MultiEraHeader, ShelleyHeader, MultiEraBlock, BabbageHeaderBody, ConwayHeaderBody, VrfProofBytes, VrfProofHash, VrfCert } from "@harmoniclabs/cardano-ledger-ts";
import { ChainSyncRollForward } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../../utils/logger";
import { calculateCardanoEpoch, calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { ValidatePostBabbageHeader, ValidatePreBabbageHeader } from "./BlockHeaderValidator";
import { blockFrostFetchEra } from "../utils/blockFrostFetchEra";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { ShelleyGenesisConfig } from "../../config/preprod/ShelleyGenesisTypes"

/*
THIS NEEDS TO BE WITH THE CONSENSUS WORKER
*/

export async function headerValidation(data: ChainSyncRollForward, shelleyGenesis: ShelleyGenesisConfig) {
    // logger.debug("validating header...")
    // ERA directly from Multiplxer ChainSyncRollForward the ERA Enum starts at 0.
    if (
        !(
            data.data instanceof CborArray
        )
    ) throw new Error("invalid CBOR for header");
    const tipSlot = data.tip.point.blockHeader?.slotNumber;
    const blockHeaderData: Uint8Array = Cbor.encode(data.data).toBuffer();
    // logger.debug("blockHeaderData", toHex(blockHeaderData));
    const lazyHeader = Cbor.parseLazy(blockHeaderData);
    // logger.debug("Lazy Header: ", lazyHeader);
    if (
        !(
            lazyHeader instanceof LazyCborArray
        )
    ) throw new Error("invalid CBOR for header");

    const blockHeaderParsed = Cbor.parse(lazyHeader.array[1]);
    // logger.debug("Block Header Parsed: ", blockHeaderParsed);
    if (
        !(
            blockHeaderParsed instanceof CborTag &&
            blockHeaderParsed.data instanceof CborBytes
        )
    ) throw new Error("invalid CBOR for header body");

    const blockHeaderBodyLazy = Cbor.parseLazy(blockHeaderParsed.data.bytes);
    if (
        !(
            blockHeaderBodyLazy instanceof LazyCborArray
        )
    ) throw new Error("invalid CBOR for header body");
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
            return null;
    }
    // This is what I need for multiEraHeader
    const multiEraHeader = new MultiEraHeader({
        era: blcokHeaderBodyEra,
        header: parsedHeader,
    });
    // logger.debug("MultiEraHeader: ", (multiEraHeader.header.body instanceof BabbageHeaderBody || multiEraHeader.header.body instanceof ConwayHeaderBody) ? multiEraHeader.header.body.vrfResult.toCborBytes() : multiEraHeader.header.body.nonceVrfResult);
    // logger.debug("multieraheader bytes:, ", multiEraHeader.toCborBytes());
    const blockHeaderHash = blake2b_256(blockHeaderParsed.data.bytes);
    const headerEpoch = calculatePreProdCardanoEpoch(
        Number(multiEraHeader.header.body.slot),
    );
    const epochNonce = await blockFrostFetchEra(headerEpoch as number);
    const slot = multiEraHeader.header.body.slot;

    // const validateHeaderRes = await validateHeader(multiEraHeader, fromHex(epochNonce.nonce), shelleyGenesis);
    const validateHeader = multiEraHeader.header.body instanceof BabbageHeaderBody || multiEraHeader.header.body instanceof ConwayHeaderBody ? new ValidatePostBabbageHeader() : new ValidatePreBabbageHeader();
    const validateHeaderRes = await validateHeader.validate(multiEraHeader, fromHex(epochNonce.nonce), shelleyGenesis);
    // logger.debug("Header validation result: ", validateHeaderRes);
    
    const nonceVrfCert: VrfCert = multiEraHeader.header.body instanceof BabbageHeaderBody || multiEraHeader.header.body instanceof ConwayHeaderBody ? multiEraHeader.header.body.vrfResult : multiEraHeader.header.body.nonceVrfResult;
    const nonceVrfProofBytes: VrfProofBytes = multiEraHeader.header.body instanceof BabbageHeaderBody || multiEraHeader.header.body instanceof ConwayHeaderBody ? multiEraHeader.header.body.vrfResult.proof : multiEraHeader.header.body.nonceVrfResult.proof;
    const nonceVrfProofHash: VrfProofHash =  multiEraHeader.header.body instanceof BabbageHeaderBody || multiEraHeader.header.body instanceof ConwayHeaderBody ? multiEraHeader.header.body.vrfResult.proofHash : multiEraHeader.header.body.nonceVrfResult.proofHash;
    // logger.debug("nonceVrfCert: ", nonceVrfCert.toCborBytes());

    if (!validateHeaderRes) return;
    return {
        era: blcokHeaderBodyEra,
        epochNonce: fromHex(epochNonce.nonce),
        epoch: headerEpoch,
        slot,
        blockHeaderHash,
        multiEraHeader: multiEraHeader.toCborBytes(),
        nonceVrfProofBytes: nonceVrfProofBytes,
        nonceVrfProofHash: nonceVrfProofHash
    };
}

export async function blockValidation(
    newBlock: BlockFetchNoBlocks | BlockFetchBlock,
) {
    if (
        !(
            newBlock instanceof BlockFetchBlock
        )
    ) return;
    // newBlock.blockData is Uint8Array of the validated block headers block
    const lazyBlock = Cbor.parseLazy(newBlock.blockData);
    if (
        !(
            lazyBlock instanceof LazyCborArray
        )
    ) throw new Error("invalid CBOR for block");

    // logger.debug("Lazy: ", toHex(newBlock.blockData))
    // logger.log("Block Era: ", blockEra);
    // logger.debug("block: ", block);
    logger.debug("Block data: ", toHex(newBlock.blockData), "\n\n\n");
    const newMultiEraBlock = MultiEraBlock.fromCbor(toHex(newBlock.blockData))
    // logger.debug("MultiEraBlock: ", newMultiEraBlock);
    // Call function here that does block applicaiton here which takes multiEraHeader.
    return newMultiEraBlock;
};

//**
/**
     * Calculating block_body_hash
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

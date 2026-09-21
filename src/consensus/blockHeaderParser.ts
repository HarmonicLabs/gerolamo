import {
    Cbor,
    CborArray,
    CborBytes,
    CborTag,
    CborUInt,
    LazyCborArray,
} from "@harmoniclabs/cbor";
import {
    BlockFetchBlock,
    BlockFetchNoBlocks,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import {
    AllegraHeader,
    AlonzoHeader,
    BabbageHeader,
    BabbageHeaderBody,
    ByronBlockHeaderBody,
    ByronEbbHead,
    ConwayHeader,
    ConwayHeaderBody,
    MaryHeader,
    MultiEraBlock,
    MultiEraHeader,
    ShelleyHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { ChainSyncRollForward } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../utils/logger";
import {
    calculateCardanoEpoch,
    calculatePreProdCardanoEpoch,
} from "../utils/epochFromSlotCalculations";
import { getHeaderPrevHashHex, getHeaderSlot } from "../utils/eraAccessors";
import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Era numbering (matches cardano-ledger-ts `MultiEraHeader` / `MultiEraBlock`):
 *   0 = Byron epoch-boundary block (EBB), 1 = Byron main block,
 *   2 = Shelley, 3 = Allegra, 4 = Mary, 5 = Alonzo, 6 = Babbage, 7 = Conway.
 *
 * N2N ChainSync headers carry the hard-fork-combinator era index instead
 * (0 = Byron, 1 = Shelley, … 6 = Conway); Shelley+ is `[hfcEra, #6.24(header)]`
 * so ledger era = hfcEra + 1. Byron is the odd one out:
 *   `[0, [[byronType, blockSizeHint], #6.24(header)]]`
 * where byronType 0 = EBB and 1 = main block — which is exactly the ledger era.
 *
 * BlockFetch blocks are already `[ledgerEra, block]` for every era, Byron
 * included (`[0, ebblock]` / `[1, mainblock]`).
 */
export const BYRON_EBB_ERA = 0;
export const BYRON_MAIN_ERA = 1;

export function isByronEra(era: number): boolean {
    return era === BYRON_EBB_ERA || era === BYRON_MAIN_ERA;
}

/**
 * Byron header hash = blake2b-256 over the CBOR of `[byronType, header]`,
 * i.e. the raw header bytes prefixed with `0x82 0x00` (EBB) or `0x82 0x01`
 * (main block). Verified against preprod: epoch-0 EBB hashes to
 * 9ad7ff32…97d2 and every following header's prevBlock links to it.
 */
export function byronHeaderHash(
    byronType: number,
    rawHeaderBytes: Uint8Array,
): Uint8Array {
    if (byronType !== BYRON_EBB_ERA && byronType !== BYRON_MAIN_ERA) {
        throw new Error(`byronHeaderHash: invalid Byron block type ${byronType}`);
    }
    const prefixed = new Uint8Array(2 + rawHeaderBytes.length);
    prefixed[0] = 0x82; // CBOR array(2)
    prefixed[1] = byronType; // CBOR uint 0 / 1
    prefixed.set(rawHeaderBytes, 2);
    return blake2b_256(prefixed);
}

/** Era-aware header hash from the raw header bytes of a block. */
export function headerHashForEra(
    era: number,
    rawHeaderBytes: Uint8Array,
): Uint8Array {
    return isByronEra(era)
        ? byronHeaderHash(era, rawHeaderBytes)
        : blake2b_256(rawHeaderBytes);
}

export interface BlockFetchHeaderIdentity {
    /** Ledger era (0 EBB, 1 Byron main, 2.. Shelley+). */
    era: number;
    /** Raw header bytes exactly as they appear inside the block. */
    rawHeaderBytes: Uint8Array;
    /** Era-aware block header hash. */
    hash: Uint8Array;
}

/**
 * Pull the raw header out of a BlockFetch block payload (`[era, [header, …]]`)
 * without re-encoding, and hash it with the era's rule. Re-encoding through
 * the ledger classes is not guaranteed byte-exact for Byron, so hashing the
 * original bytes is the only safe way to compare against ChainSync headers.
 */
export function blockFetchHeaderIdentity(
    blockData: Uint8Array,
): BlockFetchHeaderIdentity {
    const outer = Cbor.parseLazy(blockData);
    if (!(outer instanceof LazyCborArray) || outer.array.length < 2) {
        throw new Error("blockFetchHeaderIdentity: block is not [era, block]");
    }
    const eraObj = Cbor.parse(outer.array[0]!);
    if (!(eraObj instanceof CborUInt)) {
        throw new Error("blockFetchHeaderIdentity: era is not a CBOR uint");
    }
    const era = Number(eraObj.num);
    const inner = Cbor.parseLazy(outer.array[1]!);
    if (!(inner instanceof LazyCborArray) || inner.array.length < 1) {
        throw new Error("blockFetchHeaderIdentity: block body is not an array");
    }
    const rawHeaderBytes = inner.array[0]!;
    return { era, rawHeaderBytes, hash: headerHashForEra(era, rawHeaderBytes) };
}

export interface ParsedHeader {
    slot: bigint;
    blockHeaderHash: Uint8Array;
    /** Ledger era (see file header). */
    era: number;
    multiEraHeader: MultiEraHeader;
    epoch: number;
    isByron: boolean;
    /** Byron epoch-boundary block: no slot leader, no transactions. */
    isEbb: boolean;
    /** Raw header bytes (the `#6.24` payload). */
    rawHeaderBytes: Uint8Array;
    /** Previous block hash from the header (Byron `prevBlock`, Shelley+ `prev_hash`). */
    prevHashHex: string | null;
    /**
     * Byron main blocks only, filled by the validation workers: the block signature
     * (and delegation certificate) verified, issued by `issuerKeyHash` and signed by
     * `signerKeyHash`. The OBFT state checks on the main thread build on it.
     */
    byronSig?: { issuerKeyHash: string; signerKeyHash: string };
}

/**
 * Everything the orchestrator needs from a header, without the decoded
 * `MultiEraHeader`. Validation workers return exactly these fields, so the
 * main thread no longer parses every header itself.
 */
export type HeaderSummary = Omit<ParsedHeader, "multiEraHeader"> & {
    /** Shelley+ facts the main-thread leader rules consume (from the validation worker). */
    shelley?: { issuerHash: string; vrfKeyHash: string; leaderValue: Uint8Array; opcertCounter: number; opcertKesPeriod: number };
    /** VRF proofs and the leader rule still to be checked (the epoch nonce was not derivable yet). */
    vrfDeferred?: boolean;
};

function readUInt(bytes: Uint8Array, what: string): number {
    const obj = Cbor.parse(bytes);
    if (!(obj instanceof CborUInt)) {
        throw new Error(`invalid CBOR for header: ${what} is not a uint`);
    }
    return Number(obj.num);
}

function readTag24Bytes(bytes: Uint8Array, what: string): Uint8Array {
    const obj = Cbor.parse(bytes);
    if (
        !(obj instanceof CborTag && Number(obj.tag) === 24 &&
            obj.data instanceof CborBytes)
    ) {
        logger.error(
            `Invalid CBOR for header body: ${what} not CborTag(24) with CborBytes`,
        );
        throw new Error("invalid CBOR for header body");
    }
    return obj.data.bytes;
}

/**
 * Byron ChainSync header: `[[byronType, sizeHint], #6.24(header)]`.
 * `wrapperBytes` is the raw CBOR of that inner array.
 */
function parseByronChainSyncHeader(wrapperBytes: Uint8Array): ParsedHeader {
    const wrapper = Cbor.parseLazy(wrapperBytes);
    if (!(wrapper instanceof LazyCborArray) || wrapper.array.length < 2) {
        logger.error("Invalid CBOR for Byron header: wrapper not [prefix, tag24]");
        throw new Error("invalid CBOR for header body");
    }
    const prefix = Cbor.parse(wrapper.array[0]!);
    if (
        !(prefix instanceof CborArray && prefix.array.length >= 1 &&
            prefix.array[0] instanceof CborUInt)
    ) {
        logger.error("Invalid CBOR for Byron header: prefix not [type, size]");
        throw new Error("invalid CBOR for header body");
    }
    const byronType = Number((prefix.array[0] as CborUInt).num);
    if (!isByronEra(byronType)) {
        throw new Error(`invalid Byron header type ${byronType}`);
    }
    const rawHeaderBytes = readTag24Bytes(wrapper.array[1]!, "byron header");

    // Pass bytes (not CborObj) into cardano-ledger-ts: the library may resolve
    // its own copy of @harmoniclabs/cbor, which breaks cross-package instanceof.
    const header = byronType === BYRON_EBB_ERA
        ? ByronEbbHead.fromCbor(rawHeaderBytes)
        : ByronBlockHeaderBody.fromCbor(rawHeaderBytes);
    const multiEraHeader = new MultiEraHeader({ era: byronType, header });

    const slot = getHeaderSlot(header);
    const blockHeaderHash = byronHeaderHash(byronType, rawHeaderBytes);
    const prev = header.prevBlock as unknown as { toBuffer?: () => Uint8Array };
    const prevHashHex = typeof prev?.toBuffer === "function"
        ? toHex(prev.toBuffer())
        : prev instanceof Uint8Array
        ? toHex(prev)
        : null;


    return {
        slot,
        blockHeaderHash,
        era: byronType,
        multiEraHeader,
        epoch: Number(calculatePreProdCardanoEpoch(slot)),
        isByron: true,
        isEbb: byronType === BYRON_EBB_ERA,
        rawHeaderBytes,
        prevHashHex,
    };
}

/**
 * The ChainSync MsgRollForward a peer would have sent for a block we hold as `[era, block]`
 * bytes: `[2, [era − 1, #6.24(header)], [[slot, hash], blockNo]]`. `headerParser` and the
 * volatile header row take that whole message, not the inner `[era − 1, #6.24(header)]`
 * (2026-09-12 01:31 UTC: the first forged block was rejected as "header does not parse"
 * because adoptLocalBlock passed the inner pair). Shelley+ only: nothing forges Byron.
 */
export function localRollForwardMessage(blockFetchBytes: Uint8Array): { bytes: Uint8Array; slot: bigint; blockNo: bigint; hashHex: string; era: number } {
    const id = blockFetchHeaderIdentity(blockFetchBytes);
    if (isByronEra(id.era)) throw new Error("localRollForwardMessage: Byron blocks are not forged locally");
    const hdr = Cbor.parseLazy(id.rawHeaderBytes);
    if (!(hdr instanceof LazyCborArray) || hdr.array.length < 2) throw new Error("localRollForwardMessage: header is not [body, signature]");
    const body = Cbor.parseLazy(hdr.array[0]!);
    if (!(body instanceof LazyCborArray) || body.array.length < 2) throw new Error("localRollForwardMessage: header body is not an array");
    const blockNo = BigInt(readUInt(body.array[0]!, "block number"));
    const slot = BigInt(readUInt(body.array[1]!, "slot"));
    const bytes = Cbor.encode(new CborArray([
        new CborUInt(2n),
        new CborArray([new CborUInt(BigInt(id.era - 1)), new CborTag(24, new CborBytes(id.rawHeaderBytes))]),
        new CborArray([new CborArray([new CborUInt(slot), new CborBytes(id.hash)]), new CborUInt(blockNo)]),
    ])).toBuffer();
    return { bytes, slot, blockNo, hashHex: Buffer.from(id.hash).toString("hex"), era: id.era };
}

export async function headerParser(
    rollForward: Uint8Array,
): Promise<ParsedHeader | null> {
    // ERA directly from Multiplxer ChainSyncRollForward the ERA Enum starts at 0.
    const data = ChainSyncRollForward.fromCbor(rollForward); // bytes in: no hex round trip (was ~2 % of the main thread)
    // logger.debug("Header Parser Data: ", data.data);

    if (
        !(
            data.data instanceof CborArray
        )
    ) {
        logger.error("Invalid CBOR for header: data not CborArray");
        throw new Error("invalid CBOR for header");
    }

    const blockHeaderData: Uint8Array = Cbor.encode(data.data).toBuffer();
    // logger.debug("blockHeaderData", toHex(blockHeaderData));
    const lazyHeader = Cbor.parseLazy(blockHeaderData);
    // logger.debug("Lazy Header: ", lazyHeader);
    if (
        !(
            lazyHeader instanceof LazyCborArray
        ) || !lazyHeader.array[0] || !lazyHeader.array[1]
    ) {
        logger.error(
            "Invalid CBOR for header: lazyHeader not LazyCborArray or missing array[1]",
        );
        throw new Error("invalid CBOR for header");
    }

    const hfcEra = readUInt(lazyHeader.array[0], "era");
    if (hfcEra === 0) {
        return parseByronChainSyncHeader(lazyHeader.array[1]);
    }

    const rawHeaderBytes = readTag24Bytes(lazyHeader.array[1], "header");

    const blockHeaderBodyLazy = Cbor.parseLazy(rawHeaderBytes);
    if (
        !(
            blockHeaderBodyLazy instanceof LazyCborArray
        )
    ) {
        logger.error("Invalid CBOR for header body: not LazyCborArray");
        throw new Error("invalid CBOR for header body");
    }
    /*
     * We add +1 to era in multiplexer because it enums starts at 0 for the HFC.
     */
    const blockHeaderBodyEra = hfcEra + 1;
    // Parse the header based on era
    let parsedHeader;
    switch (blockHeaderBodyEra) {
        case 2:
            parsedHeader = ShelleyHeader.fromCbor(rawHeaderBytes);
            break;
        case 3:
            parsedHeader = AllegraHeader.fromCbor(rawHeaderBytes);
            break;
        case 4:
            parsedHeader = MaryHeader.fromCbor(rawHeaderBytes);
            break;
        case 5:
            parsedHeader = AlonzoHeader.fromCbor(rawHeaderBytes);
            break;
        case 6:
            parsedHeader = BabbageHeader.fromCbor(rawHeaderBytes);
            break;
        case 7:
            parsedHeader = ConwayHeader.fromCbor(rawHeaderBytes);
            break;
        default:
            return null;
    }

    const multiEraHeader = new MultiEraHeader({
        era: blockHeaderBodyEra,
        header: parsedHeader,
    });

    const slot = getHeaderSlot(multiEraHeader.header);
    const headerEpoch = calculatePreProdCardanoEpoch(Number(slot));

    const blockHeaderHash = blake2b_256(rawHeaderBytes);


    return ({
        slot,
        blockHeaderHash,
        era: blockHeaderBodyEra,
        multiEraHeader,
        epoch: Number(headerEpoch),
        isByron: false,
        isEbb: false,
        rawHeaderBytes,
        prevHashHex: getHeaderPrevHashHex(multiEraHeader.header) || null,
    });
}

/** Multi Era Block Parser */
export async function blockParser(
    newBlock: BlockFetchNoBlocks | BlockFetchBlock,
) {
    if (
        !(
            newBlock instanceof BlockFetchBlock
        )
    ) return;

    // Structure is checked by MultiEraBlock.fromCbor itself; the range was already
    // identity- and body-hash-verified from these same bytes (no extra lazy parse).
    const newMultiEraBlock = MultiEraBlock.fromCbor(newBlock.blockData);


    return newMultiEraBlock;
}

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

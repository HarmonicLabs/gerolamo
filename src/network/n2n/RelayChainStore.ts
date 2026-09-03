import type { CborObj } from "@harmoniclabs/cbor";
import type {
    ChainPoint,
    ChainTip,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";

export interface RelayIntersection {
    point: ChainPoint;
    blockNo: bigint;
}

export interface RelayHeader extends RelayIntersection {
    /** ChainSync RollForward data field (the header payload, not its envelope). */
    data: CborObj;
}

export interface RelayBlock extends RelayIntersection {
    /** Raw multi-era block CBOR used inside MsgBlock. */
    blockData: Uint8Array;
}

export interface RelayChainStore {
    getTip(): Promise<ChainTip>;
    findIntersect(
        points: readonly ChainPoint[],
    ): Promise<RelayIntersection | undefined>;
    getNextHeader(after: ChainPoint): Promise<RelayHeader | undefined>;
    getBlockRange(
        from: ChainPoint,
        to: ChainPoint,
        maxBlocks: number,
    ): Promise<RelayBlock[] | undefined>;
}

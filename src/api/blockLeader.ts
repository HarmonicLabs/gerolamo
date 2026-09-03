import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import {
    AllegraHeader,
    AlonzoHeader,
    BabbageHeader,
    ConwayHeader,
    MaryHeader,
    ShelleyHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { blockFetchHeaderIdentity } from "../consensus/blockHeaderParser";
import { byronKeyHash, sliceByronMainHeader } from "../consensus/byron/ByronCrypto";

/**
 * Blockfrost `slot_leader` for a stored block: the hash of the key that issued
 * it. Shelley+: blake2b-224 of the header's issuer vkey (= the pool id, hex).
 * Byron main blocks: the genesis/delegate key hash from the header. EBBs have
 * no issuer. Never throws: undecodable → null.
 */
export function slotLeaderOfBlock(blockData: Uint8Array): string | null {
    try {
        const id = blockFetchHeaderIdentity(blockData);
        return slotLeaderOfHeader(id.era, id.rawHeaderBytes);
    } catch {
        return null;
    }
}

export function slotLeaderOfHeader(era: number, rawHeader: Uint8Array): string | null {
    try {
        if (era === 0) return null; // Byron epoch-boundary block
        if (era === 1) return byronKeyHash(sliceByronMainHeader(rawHeader).headerPubKey);
        let header: { body: { issuerPubKey: Uint8Array } };
        switch (era) {
            case 2: header = ShelleyHeader.fromCbor(rawHeader) as any; break;
            case 3: header = AllegraHeader.fromCbor(rawHeader) as any; break;
            case 4: header = MaryHeader.fromCbor(rawHeader) as any; break;
            case 5: header = AlonzoHeader.fromCbor(rawHeader) as any; break;
            case 6: header = BabbageHeader.fromCbor(rawHeader) as any; break;
            case 7: header = ConwayHeader.fromCbor(rawHeader) as any; break;
            default: return null;
        }
        const vk = header.body.issuerPubKey;
        return vk instanceof Uint8Array && vk.length === 32 ? toHex(blake2b_224(vk)) : null;
    } catch {
        return null;
    }
}

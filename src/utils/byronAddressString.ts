/**
 * ledger-ts decodes a Byron bootstrap address inside a Shelley-era output as an
 * `Address` of type "byron": the object keeps only 28 bytes (a bogus bech32
 * `addr…prvpsk…` when stringified) and a meaningless `network`. The original
 * CBOR is still referenced by `cborRef`; rebuild the real base58 address from it
 * so stored outputs can be spent with a bootstrap witness later.
 */
import { toHex } from "@harmoniclabs/uint8array-utils";
import { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborBytes } from "@harmoniclabs/cbor";
import { rawAddressBytesOf, shelleyAddressBech32 } from "../db/stakeCred";

export function isByronTypedAddress(a: any): boolean {
    return a != null && typeof a === "object" && String(a.type ?? "").toLowerCase() === "byron";
}

/** Base58 of a "byron"-typed ledger-ts Address (from its CBOR slice), or null when it cannot be rebuilt. */
export function byronBase58Of(a: any): string | null {
    try {
        const ref = a?.cborRef;
        const bytes: Uint8Array | undefined = ref?._bytes;
        if (!bytes || typeof ref.start !== "number" || typeof ref.end !== "number") return null;
        const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + ref.start, ref.end - ref.start);
        const parsed: any = Cbor.parse(slice);
        const raw: Uint8Array | undefined = parsed instanceof CborBytes ? parsed.bytes : parsed?.bytes;
        if (!(raw instanceof Uint8Array)) return null;
        return ByronAddress.fromBytes(raw).toBase58();
    } catch {
        return null;
    }
}

// bech32 of the same address bytes, once: outputs concentrate on a few thousand addresses
// (batchers, faucets, dApp scripts) and the polymod per output was 6 % of the applier thread.
const addressStringCache = new Map<string, string>();
const ADDRESS_STRING_CACHE_MAX = 50_000;

/** String form of any output address: base58 for Byron (including "byron"-typed Shelley objects), bech32 otherwise. */
export function outputAddressString(a: any): string {
    if (a == null) return "";
    const raw = rawAddressBytesOf(a);
    const key = raw ? toHex(raw) : null;
    if (key) {
        const hit = addressStringCache.get(key);
        if (hit !== undefined) return hit;
    }
    const s = outputAddressStringUncached(a);
    if (key && s) {
        if (addressStringCache.size >= ADDRESS_STRING_CACHE_MAX) addressStringCache.clear();
        addressStringCache.set(key, s);
    }
    return s;
}

function outputAddressStringUncached(a: any): string {
    try {
        if (typeof a.toBase58 === "function") return String(a.toBase58());
        if (isByronTypedAddress(a)) {
            const b58 = byronBase58Of(a);
            if (b58) return b58;
        }
        // ledger-ts drops the pointer when it re-encodes a pointer address (type 4/5);
        // keep the full form from the raw bytes so the stake pointer stays recoverable.
        if (String(a.type ?? "").toLowerCase() === "pointer") {
            const raw = rawAddressBytesOf(a);
            if (raw && raw.length > 29) return shelleyAddressBech32(raw);
        }
        // Any other Shelley payment address (types 0–7) from its raw bytes: ledger-ts's toString
        // goes through the library's bit-string bech32 encoder (9 % of the applier, 2026-09-07).
        const raw = rawAddressBytesOf(a);
        if (raw && raw.length >= 29 && (raw[0]! >> 4) <= 7) return shelleyAddressBech32(raw);
        if (typeof a.toString === "function") {
            const s = String(a.toString());
            return s === "[object Object]" ? "" : s;
        }
    } catch {
        /* fall through */
    }
    return "";
}

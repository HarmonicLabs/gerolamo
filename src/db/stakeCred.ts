/**
 * Stake credentials are (type, hash) in the ledger: a key credential and a
 * script credential with the same 28 bytes are two different accounts. Every
 * table and map that keys stake by credential uses the *typed hex* form:
 *   key credential    → 56 hex chars (the hash, unchanged)
 *   script credential → "01" + 56 hex chars
 * The byte form follows (28 bytes / 0x01 + 28 bytes), so `rewards.stake_credentials`
 * blobs stay distinct too. Preprod slot 22056654/22056832 registers such a twin
 * pair, and 830 UTxOs at script-stake addresses were attributed to the key
 * account (2.2·10⁹ lovelace, +6·10⁻⁵ on the epoch's total active stake).
 */

export type CredType = 0 | 1;

/** 0 for a key hash, 1 for a script hash; from ledger-ts credential objects or CBOR/enum numbers. */
export function credTypeOf(cred: any): CredType {
    const t = cred?.type ?? cred?.credentialType ?? cred;
    if (t === 1 || t === "script" || t === "Script") return 1;
    return 0;
}

export function typedCredHex(type: number | null | undefined, hashHex: string): string {
    const h = hashHex.toLowerCase();
    return type === 1 ? `01${h}` : h;
}

/** Typed hex of a ledger-ts `Credential` / `StakeCredentials` (null for pointers / unknown shapes). */
export function typedCredHexOf(cred: any): string | null {
    const h = cred?.hash ?? cred?.credentials?.hash;
    if (!h || Array.isArray(h)) return null;
    const hex = typeof h === "string" ? h : typeof h.toString === "function" ? String(h.toString()) : null;
    if (!hex || !/^[0-9a-f]{56}$/i.test(hex)) return null;
    return typedCredHex(credTypeOf(cred?.type != null ? cred : cred?.credentials), hex);
}

export function typedCredBytes(type: number | null | undefined, hash: Uint8Array): Uint8Array {
    if (type !== 1) return hash;
    const out = new Uint8Array(1 + hash.length);
    out[0] = 0x01;
    out.set(hash, 1);
    return out;
}

/** True when a Shelley address header byte says the stake part is a script hash (types 2 and 3) or a script reward address (0xf). */
export function headerStakeIsScript(header: number): boolean {
    const t = header >> 4;
    return t === 2 || t === 3 || t === 0xf;
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Header byte of a bech32 Shelley address without decoding the whole string; null when it is not bech32. */
export function bech32HeaderByte(address: string): number | null {
    const sep = address.lastIndexOf("1");
    if (sep < 1 || address.length < sep + 3) return null;
    const a = BECH32.indexOf(address[sep + 1]!.toLowerCase());
    const b = BECH32.indexOf(address[sep + 2]!.toLowerCase());
    if (a < 0 || b < 0) return null;
    return ((a << 3) | (b >> 2)) & 0xff;
}

/** Raw bytes of a ledger-ts Address from the CBOR slice it was parsed from (null when unavailable). */
export function rawAddressBytesOf(a: any): Uint8Array | null {
    try {
        const ref = a?.cborRef;
        const bytes: Uint8Array | undefined = ref?._bytes;
        if (!bytes || typeof ref.start !== "number" || typeof ref.end !== "number") return null;
        const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + ref.start, ref.end - ref.start);
        // The slice is the CBOR bytestring holding the address: header byte(s) then the payload.
        const first = slice[0]!;
        let off = 1;
        if (first === 0x58) off = 2;
        else if (first === 0x59) off = 3;
        else if ((first & 0xe0) !== 0x40) return null;
        return slice.subarray(off);
    } catch {
        return null;
    }
}

/** Shelley pointer (slot, tx index, cert index) from raw address bytes of type 4/5, or null. */
export function pointerFromAddressBytes(raw: Uint8Array): { slot: number; txIx: number; certIx: number } | null {
    if (!raw || raw.length < 32) return null;
    const t = raw[0]! >> 4;
    if (t !== 4 && t !== 5) return null;
    let i = 29;
    const varint = (): number | null => {
        let v = 0;
        for (let n = 0; n < 10; n++) {
            if (i >= raw.length) return null;
            const x = raw[i++]!;
            v = v * 128 + (x & 127);
            if ((x & 128) === 0) return v;
        }
        return null;
    };
    const slot = varint(), txIx = varint(), certIx = varint();
    if (slot == null || txIx == null || certIx == null) return null;
    return { slot, txIx, certIx };
}

const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values: number[]): number {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]!;
    }
    return chk >>> 0;
}
/** bech32 (BIP-173) encoding of `bytes` under `hrp`; used for the address forms ledger-ts cannot re-encode (pointer). */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
    const words: number[] = [];
    let acc = 0, bits = 0;
    for (const b of bytes) {
        acc = (acc << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
    }
    if (bits > 0) words.push((acc << (5 - bits)) & 31);
    const hrpExp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    const pm = bech32Polymod(hrpExp.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
    const checksum = Array.from({ length: 6 }, (_, i) => (pm >> (5 * (5 - i))) & 31);
    return hrp + "1" + words.concat(checksum).map((w) => BECH32_CHARS[w]).join("");
}

/** Full bech32 of a Shelley address from its raw bytes (mainnet/testnet from the header nibble). */
export function shelleyAddressBech32(raw: Uint8Array): string {
    return bech32Encode((raw[0]! & 0x0f) === 1 ? "addr" : "addr_test", raw);
}


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
/** bech32 (BIP-173) encoding of `bytes` under `hrp`. Typed-array implementation: the library
 * encoder (`encodeBech32`, bit strings + reduce/padStart) was 9 % of the applier on dense blocks. */
const BECH32_CODES = new Uint8Array([...BECH32_CHARS].map((c) => c.charCodeAt(0)));
const hrpExpansions = new Map<string, Uint8Array>();
function hrpExpansion(hrp: string): Uint8Array {
    let e = hrpExpansions.get(hrp);
    if (!e) {
        e = new Uint8Array(hrp.length * 2 + 1);
        for (let i = 0; i < hrp.length; i++) { e[i] = hrp.charCodeAt(i) >> 5; e[hrp.length + 1 + i] = hrp.charCodeAt(i) & 31; }
        hrpExpansions.set(hrp, e);
    }
    return e;
}
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
    const exp = hrpExpansion(hrp);
    const nWords = Math.ceil((bytes.length * 8) / 5);
    // polymod runs over hrp expansion + data words + six zero words
    const seq = new Uint8Array(exp.length + nWords + 6);
    seq.set(exp);
    let acc = 0, bits = 0, k = exp.length;
    for (let i = 0; i < bytes.length; i++) {
        acc = ((acc << 8) | bytes[i]!) & 0x1fff; bits += 8;
        while (bits >= 5) { bits -= 5; seq[k++] = (acc >> bits) & 31; }
    }
    if (bits > 0) seq[k++] = (acc << (5 - bits)) & 31;
    let chk = 1;
    for (let i = 0; i < seq.length; i++) {
        const b = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ seq[i]!;
        if (b & 1) chk ^= 0x3b6a57b2;
        if (b & 2) chk ^= 0x26508e6d;
        if (b & 4) chk ^= 0x1ea119fa;
        if (b & 8) chk ^= 0x3d4233dd;
        if (b & 16) chk ^= 0x2a1462b3;
    }
    const pm = (chk ^ 1) >>> 0;
    const out = new Uint8Array(nWords + 6);
    for (let i = 0; i < nWords; i++) out[i] = BECH32_CODES[seq[exp.length + i]!]!;
    for (let i = 0; i < 6; i++) out[nWords + i] = BECH32_CODES[(pm >> (5 * (5 - i))) & 31]!;
    return hrp + "1" + String.fromCharCode.apply(null, out as unknown as number[]);
}

/** Full bech32 of a Shelley address from its raw bytes (mainnet/testnet from the header nibble). */
export function shelleyAddressBech32(raw: Uint8Array): string {
    return bech32Encode((raw[0]! & 0x0f) === 1 ? "addr" : "addr_test", raw);
}


/**
 * Typed hex of a reward account given as a ledger-ts `StakeAddress` (type on the address, bare
 * hash in `credentials`), a `Credential`, or a hash: `01` + hash for a script, the hash for a key.
 * A pool's reward account and a proposal's return account arrive as stake addresses (bugs 84, 85).
 */
export function rewardAccountTypedHex(ra: any): string {
    const hash = String(ra?.credentials?.hash?.toString?.() ?? ra?.credentials?.toString?.() ?? ra?.hash?.toString?.() ?? "").toLowerCase();
    if (!/^[0-9a-f]{56}$/.test(hash)) return typedCredHexOf(ra?.credentials) ?? typedCredHexOf(ra) ?? hash;
    const t = ra?.type;
    const isScript = t === "script" || t === 1 || (typeof t === "string" && t.toLowerCase().includes("script")) || credTypeOf(ra?.credentials) === 1;
    return typedCredHex(isScript ? 1 : 0, hash);
}

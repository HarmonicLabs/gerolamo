/**
 * Cardano identifier encodings the Blockfrost API speaks: bech32 stake addresses, pool ids,
 * DRep ids (CIP-129 and legacy), committee ids, governance action ids (CIP-129), VRF keys,
 * asset fingerprints (CIP-14), and address parsing (Shelley bech32, Byron base58, payment
 * credentials). Pure; safe in the explorer worker.
 */
import { blake2b, blake2b_224 } from "@harmoniclabs/crypto";
import { base58Decode, base58Encode } from "@harmoniclabs/cardano-ledger-ts/dist/utils/base58.js";
import { bech32Encode } from "../stakeCred";
import { hex, unhex } from "./cborWalk";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** bech32 → { hrp, bytes } with the checksum verified; null when malformed. */
export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } | null {
    if (!s || s.length < 8 || s.length > 1023) return null;
    const lower = s.toLowerCase();
    if (lower !== s && s.toUpperCase() !== s) return null;
    const pos = lower.lastIndexOf("1");
    if (pos < 1 || pos + 7 > lower.length) return null;
    const hrp = lower.slice(0, pos);
    const words: number[] = [];
    for (const c of lower.slice(pos + 1)) { const i = CHARSET.indexOf(c); if (i < 0) return null; words.push(i); }
    let chk = 1;
    const step = (v: number) => { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!; };
    for (const c of hrp) step(c.charCodeAt(0) >> 5);
    step(0);
    for (const c of hrp) step(c.charCodeAt(0) & 31);
    for (const w of words) step(w);
    if (chk !== 1) return null;
    const out: number[] = [];
    let acc = 0, bits = 0;
    for (const w of words.slice(0, -6)) { acc = ((acc << 5) | w) & 0xfff; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
    if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
    return { hrp, bytes: Uint8Array.from(out) };
}

export type NetworkName = string | undefined;
/** Address network id: 1 on mainnet, 0 on the test networks. */
export function networkId(network: NetworkName): number { return String(network ?? "").toLowerCase() === "mainnet" ? 1 : 0; }

/** Typed stake credential hex ("01"+hash for a script) → bech32 stake address. */
export function stakeAddressOf(typedHex: string, network: NetworkName): string {
    const script = typedHex.length === 58 && typedHex.startsWith("01");
    const hash = script ? typedHex.slice(2) : typedHex;
    const raw = new Uint8Array(29);
    raw[0] = (script ? 0xf0 : 0xe0) | networkId(network);
    raw.set(unhex(hash), 1);
    return bech32Encode(networkId(network) === 1 ? "stake" : "stake_test", raw);
}

/** Raw reward account bytes (29) → typed hex credential, or null. */
export function typedOfRewardAccount(raw: Uint8Array): string | null {
    if (raw.length !== 29) return null;
    const t = raw[0]! >> 4;
    if (t !== 0xe && t !== 0xf) return null;
    return (t === 0xf ? "01" : "") + hex(raw.subarray(1));
}

/** Raw reward account bytes → bech32 stake address (network from the header). */
export function rewardAccountBech32(raw: Uint8Array): string {
    return bech32Encode((raw[0]! & 0x0f) === 1 ? "stake" : "stake_test", raw);
}

/** bech32 stake address → typed hex, or null when malformed or for another network. */
export function parseStakeAddress(s: string, network: NetworkName): string | null {
    const d = bech32Decode(s);
    if (!d || d.bytes.length !== 29) return null;
    const want = networkId(network) === 1 ? "stake" : "stake_test";
    if (d.hrp !== want) return null;
    if ((d.bytes[0]! & 0x0f) !== networkId(network)) return null;
    return typedOfRewardAccount(d.bytes);
}

export const poolIdBech32 = (poolHex: string): string => bech32Encode("pool", unhex(poolHex));

/** `pool1…` or 56 hex → pool key hash hex; null when malformed. */
export function parsePoolId(s: string): string | null {
    if (/^[0-9a-fA-F]{56}$/.test(s)) return s.toLowerCase();
    const d = bech32Decode(s);
    return d && d.hrp === "pool" && d.bytes.length === 28 ? hex(d.bytes) : null;
}

export const vrfKeyBech32 = (vkeyHex: string): string => bech32Encode("vrf_vk", unhex(vkeyHex));

/** CIP-14 asset fingerprint. */
export function assetFingerprint(policyHex: string, nameHex: string): string {
    return bech32Encode("asset", blake2b(new Uint8Array([...unhex(policyHex), ...unhex(nameHex)]), 20 as any));
}

export const DREP_ABSTAIN = "drep_always_abstain";
export const DREP_NO_CONFIDENCE = "drep_always_no_confidence";

/** CIP-129 DRep id: header 0x22 (key) / 0x23 (script) ‖ hash. */
export function drepIdCip129(type: number, hashHex: string): string {
    return bech32Encode("drep", new Uint8Array([type === 1 ? 0x23 : 0x22, ...unhex(hashHex)]));
}
/** CIP-105 (legacy) DRep id: `drep1…` / `drep_script1…` over the bare hash. */
export function drepIdLegacy(type: number, hashHex: string): string {
    return bech32Encode(type === 1 ? "drep_script" : "drep", unhex(hashHex));
}
export type DRepRef = { special: "abstain" | "no_confidence" } | { type: number; hash: string; cip129: boolean };
export function parseDrepId(s: string): DRepRef | null {
    if (s === DREP_ABSTAIN) return { special: "abstain" };
    if (s === DREP_NO_CONFIDENCE) return { special: "no_confidence" };
    const d = bech32Decode(s);
    if (!d) return null;
    if (d.hrp === "drep" && d.bytes.length === 29 && (d.bytes[0] === 0x22 || d.bytes[0] === 0x23)) return { type: d.bytes[0] === 0x23 ? 1 : 0, hash: hex(d.bytes.subarray(1)), cip129: true };
    if (d.hrp === "drep" && d.bytes.length === 28) return { type: 0, hash: hex(d.bytes), cip129: false };
    if (d.hrp === "drep_script" && d.bytes.length === 28) return { type: 1, hash: hex(d.bytes), cip129: false };
    return null;
}

/** CIP-129 committee credential id: cold header 0x02/0x03, hot 0x12/0x13. */
export function ccId(role: "cold" | "hot", type: number, hashHex: string): string {
    const hdr = (role === "hot" ? 0x10 : 0x00) | (type === 1 ? 0x03 : 0x02);
    return bech32Encode(role === "hot" ? "cc_hot" : "cc_cold", new Uint8Array([hdr, ...unhex(hashHex)]));
}

/** `cc_hot1…` / `cc_cold1…` (CIP-129, 29 bytes) → role, credential type and hash. */
export function parseCcId(s: string): { role: "cold" | "hot"; type: number; hash: string } | null {
    const d = bech32Decode(s);
    if (!d || d.bytes.length !== 29 || (d.hrp !== "cc_hot" && d.hrp !== "cc_cold")) return null;
    const role = d.hrp === "cc_hot" ? "hot" : "cold";
    const h = d.bytes[0]!;
    if ((h >> 4) !== (role === "hot" ? 1 : 0) || ((h & 0x0f) !== 2 && (h & 0x0f) !== 3)) return null;
    return { role, type: (h & 0x0f) === 3 ? 1 : 0, hash: hex(d.bytes.subarray(1)) };
}

/** CIP-129 governance action id: tx id ‖ index (one byte; two when ≥ 256). */
export function govActionId(txHash: string, index: number): string {
    const ix = index < 256 ? [index] : [(index >> 8) & 0xff, index & 0xff];
    return bech32Encode("gov_action", new Uint8Array([...unhex(txHash), ...ix]));
}
export function parseGovActionId(s: string): { txHash: string; index: number } | null {
    const d = bech32Decode(s);
    // CIP-129: the index suffix may be omitted for index 0 (a 32-byte payload)
    if (!d || d.hrp !== "gov_action" || d.bytes.length < 32 || d.bytes.length > 34) return null;
    const ix = d.bytes.length === 32 ? 0 : d.bytes.length === 33 ? d.bytes[32]! : (d.bytes[32]! << 8) | d.bytes[33]!;
    return { txHash: hex(d.bytes.subarray(0, 32)), index: ix };
}

export interface ParsedAddress {
    /** The address as given (bech32 or base58), or the payment-credential bech32. */
    address: string;
    kind: "shelley" | "byron" | "payment_cred";
    type: "shelley" | "byron";
    raw: Uint8Array | null;
    /** Payment credential (type 0 key / 1 script, hash hex); null for Byron. */
    payment: { type: number; hash: string } | null;
    /** Typed stake credential of a base address; null otherwise. */
    stakeTyped: string | null;
    script: boolean;
}

/** Validate an address path parameter for the node's network. */
export function parseAddress(s: string, network: NetworkName): ParsedAddress | null {
    if (!s) return null;
    const net = networkId(network);
    if (s.startsWith("addr_vkh1") || s.startsWith("script1") || s.startsWith("addr_vk1")) {
        const d = bech32Decode(s);
        if (!d) return null;
        if (d.hrp === "addr_vk" && d.bytes.length === 32) return { address: bech32Encode("addr_vkh", blake2b_224(d.bytes)), kind: "payment_cred", type: "shelley", raw: null, payment: { type: 0, hash: hex(blake2b_224(d.bytes)) }, stakeTyped: null, script: false };
        if ((d.hrp === "addr_vkh" || d.hrp === "script") && d.bytes.length === 28) return { address: s, kind: "payment_cred", type: "shelley", raw: null, payment: { type: d.hrp === "script" ? 1 : 0, hash: hex(d.bytes) }, stakeTyped: null, script: d.hrp === "script" };
        return null;
    }
    if (s.startsWith("addr")) {
        const d = bech32Decode(s);
        if (!d || d.bytes.length < 29) return null;
        if (d.hrp !== (net === 1 ? "addr" : "addr_test")) return null;
        const raw = d.bytes, t = raw[0]! >> 4;
        if (t > 7 || (raw[0]! & 0x0f) !== net) return null;
        const payType = t & 1; // types 1,3,5,7 have a script payment part
        const payment = { type: payType, hash: hex(raw.subarray(1, 29)) };
        let stakeTyped: string | null = null;
        if (t <= 3) { if (raw.length !== 57) return null; stakeTyped = (t === 2 || t === 3 ? "01" : "") + hex(raw.subarray(29, 57)); }
        else if (t >= 6 && raw.length !== 29) return null;
        return { address: s, kind: "shelley", type: "shelley", raw, payment, stakeTyped, script: payType === 1 };
    }
    try {
        const raw = base58Decode(s);
        if (raw.length < 10 || raw[0] !== 0x82) return null;
        return { address: s, kind: "byron", type: "byron", raw, payment: null, stakeTyped: null, script: false };
    } catch {
        return null;
    }
}

/** Address bytes (as in an output) → the string form the node stores (bech32 Shelley, base58 Byron). */
export function addressStringOfRaw(raw: Uint8Array): string {
    if (raw.length === 0) return "";
    if (raw[0] === 0x82) return base58Encode(raw);
    return bech32Encode((raw[0]! & 0x0f) === 1 ? "addr" : "addr_test", raw);
}

/** Payment credential and typed stake credential of a stored address string (cheap; bech32 only). */
export function credentialsOfAddress(address: string): { payment: string | null; stake: string | null } {
    if (!address.startsWith("addr")) return { payment: null, stake: null };
    const d = bech32Decode(address);
    if (!d || d.bytes.length < 29) return { payment: null, stake: null };
    const t = d.bytes[0]! >> 4;
    if (t > 7) return { payment: null, stake: null };
    const payment = ((t & 1) === 1 ? "01" : "") + hex(d.bytes.subarray(1, 29));
    const stake = t <= 3 && d.bytes.length === 57 ? (t === 2 || t === 3 ? "01" : "") + hex(d.bytes.subarray(29, 57)) : null;
    return { payment, stake };
}

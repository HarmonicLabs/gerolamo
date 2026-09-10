/**
 * Operator flow (pool tooling plan §1–§2) on the HarmonicLabs libraries only:
 * payment/stake keys and addresses, the stake registration, pool registration
 * and delegation certificates, and a signed Conway transaction carrying them.
 *
 * Encodings follow what `cardano-cli conway` 11 produces (fixtures in
 * `__fixtures__/cli-tx`): tag 258 sets for inputs, certificates, owners and
 * vkey witnesses; legacy `[address, coin]` outputs; margin as tag 30 rational;
 * body keys 0 inputs, 1 outputs, 2 fee, 3 ttl, 4 certificates. Everything is
 * built with the node's CBOR copy; nothing here logs key material.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, type CborObj, CborSimple, CborTag, CborText, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256, deriveEd25519PublicKey_sync, signEd25519_sync, verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { bech32Encode } from "../db/stakeCred";
import { envelopeBytes, envelopeOfBytes, readTextEnvelope, type TextEnvelope } from "./keystore";

export const KeyEnvelopeType = {
    paymentSigning: "PaymentSigningKeyShelley_ed25519",
    paymentVerification: "PaymentVerificationKeyShelley_ed25519",
    stakeSigning: "StakeSigningKeyShelley_ed25519",
    stakeVerification: "StakeVerificationKeyShelley_ed25519",
    certificate: "Certificate",
    tx: "Tx ConwayEra",
} as const;

export interface KeyPair { skey: Uint8Array; vkey: Uint8Array }

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ─────────────────────────── keys, hashes, addresses ───────────────────────────

export function generateKeyPair(seed: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): KeyPair {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    return { skey: Uint8Array.from(seed), vkey: deriveEd25519PublicKey_sync(seed) };
}

export function loadSigningKey(path: string, type: string): KeyPair {
    const skey = envelopeBytes(readTextEnvelope(path, type), 32);
    return { skey, vkey: deriveEd25519PublicKey_sync(skey) };
}

export function loadVerificationKey(path: string, type: string): Uint8Array {
    return envelopeBytes(readTextEnvelope(path, type), 32);
}

export function keyEnvelopes(kind: "payment" | "stake", key: KeyPair): { skey: TextEnvelope; vkey: TextEnvelope } {
    const cap = kind === "payment" ? "Payment" : "Stake";
    return {
        skey: envelopeOfBytes(kind === "payment" ? KeyEnvelopeType.paymentSigning : KeyEnvelopeType.stakeSigning, `${cap} Signing Key`, key.skey),
        vkey: envelopeOfBytes(kind === "payment" ? KeyEnvelopeType.paymentVerification : KeyEnvelopeType.stakeVerification, `${cap} Verification Key`, key.vkey),
    };
}

/** blake2b-224 of a verification key: payment / stake key hash, pool id. */
export function keyHash(vkey: Uint8Array): Uint8Array {
    return new Uint8Array(blake2b_224(vkey));
}

export type NetworkId = 0 | 1; // 0 testnets (preview, preprod), 1 mainnet

/** Base address (type 0: key payment, key stake): header ‖ payment hash ‖ stake hash. */
export function baseAddressBytes(network: NetworkId, paymentKeyHash: Uint8Array, stakeKeyHash: Uint8Array): Uint8Array {
    const out = new Uint8Array(57); out[0] = 0x00 | network; out.set(paymentKeyHash, 1); out.set(stakeKeyHash, 29);
    return out;
}

/** Stake (reward) address for a key credential: 0xe0 | network ‖ stake hash. */
export function stakeAddressBytes(network: NetworkId, stakeKeyHash: Uint8Array): Uint8Array {
    const out = new Uint8Array(29); out[0] = 0xe0 | network; out.set(stakeKeyHash, 1);
    return out;
}

export function addressBech32(raw: Uint8Array): string {
    const net = raw[0]! & 0x0f;
    const isStake = (raw[0]! & 0xf0) === 0xe0 || (raw[0]! & 0xf0) === 0xf0;
    return bech32Encode(isStake ? (net === 1 ? "stake" : "stake_test") : (net === 1 ? "addr" : "addr_test"), raw);
}

const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** bech32 → bytes (checksum verified). */
export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } {
    const lower = s.toLowerCase();
    const pos = lower.lastIndexOf("1");
    if (pos < 1) throw new Error("bech32: no separator");
    const hrp = lower.slice(0, pos), data = lower.slice(pos + 1);
    const words = [...data].map((c) => { const i = BECH32_CHARS.indexOf(c); if (i < 0) throw new Error("bech32: bad character"); return i; });
    const hrpExp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    if (polymod(hrpExp.concat(words)) !== 1) throw new Error("bech32: checksum");
    const payload = words.slice(0, -6);
    const out: number[] = []; let acc = 0, bits = 0;
    for (const w of payload) { acc = (acc << 5) | w; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
    return { hrp, bytes: Uint8Array.from(out) };
}

function polymod(values: number[]): number {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]!; }
    return chk >>> 0;
}

// ─────────────────────────── certificates ───────────────────────────

const set = (items: CborArray["array"]) => new CborTag(258, new CborArray(items));
const keyCred = (hash: Uint8Array) => new CborArray([new CborUInt(0n), new CborBytes(hash)]);

/** Conway `reg_cert` (type 7): stake key registration with explicit deposit. */
export function stakeRegistrationCert(stakeKeyHash: Uint8Array, deposit: bigint): CborArray {
    return new CborArray([new CborUInt(7n), keyCred(stakeKeyHash), new CborUInt(deposit)]);
}

/** `stake_delegation` (type 2). */
export function stakeDelegationCert(stakeKeyHash: Uint8Array, poolId: Uint8Array): CborArray {
    return new CborArray([new CborUInt(2n), keyCred(stakeKeyHash), new CborBytes(poolId)]);
}

export type Relay =
    | { type: "single-host-addr"; port?: number; ipv4?: string; ipv6?: string }
    | { type: "single-host-name"; port?: number; dnsName: string }
    | { type: "multi-host-name"; dnsName: string };

export interface PoolParams {
    /** Cold verification key hash (pool id). */
    operator: Uint8Array;
    vrfKeyHash: Uint8Array;
    pledge: bigint;
    cost: bigint;
    /** Margin as a reduced fraction (0.01 → 1/100). */
    margin: { num: bigint; den: bigint };
    /** 29-byte reward (stake) address bytes. */
    rewardAccount: Uint8Array;
    owners: Uint8Array[]; // stake key hashes
    relays: Relay[];
    metadata?: { url: string; hash: Uint8Array } | null;
}

export function marginFromDecimal(text: string | number): { num: bigint; den: bigint } {
    const s = String(text);
    const [i, f = ""] = s.split(".");
    let num = BigInt(i + f), den = 10n ** BigInt(f.length);
    const g = gcd(num, den); num /= g; den /= g;
    if (num < 0n || num > den) throw new Error("margin must be within 0..1");
    return { num, den };
}

function gcd(a: bigint, b: bigint): bigint { while (b) { [a, b] = [b, a % b]; } return a || 1n; }

function ipv4Bytes(s: string): Uint8Array {
    const p = s.split(".").map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error(`bad IPv4 ${s}`);
    return Uint8Array.from(p);
}

function ipv6Bytes(s: string): Uint8Array {
    // full or :: compressed hextets → 16 bytes, stored as cardano-cli does (network order)
    const halves = s.split("::");
    const parse = (h: string) => (h === "" ? [] : h.split(":").map((x) => parseInt(x, 16)));
    const left = parse(halves[0]!), right = halves.length > 1 ? parse(halves[1]!) : [];
    const words = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
    if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) throw new Error(`bad IPv6 ${s}`);
    const out = new Uint8Array(16); words.forEach((w, i) => { out[2 * i] = w >> 8; out[2 * i + 1] = w & 0xff; });
    return out;
}

function relayObj(r: Relay): CborArray {
    const port = "port" in r && r.port != null ? new CborUInt(BigInt(r.port)) : new CborSimple(null);
    switch (r.type) {
        case "single-host-addr":
            return new CborArray([new CborUInt(0n), port, r.ipv4 ? new CborBytes(ipv4Bytes(r.ipv4)) : new CborSimple(null), r.ipv6 ? new CborBytes(ipv6Bytes(r.ipv6)) : new CborSimple(null)]);
        case "single-host-name":
            return new CborArray([new CborUInt(1n), port, new CborText(r.dnsName)]);
        case "multi-host-name":
            return new CborArray([new CborUInt(2n), new CborText(r.dnsName)]);
    }
}

/** `pool_registration` (type 3). */
export function poolRegistrationCert(p: PoolParams): CborArray {
    if (p.operator.length !== 28 || p.vrfKeyHash.length !== 32 || p.rewardAccount.length !== 29) throw new Error("pool params: operator 28, vrf 32, reward account 29 bytes");
    return new CborArray([
        new CborUInt(3n), new CborBytes(p.operator), new CborBytes(p.vrfKeyHash), new CborUInt(p.pledge), new CborUInt(p.cost),
        new CborTag(30, new CborArray([new CborUInt(p.margin.num), new CborUInt(p.margin.den)])),
        new CborBytes(p.rewardAccount), set(p.owners.map((o) => new CborBytes(o))),
        new CborArray(p.relays.map(relayObj)),
        p.metadata ? new CborArray([new CborText(p.metadata.url), new CborBytes(p.metadata.hash)]) : new CborSimple(null),
    ]);
}

/** blake2b-256 of the metadata file bytes (`cardano-cli stake-pool metadata-hash`). */
export function poolMetadataHash(fileBytes: Uint8Array): Uint8Array {
    return new Uint8Array(blake2b_256(fileBytes));
}

export function certificateEnvelope(cert: CborArray): TextEnvelope {
    return { type: KeyEnvelopeType.certificate, description: "", cborHex: hex(Cbor.encode(cert).toBuffer()) };
}

// ─────────────────────────── transaction ───────────────────────────

export interface TxInput { txHash: Uint8Array; index: number }
export interface TxOutput { address: Uint8Array; lovelace: bigint }

export interface TxBodyFields {
    inputs: TxInput[];
    outputs: TxOutput[];
    fee: bigint;
    /** invalid_hereafter (absolute slot), optional. */
    ttl?: bigint;
    certificates: CborArray[];
    /** Auxiliary data (a metadata map); its hash goes into body key 7 and the data into the tx. */
    auxiliaryData?: CborObj;
}

/** CIP-20 style message metadata: `{674: {"msg": [lines…]}}` (each line at most 64 bytes). */
export function messageMetadata(lines: string[]): CborMap {
    for (const l of lines) if (new TextEncoder().encode(l).length > 64) throw new Error("metadata message line longer than 64 bytes");
    return new CborMap([{ k: new CborUInt(674n), v: new CborMap([{ k: new CborText("msg"), v: new CborArray(lines.map((l) => new CborText(l))) }]) }]);
}

export function encodeTxBody(f: TxBodyFields): Uint8Array {
    if (f.inputs.length === 0) throw new Error("transaction needs at least one input");
    const entries: CborMap["map"] = [
        { k: new CborUInt(0n), v: set(f.inputs.map((i) => new CborArray([new CborBytes(i.txHash), new CborUInt(BigInt(i.index))]))) },
        { k: new CborUInt(1n), v: new CborArray(f.outputs.map((o) => new CborArray([new CborBytes(o.address), new CborUInt(o.lovelace)]))) },
        { k: new CborUInt(2n), v: new CborUInt(f.fee) },
    ];
    if (f.ttl != null) entries.push({ k: new CborUInt(3n), v: new CborUInt(f.ttl) });
    if (f.certificates.length) entries.push({ k: new CborUInt(4n), v: set(f.certificates) });
    if (f.auxiliaryData) entries.push({ k: new CborUInt(7n), v: new CborBytes(new Uint8Array(blake2b_256(Cbor.encode(f.auxiliaryData).toBuffer()))) });
    return Cbor.encode(new CborMap(entries)).toBuffer();
}

export function txId(bodyBytes: Uint8Array): Uint8Array {
    return new Uint8Array(blake2b_256(bodyBytes));
}

export interface VkeyWitness { vkey: Uint8Array; signature: Uint8Array }

export function signTxBody(bodyBytes: Uint8Array, keys: KeyPair[]): VkeyWitness[] {
    const id = txId(bodyBytes);
    const seen = new Set<string>();
    const out: VkeyWitness[] = [];
    for (const k of keys) {
        if (seen.has(hex(k.vkey))) continue;
        seen.add(hex(k.vkey));
        const [, signature] = signEd25519_sync(id, k.skey);
        out.push({ vkey: Uint8Array.from(k.vkey), signature: Uint8Array.from(signature) });
    }
    // cardano-cli orders vkey witnesses by ascending key hash (Set of WitVKey); any order is valid on chain
    return out.sort((a, b) => (hex(keyHash(a.vkey)) < hex(keyHash(b.vkey)) ? -1 : 1));
}

/** `[body, {0: #258([[vkey, sig]…])}, true, auxiliary_data | null]` — Conway transaction bytes. */
export function encodeSignedTx(bodyBytes: Uint8Array, witnesses: VkeyWitness[], auxiliaryData?: CborObj): Uint8Array {
    const ws = new CborMap([{ k: new CborUInt(0n), v: set(witnesses.map((w) => new CborArray([new CborBytes(w.vkey), new CborBytes(w.signature)]))) }]);
    return Cbor.encode(new CborArray([Cbor.parse(bodyBytes), ws, new CborSimple(true), auxiliaryData ?? new CborSimple(null)])).toBuffer();
}

export function verifyWitnesses(bodyBytes: Uint8Array, witnesses: VkeyWitness[]): boolean {
    const id = txId(bodyBytes);
    return witnesses.every((w) => verifyEd25519Signature_sync(w.signature, id, w.vkey));
}

export function txEnvelope(txBytes: Uint8Array): TextEnvelope {
    return { type: KeyEnvelopeType.tx, description: "Ledger Cddl Format", cborHex: hex(txBytes) };
}

/** min fee = a·size + b, sized on the fully signed transaction (iterated until the fee's own width settles). */
export function buildWithMinFee(fields: Omit<TxBodyFields, "fee"> & { changeIndex: number; minFeeA: bigint; minFeeB: bigint; keys: KeyPair[]; feeMargin?: bigint }): { body: Uint8Array; tx: Uint8Array; fee: bigint; witnesses: VkeyWitness[] } {
    let fee = 0n;
    for (let i = 0; i < 5; i++) {
        const outputs = fields.outputs.map((o, ix) => (ix === fields.changeIndex ? { ...o, lovelace: o.lovelace - fee } : o));
        if (outputs[fields.changeIndex]!.lovelace < 0n) throw new Error("change output cannot cover the fee");
        const body = encodeTxBody({ ...fields, outputs, fee });
        const witnesses = signTxBody(body, fields.keys);
        const tx = encodeSignedTx(body, witnesses, fields.auxiliaryData);
        const need = fields.minFeeA * BigInt(tx.length) + fields.minFeeB + (fields.feeMargin ?? 0n);
        if (need <= fee) return { body, tx, fee, witnesses };
        fee = need;
    }
    throw new Error("fee did not converge");
}

/** Decode `[body, witnesses, …]` for inspection/tests. */
export function decodeTx(txBytes: Uint8Array): { body: Uint8Array; witnesses: VkeyWitness[] } {
    const root = Cbor.parse(txBytes);
    if (!(root instanceof CborArray) || root.array.length < 2) throw new Error("not a transaction");
    const body = Cbor.encode(root.array[0]!).toBuffer();
    const ws = root.array[1] as CborMap;
    const witnesses: VkeyWitness[] = [];
    const w0 = ws.map.find((e) => e.k instanceof CborUInt && e.k.num === 0n)?.v as any;
    const arr = (w0 instanceof CborTag ? w0.data : w0) as CborArray | undefined;
    for (const it of arr?.array ?? []) { const a = it as CborArray; witnesses.push({ vkey: (a.array[0] as CborBytes).bytes, signature: (a.array[1] as CborBytes).bytes }); }
    return { body, witnesses };
}

export function sameWitnessSet(a: VkeyWitness[], b: VkeyWitness[]): boolean {
    const key = (w: VkeyWitness) => hex(w.vkey) + hex(w.signature);
    const sa = new Set(a.map(key)), sb = new Set(b.map(key));
    return sa.size === sb.size && [...sa].every((k) => sb.has(k));
}

export { CborNegInt, eq as bytesEqual };

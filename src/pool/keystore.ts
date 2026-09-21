/**
 * Stake pool key material in the file formats `cardano-node` / `cardano-cli`
 * use (TextEnvelope JSON: `{ type, description, cborHex }`), so an operator's
 * existing cold / KES / VRF keys and operational certificate work unchanged.
 *
 * Only the HarmonicLabs libraries are used: ed25519 + blake2b from
 * `@harmoniclabs/crypto`, Sum6 KES from `@harmoniclabs/kes`,
 * `PoolOperationalCert` from `@harmoniclabs/cardano-ledger-ts`.
 *
 * Hygiene: secret keys are returned as plain Uint8Arrays for the forging
 * process only, never logged; callers zeroise them (`zeroise`) when replaced.
 * The cold signing key is touched only by `issueOperationalCert` (offline use).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Cbor, CborArray, CborBytes, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256, deriveEd25519PublicKey_sync, signEd25519_sync, verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { kes_keygen, kes_to_pk, kes_update, kes_get_period, sign as kesSign, verify as kesVerify } from "@harmoniclabs/kes";
import { PoolOperationalCert } from "@harmoniclabs/cardano-ledger-ts";

/** Operational certificate fields (the ledger-ts class is built from bytes only: its CBOR copy differs from ours). */
export interface OpcertFields {
    kesVkey: Uint8Array;
    counter: bigint;
    kesPeriod: bigint;
    signature: Uint8Array;
}

export interface TextEnvelope {
    type: string;
    description: string;
    cborHex: string;
}

/** TextEnvelope `type` strings written by cardano-cli. */
export const EnvelopeType = {
    coldSigningKey: "StakePoolSigningKey_ed25519",
    coldVerificationKey: "StakePoolVerificationKey_ed25519",
    counter: "NodeOperationalCertificateIssueCounter",
    kesSigningKey: "KesSigningKey_ed25519_kes_2^6",
    kesVerificationKey: "KesVerificationKey_ed25519_kes_2^6",
    vrfSigningKey: "VrfSigningKey_PraosVRF",
    vrfVerificationKey: "VrfVerificationKey_PraosVRF",
    operationalCert: "NodeOperationalCertificate",
} as const;

export const KES_SK_BYTES = 608; // cardano-cli `kes.skey` payload: Sum6 body without the period suffix
export const KES_SK_WITH_PERIOD_BYTES = 612; // in-memory form: body ‖ period (u32 BE), what evolve/sign/period use
export const KES_MAX_EVOLUTIONS = 62; // Sum6: 2^6 = 64 periods, cardano genesis maxKESEvolutions = 62

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const beU64 = (n: bigint) => fromHex(n.toString(16).padStart(16, "0"));
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function zeroise(...keys: Array<Uint8Array | null | undefined>): void {
    for (const k of keys) k?.fill(0);
}

// ─────────────────────────── envelopes ───────────────────────────

export function parseTextEnvelope(json: string, expectedType?: string): TextEnvelope {
    const d = JSON.parse(json);
    if (typeof d?.type !== "string" || typeof d?.cborHex !== "string") throw new Error("Not a TextEnvelope (type/cborHex missing)");
    if (expectedType && d.type !== expectedType) throw new Error(`TextEnvelope type ${d.type}, expected ${expectedType}`);
    return { type: d.type, description: typeof d.description === "string" ? d.description : "", cborHex: d.cborHex };
}

export function readTextEnvelope(path: string, expectedType?: string): TextEnvelope {
    return parseTextEnvelope(readFileSync(path, "utf8"), expectedType);
}

/** The payload of a bytestring envelope (`58 xx …` / `59 xxxx …`). */
export function envelopeBytes(env: TextEnvelope, expectedLength?: number): Uint8Array {
    const c = Cbor.parse(fromHex(env.cborHex));
    if (!(c instanceof CborBytes)) throw new Error(`${env.type}: cborHex is not a CBOR bytestring`);
    const b = c.bytes;
    if (expectedLength != null && b.length !== expectedLength) throw new Error(`${env.type}: ${b.length} bytes, expected ${expectedLength}`);
    return b;
}

export function envelopeOfBytes(type: string, description: string, bytes: Uint8Array): TextEnvelope {
    return { type, description, cborHex: hex(Cbor.encode(new CborBytes(bytes)).toBuffer()) };
}

export function writeTextEnvelope(path: string, env: TextEnvelope): void {
    // cardano-cli layout: 4-space indent, keys type/description/cborHex, trailing newline
    writeFileSync(path, JSON.stringify({ type: env.type, description: env.description, cborHex: env.cborHex }, null, 4) + "\n", { mode: 0o600 });
}

// ─────────────────────────── cold key ───────────────────────────

export interface ColdKey { skey: Uint8Array; vkey: Uint8Array }

export function loadColdVerificationKey(path: string): Uint8Array {
    return envelopeBytes(readTextEnvelope(path, EnvelopeType.coldVerificationKey), 32);
}

/** Offline only: the cold signing key is needed to issue an operational certificate. */
export function loadColdSigningKey(path: string): ColdKey {
    const skey = envelopeBytes(readTextEnvelope(path, EnvelopeType.coldSigningKey), 32);
    return { skey, vkey: deriveEd25519PublicKey_sync(skey) };
}

/** Pool id = blake2b-224 of the cold verification key. */
export function poolIdOf(coldVkey: Uint8Array): string {
    return hex(blake2b_224(coldVkey));
}

export function generateColdKey(seed: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): ColdKey {
    if (seed.length !== 32) throw new Error("cold key seed must be 32 bytes");
    return { skey: Uint8Array.from(seed), vkey: deriveEd25519PublicKey_sync(seed) };
}

// ─────────────────────────── counter ───────────────────────────

export interface IssueCounter { next: bigint; coldVkey: Uint8Array }

/** `node.counter`: `[next_counter, cold_vkey]`. */
export function decodeIssueCounter(env: TextEnvelope): IssueCounter {
    const c = Cbor.parse(fromHex(env.cborHex));
    if (!(c instanceof CborArray) || c.array.length !== 2 || !(c.array[0] instanceof CborUInt) || !(c.array[1] instanceof CborBytes)) {
        throw new Error("counter envelope is not [uint, bytes]");
    }
    return { next: c.array[0].num, coldVkey: c.array[1].bytes };
}

export function encodeIssueCounter(counter: IssueCounter): TextEnvelope {
    const cbor = Cbor.encode(new CborArray([new CborUInt(counter.next), new CborBytes(counter.coldVkey)])).toBuffer();
    return { type: EnvelopeType.counter, description: `Next certificate issue number: ${counter.next}`, cborHex: hex(cbor) };
}

export function readIssueCounter(path: string): IssueCounter {
    return decodeIssueCounter(readTextEnvelope(path, EnvelopeType.counter));
}

// ─────────────────────────── KES ───────────────────────────

export interface KesKey {
    /** Sum6 secret key with period suffix (612 bytes) at its current evolution. */
    skey: Uint8Array;
    vkey: Uint8Array;
}

/** 608-byte body → 612-byte form at evolution `period`. */
function kesWithPeriod(body: Uint8Array, period = 0): Uint8Array {
    if (body.length === KES_SK_WITH_PERIOD_BYTES) return body;
    if (body.length !== KES_SK_BYTES) throw new Error(`KES secret: ${body.length} bytes, expected ${KES_SK_BYTES} or ${KES_SK_WITH_PERIOD_BYTES}`);
    const out = new Uint8Array(KES_SK_WITH_PERIOD_BYTES); out.set(body, 0);
    new DataView(out.buffer).setUint32(KES_SK_BYTES, period, false);
    return out;
}

/** The 608-byte payload cardano-cli writes to `kes.skey` (evolution 0 only: the file format has no period). */
export function kesSecretForEnvelope(key: KesKey): Uint8Array {
    if (kesEvolution(key) !== 0) throw new Error("kes.skey files hold evolution 0 only; evolved keys are not written back");
    return key.skey.subarray(0, KES_SK_BYTES);
}

/** `kes.skey` holds the 608-byte Sum6 secret at evolution 0 (period relative to the opcert). */
export function loadKesSigningKey(skeyPath: string, vkeyPath?: string): KesKey {
    const skey = kesWithPeriod(envelopeBytes(readTextEnvelope(skeyPath, EnvelopeType.kesSigningKey), KES_SK_BYTES));
    const vkey = kes_to_pk(skey);
    if (vkeyPath) {
        const declared = envelopeBytes(readTextEnvelope(vkeyPath, EnvelopeType.kesVerificationKey), 32);
        if (!bytesEqual(declared, vkey)) throw new Error("kes.vkey does not match kes.skey");
    }
    return { skey, vkey };
}

export function generateKesKey(seed: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): KesKey {
    if (seed.length !== 32) throw new Error("KES seed must be 32 bytes");
    const { sk, pk } = kes_keygen(Uint8Array.from(seed)); // keygen zeroes its seed copy
    return { skey: kesWithPeriod(sk), vkey: pk };
}

/** Evolution the key is at (0 at issue; kes_update advances one period, in place). */
export function kesEvolution(key: KesKey): number {
    return kes_get_period(key.skey);
}

/**
 * Evolve the KES secret to `target` evolutions (relative to the opcert start
 * period) — the header for slot s is signed with evolution
 * `slotKesPeriod(s) − opcert.kesPeriod`. Irreversible; throws past 62.
 */
export function evolveKesTo(key: KesKey, target: number): void {
    if (target < 0 || target > KES_MAX_EVOLUTIONS) throw new Error(`KES evolution ${target} out of range 0..${KES_MAX_EVOLUTIONS}`);
    let cur = kesEvolution(key);
    if (target < cur) throw new Error(`KES key already at evolution ${cur}, cannot go back to ${target}`);
    while (cur < target) { kes_update(key.skey); cur++; }
}

export function kesSignAt(key: KesKey, message: Uint8Array): Uint8Array {
    return kesSign(key.skey, message);
}

export function kesVerifyAt(signature: Uint8Array, evolution: number, vkey: Uint8Array, message: Uint8Array): boolean {
    return kesVerify(signature, evolution, vkey, message);
}

// ─────────────────────────── VRF ───────────────────────────

export interface VrfKey {
    /** 64 bytes as libsodium stores it: seed ‖ public key. */
    skey: Uint8Array;
    vkey: Uint8Array;
}

export function loadVrfSigningKey(skeyPath: string, vkeyPath?: string): VrfKey {
    const skey = envelopeBytes(readTextEnvelope(skeyPath, EnvelopeType.vrfSigningKey), 64);
    const vkey = skey.subarray(32, 64);
    const derived = deriveEd25519PublicKey_sync(skey.subarray(0, 32));
    if (!bytesEqual(derived, vkey)) throw new Error("vrf.skey public half does not match its seed");
    if (vkeyPath) {
        const declared = envelopeBytes(readTextEnvelope(vkeyPath, EnvelopeType.vrfVerificationKey), 32);
        if (!bytesEqual(declared, vkey)) throw new Error("vrf.vkey does not match vrf.skey");
    }
    return { skey, vkey: Uint8Array.from(vkey) };
}

export function generateVrfKey(seed: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): VrfKey {
    if (seed.length !== 32) throw new Error("VRF seed must be 32 bytes");
    const vkey = deriveEd25519PublicKey_sync(seed);
    const skey = new Uint8Array(64); skey.set(seed, 0); skey.set(vkey, 32);
    return { skey, vkey };
}

/** VRF key hash as in pool registration certificates and header checks: blake2b-256 of the vkey. */
export function vrfKeyHashOf(vkey: Uint8Array): string {
    return hex(blake2b_256(vkey));
}

/** The (seed, pk) pair `VrfProof03.generate` takes. */
export function vrfProvingKey(key: VrfKey): { secret: Uint8Array; publicKey: Uint8Array } {
    return { secret: key.skey.subarray(0, 32), publicKey: key.vkey };
}

// ─────────────────────────── operational certificate ───────────────────────────

export interface OperationalCert {
    cert: OpcertFields;
    coldVkey: Uint8Array;
}

export function opcertToCborObj(c: OpcertFields): CborArray {
    return new CborArray([new CborBytes(c.kesVkey), new CborUInt(c.counter), new CborUInt(c.kesPeriod), new CborBytes(c.signature)]);
}

function opcertFromCborObj(o: unknown): OpcertFields {
    if (!(o instanceof CborArray) || o.array.length !== 4) throw new Error("opcert is not a 4-element array");
    const [k, n, p, s] = o.array;
    if (!(k instanceof CborBytes) || !(n instanceof CborUInt) || !(p instanceof CborUInt) || !(s instanceof CborBytes)) throw new Error("opcert element types");
    if (k.bytes.length !== 32 || s.bytes.length !== 64) throw new Error("opcert key/signature sizes");
    return { kesVkey: k.bytes, counter: n.num, kesPeriod: p.num, signature: s.bytes };
}

/** Header-side representation (ledger-ts), constructed from bytes so no CborObj crosses library copies. */
export function toLedgerOpcert(c: OpcertFields): PoolOperationalCert {
    return PoolOperationalCert.fromCbor(Cbor.encode(opcertToCborObj(c)).toBuffer());
}

/** `node.cert`: `[[kes_vkey, counter, kes_period, cold_signature], cold_vkey]`. */
export function decodeOperationalCert(env: TextEnvelope): OperationalCert {
    const c = Cbor.parse(fromHex(env.cborHex));
    if (!(c instanceof CborArray) || c.array.length !== 2 || !(c.array[1] instanceof CborBytes)) throw new Error("opcert envelope is not [cert, bytes]");
    return { cert: opcertFromCborObj(c.array[0]), coldVkey: c.array[1].bytes };
}

export function encodeOperationalCert(oc: OperationalCert): TextEnvelope {
    const cbor = Cbor.encode(new CborArray([opcertToCborObj(oc.cert), new CborBytes(oc.coldVkey)])).toBuffer();
    return { type: EnvelopeType.operationalCert, description: "", cborHex: hex(cbor) };
}

export function readOperationalCert(path: string): OperationalCert {
    return decodeOperationalCert(readTextEnvelope(path, EnvelopeType.operationalCert));
}

/** Bytes the cold key signs: kes_vkey ‖ counter (u64 BE) ‖ kes_period (u64 BE) — same as the header validator checks. */
export function opcertSigningBytes(kesVkey: Uint8Array, counter: bigint, kesPeriod: bigint): Uint8Array {
    const out = new Uint8Array(32 + 16); out.set(kesVkey, 0); out.set(beU64(counter), 32); out.set(beU64(kesPeriod), 40);
    return out;
}

/** Offline step (`cardano-cli node issue-op-cert`): sign with the cold key, bump the counter file. */
export function issueOperationalCert(kesVkey: Uint8Array, counter: IssueCounter, kesPeriod: bigint, cold: ColdKey): { opcert: OperationalCert; nextCounter: IssueCounter } {
    if (!bytesEqual(counter.coldVkey, cold.vkey)) throw new Error("counter file belongs to a different cold key");
    if (kesVkey.length !== 32) throw new Error("KES vkey must be 32 bytes");
    const [, signature] = signEd25519_sync(opcertSigningBytes(kesVkey, counter.next, kesPeriod), cold.skey);
    const cert: OpcertFields = { kesVkey: Uint8Array.from(kesVkey), counter: counter.next, kesPeriod, signature: Uint8Array.from(signature) };
    return { opcert: { cert, coldVkey: cold.vkey }, nextCounter: { next: counter.next + 1n, coldVkey: counter.coldVkey } };
}

export interface OpcertCheckInput {
    /** KES period of the current slot: floor(slot / slotsPerKESPeriod). */
    currentKesPeriod: bigint;
    /** Genesis maxKESEvolutions (62). */
    maxKesEvolutions: bigint;
    /** Last counter this pool put on chain (from `opcert_counters`), null when none. */
    lastOnChainCounter: bigint | null;
    /** The loaded KES key the certificate must be about. */
    kesVkey: Uint8Array;
}

export type OpcertCheck = { ok: true; evolution: number } | { ok: false; reason: string };

/**
 * Startup checks: cold signature, KES key match, period window
 * (`period ≤ current < period + maxEvolutions`) and counter progression
 * (Praos: counter must be last on-chain + 1 when one exists; ledger accepts
 * up to +1 at most, a stale counter is rejected as "opcert counter too small").
 * Returns the evolution the KES key must be at for the current period.
 */
export function checkOperationalCert(oc: OperationalCert, input: OpcertCheckInput): OpcertCheck {
    const { cert } = oc;
    const signed = opcertSigningBytes(cert.kesVkey, cert.counter, cert.kesPeriod);
    if (!verifyEd25519Signature_sync(cert.signature, signed, oc.coldVkey)) return { ok: false, reason: "cold signature invalid" };
    if (!bytesEqual(cert.kesVkey, input.kesVkey)) return { ok: false, reason: "certificate is for a different KES key" };
    if (input.currentKesPeriod < cert.kesPeriod) return { ok: false, reason: `KES period ${cert.kesPeriod} starts after the current period ${input.currentKesPeriod}` };
    if (input.currentKesPeriod >= cert.kesPeriod + input.maxKesEvolutions) return { ok: false, reason: `KES key expired: period ${cert.kesPeriod} + ${input.maxKesEvolutions} evolutions ≤ current ${input.currentKesPeriod}` };
    if (input.lastOnChainCounter != null) {
        // OCERT: the counter must be at least the last one the chain saw for this pool and at
        // most one above it. Equal is the normal case: one certificate serves every block until
        // the operator rotates it (2026-09-12 06:35 UTC: our own first accepted block recorded
        // counter 0 and the producer refused to restart with the same certificate).
        if (cert.counter < input.lastOnChainCounter) return { ok: false, reason: `counter ${cert.counter} below last on-chain counter ${input.lastOnChainCounter}` };
        if (cert.counter > input.lastOnChainCounter + 1n) return { ok: false, reason: `counter ${cert.counter} skips ahead of last on-chain counter ${input.lastOnChainCounter} (must be +1)` };
    }
    return { ok: true, evolution: Number(input.currentKesPeriod - cert.kesPeriod) };
}

export function kesPeriodOfSlot(slot: bigint, slotsPerKESPeriod: bigint): bigint {
    return slot / slotsPerKESPeriod;
}

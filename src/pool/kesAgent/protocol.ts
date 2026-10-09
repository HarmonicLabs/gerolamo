/**
 * Wire format of the kes-agent "service" protocol (input-output-hk/kes-agent, the protocol
 * cardano-node 10.7+ speaks with `--shelley-kes-agent-socket`). Everything is raw big-endian
 * binary over a Unix socket, no length-prefixed frames:
 *
 *   1. Version handshake (`VersionHandshake:0.1`). The agent offers its versions:
 *        u32 count ‖ count × 32-byte version identifier
 *      the client answers with a Maybe identifier:
 *        0x01 ‖ 32-byte identifier   (accept)    or    0x00   (reject, then close)
 *   2. Service protocol of the accepted version. The agent first repeats the identifier
 *      (32 bytes, `VersionMessage`), then pushes keys; the client confirms each one with a
 *      `RecvResult` (u32). Disconnects are signalled by closing the socket.
 *        Service:2.0  push = u8 kind (0 key, 1 drop) ‖ u64 timestamp (µs since 1970) ‖ [bundle if key]
 *        Service:1.0  push = bundle
 *   3. Bundle (724 bytes):
 *        Sum6 KES sign key (608) ‖ u32 period (evolutions since the opcert's start period)
 *        ‖ opcert: KES vkey (32) ‖ u64 counter ‖ u64 KES start period ‖ cold signature (64)
 *
 * Version identifiers are ASCII names zero-padded (or truncated) to 32 bytes
 * (`Cardano.KESAgent.Protocols.VersionedProtocol.mkVersionIdentifier`).
 * Sources: src/kes-agent/Cardano/KESAgent/Protocols/{VersionHandshake,Service/V1,Service/V2}/Driver.hs,
 * Serialization/DirectCodec.hs, Serialization/RawUtil.hs (RecvResult as Word32) and protocol.html.
 *
 * The first 612 bytes of a bundle are exactly the in-memory KES key layout of
 * @harmoniclabs/kes (608-byte Sum6 body ‖ u32 BE period), so a pushed key is used as is.
 */
import type { OpcertFields } from "../keystore";

export const VERSION_ID_BYTES = 32;
export const KES_SIGN_KEY_BYTES = 608;
export const KES_SIGN_KEY_WITH_PERIOD_BYTES = 612;
export const OPCERT_WIRE_BYTES = 32 + 8 + 8 + 64; // 112
export const BUNDLE_BYTES = KES_SIGN_KEY_WITH_PERIOD_BYTES + OPCERT_WIRE_BYTES; // 724
/** A real agent offers three versions; anything far above that is a broken or hostile peer. */
export const MAX_OFFERED_VERSIONS = 64;

export const SERVICE_V2 = "Service:2.0";
export const SERVICE_V1 = "Service:1.0";
/** The versions this client speaks, most preferred first (cardano-node's order). */
export const CLIENT_VERSIONS = [SERVICE_V2, SERVICE_V1] as const;
export type ServiceVersion = (typeof CLIENT_VERSIONS)[number];

/** `RecvResult` (RawUtil.encodeRecvResult). */
export const RecvResult = {
    ok: 0,
    keyOutdated: 1,
    invalidOpCert: 2,
    noKey: 3,
    unsupportedOperation: 4,
    unknown: 0xffff,
} as const;
export type RecvResultCode = (typeof RecvResult)[keyof typeof RecvResult];

export function recvResultName(code: number): string {
    switch (code) {
        case RecvResult.ok: return "OK";
        case RecvResult.keyOutdated: return "KeyOutdated";
        case RecvResult.invalidOpCert: return "InvalidOpCert";
        case RecvResult.noKey: return "NoKey";
        case RecvResult.unsupportedOperation: return "UnsupportedOperation";
        default: return "Unknown";
    }
}

export const KEY_MESSAGE = 0;
export const DROP_KEY_MESSAGE = 1;

export interface AgentBundle {
    /** Sum6 KES sign key ‖ u32 BE period (612 bytes). Secret: the receiver owns it and zeroes it. */
    kesSignKey: Uint8Array;
    /** Evolutions since `opcert.kesPeriod` the key is at (the u32 suffix). */
    period: number;
    opcert: OpcertFields;
}

/** A V2 push: a key bundle or a request to drop the current key, tagged with the agent's timestamp (µs). */
export type ServicePush =
    | { kind: "key"; timestamp: bigint; bundle: AgentBundle }
    | { kind: "drop"; timestamp: bigint };

const ascii = new TextEncoder();

/** `mkVersionIdentifier`: the name zero-padded / truncated to 32 bytes. */
export function versionId(name: string): Uint8Array {
    const out = new Uint8Array(VERSION_ID_BYTES);
    out.set(ascii.encode(name).subarray(0, VERSION_ID_BYTES));
    return out;
}

/** The printable name of a version identifier (trailing zero bytes dropped, as kes-agent prints it). */
export function versionName(id: Uint8Array): string {
    let end = id.length;
    while (end > 0 && id[end - 1] === 0) end--;
    return new TextDecoder().decode(id.subarray(0, end));
}

function u32(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, false);
    return b;
}
function u64(n: bigint): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), false);
    return b;
}
export function readU32(b: Uint8Array, off = 0): number {
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, false);
}
export function readU64(b: Uint8Array, off = 0): bigint {
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, false);
}
export function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// ─────────────────────────── handshake ───────────────────────────

/** `VersionOfferMessage` (agent → client). */
export function encodeVersionOffer(names: readonly string[]): Uint8Array {
    return concat([u32(names.length), ...names.map(versionId)]);
}

/** Body of a version offer once its count is known: `count` identifiers. */
export function decodeVersionIds(body: Uint8Array, count: number): string[] {
    if (body.length !== count * VERSION_ID_BYTES) throw new Error(`version offer: ${body.length} bytes for ${count} identifiers`);
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(versionName(body.subarray(i * VERSION_ID_BYTES, (i + 1) * VERSION_ID_BYTES)));
    return out;
}

/** `VersionAcceptMessage` (Just id) or `VersionRejectedMessage` (Nothing), client → agent. */
export function encodeVersionAnswer(name: string | null): Uint8Array {
    return name == null ? new Uint8Array([0]) : concat([new Uint8Array([1]), versionId(name)]);
}

/** The first version in our preference order the agent offers, or null. */
export function pickVersion(offered: readonly string[]): ServiceVersion | null {
    for (const v of CLIENT_VERSIONS) if (offered.includes(v)) return v;
    return null;
}

// ─────────────────────────── bundle ───────────────────────────

export function encodeOpcertWire(c: OpcertFields): Uint8Array {
    if (c.kesVkey.length !== 32 || c.signature.length !== 64) throw new Error("opcert: KES vkey must be 32 bytes and the signature 64");
    return concat([c.kesVkey, u64(c.counter), u64(c.kesPeriod), c.signature]);
}

export function decodeOpcertWire(b: Uint8Array): OpcertFields {
    if (b.length !== OPCERT_WIRE_BYTES) throw new Error(`opcert: ${b.length} bytes, expected ${OPCERT_WIRE_BYTES}`);
    return {
        kesVkey: Uint8Array.from(b.subarray(0, 32)),
        counter: readU64(b, 32),
        kesPeriod: readU64(b, 40),
        signature: Uint8Array.from(b.subarray(48, 112)),
    };
}

export function encodeBundle(kesSignKeyWithPeriod: Uint8Array, opcert: OpcertFields): Uint8Array {
    if (kesSignKeyWithPeriod.length !== KES_SIGN_KEY_WITH_PERIOD_BYTES) throw new Error(`KES sign key: ${kesSignKeyWithPeriod.length} bytes, expected ${KES_SIGN_KEY_WITH_PERIOD_BYTES}`);
    return concat([kesSignKeyWithPeriod, encodeOpcertWire(opcert)]);
}

/** Decode a 724-byte bundle. The KES key is copied out; the caller zeroes `b` afterwards. */
export function decodeBundle(b: Uint8Array): AgentBundle {
    if (b.length !== BUNDLE_BYTES) throw new Error(`bundle: ${b.length} bytes, expected ${BUNDLE_BYTES}`);
    const kesSignKey = Uint8Array.from(b.subarray(0, KES_SIGN_KEY_WITH_PERIOD_BYTES));
    return { kesSignKey, period: readU32(b, KES_SIGN_KEY_BYTES), opcert: decodeOpcertWire(b.subarray(KES_SIGN_KEY_WITH_PERIOD_BYTES)) };
}

// ─────────────────────────── service messages ───────────────────────────

/** A Service:2.0 key push (agent → client). */
export function encodeKeyMessageV2(timestamp: bigint, kesSignKeyWithPeriod: Uint8Array, opcert: OpcertFields): Uint8Array {
    return concat([new Uint8Array([KEY_MESSAGE]), u64(timestamp), encodeBundle(kesSignKeyWithPeriod, opcert)]);
}

/** A Service:2.0 drop-key request (agent → client). */
export function encodeDropKeyMessageV2(timestamp: bigint): Uint8Array {
    return concat([new Uint8Array([DROP_KEY_MESSAGE]), u64(timestamp)]);
}

/** A Service:1.0 key push: the bare bundle. */
export function encodeKeyMessageV1(kesSignKeyWithPeriod: Uint8Array, opcert: OpcertFields): Uint8Array {
    return encodeBundle(kesSignKeyWithPeriod, opcert);
}

/** `RecvResultMessage` (client → agent). */
export function encodeRecvResult(code: number): Uint8Array {
    return u32(code);
}

export function decodeRecvResult(b: Uint8Array): number {
    if (b.length !== 4) throw new Error(`RecvResult: ${b.length} bytes, expected 4`);
    const w = readU32(b);
    return w <= 4 ? w : RecvResult.unknown;
}

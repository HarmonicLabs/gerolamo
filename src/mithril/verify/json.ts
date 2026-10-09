/**
 * JSON helpers for Mithril messages.
 *
 * Mithril encodes keys and signatures as "JSON hex": the hex of a serde_json document. Stakes are
 * u64 and can exceed 2^53, so every parse here keeps integers outside the safe range as bigint
 * (Bun's JSON.parse reviver exposes the source text of each number).
 */

/** Parse JSON text; integers that do not fit a double exactly come back as bigint. */
export function parseJsonLossless(text: string): unknown {
    return JSON.parse(text, (_key, value, ctx?: { source?: string }) => {
        if (typeof value === "number" && !Number.isSafeInteger(value) && ctx?.source && /^-?\d+$/.test(ctx.source)) {
            return BigInt(ctx.source);
        }
        return value;
    });
}

// Portable (no Buffer / node:crypto): the browser node uses this verifier too.

export function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex string");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    return out;
}

export function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return s;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Decode a "JSON hex" string (hex of a UTF-8 JSON document). */
export function decodeJsonHex(hex: string): unknown {
    return parseJsonLossless(new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(hex)));
}

/** Encode a canonical JSON document (already serialized) as "JSON hex". */
export function encodeJsonHex(json: string): string {
    return bytesToHex(new TextEncoder().encode(json));
}

/** A u64 from a JSON value (number or bigint), or throw. */
export function asU64(v: unknown, label: string): bigint {
    if (typeof v === "bigint") {
        if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${label}: out of u64 range`);
        return v;
    }
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    throw new Error(`${label}: not an unsigned integer`);
}

/** A JSON array of bytes (serde's Vec<u8>/[u8; N] form) of the given length, or throw. */
export function asByteArray(v: unknown, len: number | null, label: string): Uint8Array {
    if (!Array.isArray(v)) throw new Error(`${label}: not a byte array`);
    if (len != null && v.length !== len) throw new Error(`${label}: ${v.length} bytes, want ${len}`);
    const out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) {
        const n = v[i];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${label}[${i}]: not a byte`);
        out[i] = n;
    }
    return out;
}

/** serde_json form of a byte array: `[1,2,3]`. */
export function byteArrayJson(b: Uint8Array): string {
    return `[${Array.from(b).join(",")}]`;
}

export function isObject(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === "object" && !Array.isArray(v);
}

/** JSON.stringify that writes bigint values as plain JSON numbers (inverse of parseJsonLossless). */
export function stringifyJsonLossless(value: unknown, space?: number): string {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(v.toString()) : v), space);
}

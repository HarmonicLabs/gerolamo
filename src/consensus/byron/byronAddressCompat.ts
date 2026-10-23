/**
 * ByronAddress across cardano-ledger-ts versions.
 *
 * Up to 0.6.0-dijkstra.1+conformance.3 (and npm 0.5.5), `ByronAddress.type` is the on-wire Byron address type
 * (0 public key, 1 script, 2 redeem) and `toBytes()` returns the raw address bytes. From npm 0.5.6 (and the
 * merged 0.6.0), `ByronAddress extends Address`: `type` is always `"byron"`, the wire type moved to `byronType`,
 * the raw bytes to `toBuffer()`, and `toBytes()` returns a `byte[]`. Read both through these helpers.
 */

/** The on-wire Byron address type (0, 1 or 2), whichever cardano-ledger-ts version built the object. */
export function byronAddressType(addr: { type?: unknown; byronType?: unknown } | null | undefined): number {
    if (!addr) return NaN;
    if (typeof addr.byronType === "number") return addr.byronType;
    return Number(addr.type);
}

/** The raw Byron address bytes (the base58-decoded `[#6.24(payload), crc32]` array). */
export function byronAddressBytes(addr: { toBuffer?: () => Uint8Array; toBytes: () => Uint8Array | number[] }): Uint8Array {
    if (typeof addr.toBuffer === "function") return addr.toBuffer();
    return Uint8Array.from(addr.toBytes());
}

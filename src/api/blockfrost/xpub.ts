/**
 * BIP32-Ed25519 (Khovratovich–Law, the derivation Cardano wallets use) public derivation for
 * Blockfrost's `/utils/addresses/xpub/{xpub}/{role}/{index}`: account xpub → role → index, base
 * address with the account's first stake key (m/…/2/0), or for role 2 the stake address of
 * that index. Pure TypeScript (@noble/curves, @noble/hashes).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha2";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { bech32Encode } from "../../db/stakeCred";

export interface XPubKey { key: Uint8Array; chain: Uint8Array }

const le32 = (i: number) => Uint8Array.of(i & 0xff, (i >>> 8) & 0xff, (i >>> 16) & 0xff, (i >>> 24) & 0xff);
const leInt = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!); return v; };

/** Soft (non-hardened) child of an extended public key. */
export function deriveSoft(x: XPubKey, index: number): XPubKey {
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("soft derivation needs an index below 2^31");
    const z = hmac(sha512, x.chain, new Uint8Array([0x02, ...x.key, ...le32(index)]));
    const zl8 = 8n * leInt(z.subarray(0, 28));
    const child = ed25519.ExtendedPoint.fromHex(x.key).add(ed25519.ExtendedPoint.BASE.multiply(zl8));
    const c = hmac(sha512, x.chain, new Uint8Array([0x03, ...x.key, ...le32(index)]));
    return { key: child.toRawBytes(), chain: c.subarray(32, 64) };
}

export function parseXPub(hex: string): XPubKey | null {
    if (!/^[0-9a-fA-F]{128}$/.test(hex)) return null;
    const b = Uint8Array.from(Buffer.from(hex, "hex"));
    try { ed25519.ExtendedPoint.fromHex(b.subarray(0, 32)); } catch { return null; }
    return { key: b.subarray(0, 32), chain: b.subarray(32) };
}

/** Blockfrost-js `deriveAddress`: base address (role 0/1) or stake address (role 2). */
export function deriveAddress(account: XPubKey, role: number, index: number, mainnet: boolean): string {
    const net = mainnet ? 1 : 0;
    const keyHash = (x: XPubKey) => blake2b_224(x.key);
    if (role === 2) return bech32Encode(mainnet ? "stake" : "stake_test", Uint8Array.from([0xe0 | net, ...keyHash(deriveSoft(deriveSoft(account, 2), index))]));
    const pay = keyHash(deriveSoft(deriveSoft(account, role), index));
    const stake = keyHash(deriveSoft(deriveSoft(account, 2), 0));
    return bech32Encode(mainnet ? "addr" : "addr_test", Uint8Array.from([net, ...pay, ...stake]));
}

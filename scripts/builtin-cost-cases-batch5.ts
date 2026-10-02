// Conversion, bitwise, hash and signature builtins for builtin-cost-diff (--batch5): cases whose
// sizes are costed literally (integerToByteString / replicateByte widths, shift / rotate amounts).
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
export const extra: Array<[string, string]> = [];
const bs = (n: number, b = 0xab) => "#" + Buffer.alloc(n, b).toString("hex");
const hexs = (u: Uint8Array) => "#" + Buffer.from(u).toString("hex");
const app = (f: string, ...args: string[]) => args.reduce((acc, a) => `[${acc} ${a}]`, f);
const B = (b: string) => `(builtin ${b})`;
const bool = (x: boolean) => `(con bool ${x ? "True" : "False"})`;
const I = (n: number | bigint | string) => `(con integer ${n})`;
const S = (s: string) => `(con bytestring ${s})`;
for (const [be, w, n] of [[true, 0, 0], [true, 0, 255], [false, 0, 256], [true, 4, 258], [false, 8, 1n << 60n], [true, 20, 12345], [true, 0, 1n << 200n], [false, 100, 7], [true, 1, 1000]] as Array<[boolean, number, number | bigint]>)
    extra.push([`integerToByteString(${be},${w},${n})`, app(B("integerToByteString"), bool(be), I(w), I(n))]);
for (const [be, b] of [[true, bs(0)], [true, "#00ff"], [false, "#00ff"], [true, bs(40, 0x7f)], [false, bs(9, 0x01)]] as Array<[boolean, string]>)
    extra.push([`byteStringToInteger(${be},${b.slice(0, 10)})`, app(B("byteStringToInteger"), bool(be), S(b))]);
for (const op of ["andByteString", "orByteString", "xorByteString"]) for (const pad of [true, false]) for (const [x, y] of [["#0f0f", "#ff"], [bs(20, 0x5a), bs(3, 0xa5)], ["#", "#1234"]])
    extra.push([`${op}(${pad},${x.length},${y.length})`, app(B(op), bool(pad), S(x), S(y))]);
for (const x of ["#", "#00", bs(17, 0x3c)]) {
    extra.push([`complementByteString(${x.length})`, app(B("complementByteString"), S(x))]);
    extra.push([`countSetBits(${x.length})`, app(B("countSetBits"), S(x))]);
    extra.push([`findFirstSetBit(${x.length})`, app(B("findFirstSetBit"), S(x))]);
    extra.push([`ripemd_160(${x.length})`, app(B("ripemd_160"), S(x))]);
    extra.push([`keccak_256(${x.length})`, app(B("keccak_256"), S(x))]);
    extra.push([`blake2b_224(${x.length})`, app(B("blake2b_224"), S(x))]);
}
extra.push(["findFirstSetBit(#0080)", app(B("findFirstSetBit"), S("#0080"))]);
extra.push(["findFirstSetBit(#8000)", app(B("findFirstSetBit"), S("#8000"))]);
for (const i of [0, 7, 8, 15, 31]) extra.push([`readBit(#f0f1a2b3,${i})`, app(B("readBit"), S("#f0f1a2b3"), I(i))]);
for (const [idx, set] of [["[0, 9, 31]", true], ["[1]", false], ["[]", true]] as Array<[string, boolean]>)
    extra.push([`writeBits(${idx},${set})`, app(B("writeBits"), S("#f0f1a2b3"), `(con (list integer) ${idx})`, bool(set))]);
for (const [n, b] of [[0, 1], [5, 255], [9, 0], [100, 7], [8192, 1]]) extra.push([`replicateByte(${n},${b})`, app(B("replicateByte"), I(n), I(b))]);
for (const k of [0, 1, 7, 8, 13, -3, -9, 31, 32, 40, -40, 1000]) {
    extra.push([`shiftByteString(#f0f1a2b3,${k})`, app(B("shiftByteString"), S("#f0f1a2b3"), I(k))]);
    extra.push([`rotateByteString(#f0f1a2b3,${k})`, app(B("rotateByteString"), S("#f0f1a2b3"), I(k))]);
}
// secp256k1: a valid, a high-S, a wrong-message ECDSA signature; a valid and a wrong Schnorr one
const sk = new Uint8Array(32).fill(7);
const msg = new Uint8Array(32).fill(3);
const sig = secp256k1.sign(msg, sk, { lowS: true, prehash: false });
const pk = secp256k1.getPublicKey(sk, true);
const hi = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
extra.push(["ecdsa(valid)", app(B("verifyEcdsaSecp256k1Signature"), S(hexs(pk)), S(hexs(msg)), S(hexs(sig.toCompactRawBytes())))]);
extra.push(["ecdsa(highS)", app(B("verifyEcdsaSecp256k1Signature"), S(hexs(pk)), S(hexs(msg)), S(hexs(hi.toCompactRawBytes())))]);
extra.push(["ecdsa(wrong msg)", app(B("verifyEcdsaSecp256k1Signature"), S(hexs(pk)), S(bs(32, 9)), S(hexs(sig.toCompactRawBytes())))]);
const smsg = new TextEncoder().encode("hello schnorr, any length");
const ssig = schnorr.sign(smsg, sk);
const xpk = schnorr.getPublicKey(sk);
extra.push(["schnorr(valid)", app(B("verifySchnorrSecp256k1Signature"), S(hexs(xpk)), S(hexs(smsg)), S(hexs(ssig)))]);
extra.push(["schnorr(wrong)", app(B("verifySchnorrSecp256k1Signature"), S(hexs(xpk)), S(bs(5)), S(hexs(ssig)))]);
// Ed25519: a valid signature, a wrong message, a non-canonical S
import { ed25519 } from "@noble/curves/ed25519";
const esk = new Uint8Array(32).fill(5), epk = ed25519.getPublicKey(esk), emsg = new TextEncoder().encode("ed25519 message");
const esig = ed25519.sign(emsg, esk);
extra.push(["ed25519(valid)", app(B("verifyEd25519Signature"), S(hexs(epk)), S(hexs(emsg)), S(hexs(esig)))]);
extra.push(["ed25519(wrong msg)", app(B("verifyEd25519Signature"), S(hexs(epk)), S(bs(15)), S(hexs(esig)))]);
const hiS = Uint8Array.from(esig); hiS[63] |= 0xf0;
extra.push(["ed25519(S >= L)", app(B("verifyEd25519Signature"), S(hexs(epk)), S(hexs(emsg)), S(hexs(hiS)))]);

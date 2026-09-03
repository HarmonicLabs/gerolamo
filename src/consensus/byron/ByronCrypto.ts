import { createHash } from "node:crypto";
import { Cbor, CborArray, CborBytes, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_224, verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Byron (Ouroboros-BFT era) cryptography, byte-exact with cardano-ledger-byron.
 *
 * Keys: a Byron `VerificationKey` is a 64-byte extended ed25519 XPub
 * (32-byte public key ‖ 32-byte chain code). Signatures verify against the
 * first 32 bytes.
 *
 * KeyHash (`Cardano.Crypto.Hashing.addressHash`):
 *   blake2b-224( sha3-256( cbor(xpub) ) )          cbor(xpub) = 0x58 0x40 ‖ xpub
 *
 * Sign tags (`Cardano.Crypto.Signing.Tag`), network = cbor(protocolMagic):
 *   SignCertificate       = 0x0a ‖ network
 *   SignBlock issuerXPub  = "01" ‖ issuerXPub ‖ 0x09 ‖ network      ("01" = ASCII)
 *
 * Delegation certificate (`Cardano.Chain.Delegation.Certificate`):
 *   issuer signs   cbor-bytes( "00" ‖ delegateXPub ‖ cbor(epoch) )   ("00" = ASCII)
 *   message        = SignCertificate-tag ‖ that CBOR byte string
 *
 * Block signature (`Cardano.Chain.Block.Header`, `ToSign`):
 *   delegate signs 0x85 ‖ raw(prevBlock) ‖ raw(proof) ‖ raw(slotId) ‖ raw(difficulty) ‖ raw(extra)
 *   message        = SignBlock(issuerXPub)-tag ‖ those bytes
 *   where raw(x) are the exact header CBOR slices — never re-encoded.
 *
 * Every rule here was verified against the preprod Byron chain and the preprod
 * Byron genesis `heavyDelegation` certificates (see ByronCrypto.test.ts).
 */

const ASCII_00 = new Uint8Array([0x30, 0x30]);
const ASCII_01 = new Uint8Array([0x30, 0x31]);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function sha3_256(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha3-256").update(bytes).digest());
}

function cborUInt(n: bigint | number): Uint8Array {
    return Cbor.encode(new CborUInt(BigInt(n))).toBuffer();
}

function cborBytes(b: Uint8Array): Uint8Array {
    return Cbor.encode(new CborBytes(b)).toBuffer();
}

/** Byron `KeyHash` of a 64-byte XPub, hex. */
export function byronKeyHash(xpub: Uint8Array): string {
    if (xpub.length !== 64) throw new Error(`byronKeyHash: expected 64-byte XPub, got ${xpub.length}`);
    return toHex(blake2b_224(sha3_256(concatBytes(new Uint8Array([0x58, 0x40]), xpub))));
}

export function signTagCertificate(protocolMagic: number): Uint8Array {
    return concatBytes(new Uint8Array([0x0a]), cborUInt(protocolMagic));
}

export function signTagBlock(protocolMagic: number, issuerXPub: Uint8Array): Uint8Array {
    return concatBytes(ASCII_01, issuerXPub, new Uint8Array([0x09]), cborUInt(protocolMagic));
}

export interface ByronDelegationCertificate {
    epoch: bigint;
    issuerXPub: Uint8Array;
    delegateXPub: Uint8Array;
    signature: Uint8Array;
}

/** Verify a heavyweight delegation certificate: issuer → delegate for `epoch`. */
export function verifyByronDelegationCert(
    cert: ByronDelegationCertificate,
    protocolMagic: number,
): boolean {
    if (cert.issuerXPub.length !== 64 || cert.delegateXPub.length !== 64 || cert.signature.length !== 64) {
        return false;
    }
    const payload = cborBytes(concatBytes(ASCII_00, cert.delegateXPub, cborUInt(cert.epoch)));
    const message = concatBytes(signTagCertificate(protocolMagic), payload);
    return verifyEd25519Signature_sync(cert.signature, message, cert.issuerXPub.slice(0, 32));
}

export interface ByronMainHeaderSlices {
    /** Raw CBOR slices of `[magic, prevBlock, proof, consensus, extra]`. */
    prevBlock: Uint8Array;
    proof: Uint8Array;
    slotId: Uint8Array;
    difficulty: Uint8Array;
    extra: Uint8Array;
    /** Header `consensusData.pubkey` (the genesis/issuer key). */
    headerPubKey: Uint8Array;
    /** Parsed `blockSig`. */
    blockSig: { type: number; cert: ByronDelegationCertificate | null; signature: Uint8Array };
}

/** Slice a raw Byron main-block header without re-encoding anything. */
export function sliceByronMainHeader(rawHeader: Uint8Array): ByronMainHeaderSlices {
    const header = Cbor.parseLazy(rawHeader);
    if (!(header instanceof LazyCborArray) || header.array.length < 5) {
        throw new Error("sliceByronMainHeader: header is not a 5-element array");
    }
    const consensus = Cbor.parseLazy(header.array[3]!);
    if (!(consensus instanceof LazyCborArray) || consensus.array.length < 4) {
        throw new Error("sliceByronMainHeader: consensus data malformed");
    }
    const pub = Cbor.parse(consensus.array[1]!);
    if (!(pub instanceof CborBytes)) throw new Error("sliceByronMainHeader: pubkey not bytes");
    const sigObj = Cbor.parse(consensus.array[3]!);
    if (!(sigObj instanceof CborArray) || sigObj.array.length < 2 || !(sigObj.array[0] instanceof CborUInt)) {
        throw new Error("sliceByronMainHeader: blockSig malformed");
    }
    const type = Number(sigObj.array[0].num);
    let cert: ByronDelegationCertificate | null = null;
    let signature: Uint8Array;
    if (type === 2) {
        // ABlockSignature = [2, [ [epoch, issuer, delegate, certSig], signature ]]
        const inner = sigObj.array[1];
        if (!(inner instanceof CborArray) || inner.array.length < 2) {
            throw new Error("sliceByronMainHeader: dlg blockSig malformed");
        }
        const c = inner.array[0];
        const s = inner.array[1];
        if (
            !(c instanceof CborArray) || c.array.length < 4 ||
            !(c.array[0] instanceof CborUInt) || !(c.array[1] instanceof CborBytes) ||
            !(c.array[2] instanceof CborBytes) || !(c.array[3] instanceof CborBytes) ||
            !(s instanceof CborBytes)
        ) {
            throw new Error("sliceByronMainHeader: delegation certificate malformed");
        }
        cert = {
            epoch: c.array[0].num,
            issuerXPub: c.array[1].bytes,
            delegateXPub: c.array[2].bytes,
            signature: c.array[3].bytes,
        };
        signature = s.bytes;
    } else if (sigObj.array[1] instanceof CborBytes) {
        // type 0: plain signature by the header pubkey. type 1 (lightweight) is not used on chain.
        signature = sigObj.array[1].bytes;
    } else {
        throw new Error(`sliceByronMainHeader: unsupported blockSig type ${type}`);
    }
    return {
        prevBlock: header.array[1]!,
        proof: header.array[2]!,
        slotId: consensus.array[0]!,
        difficulty: consensus.array[2]!,
        extra: header.array[4]!,
        headerPubKey: pub.bytes,
        blockSig: { type, cert, signature },
    };
}

/** `ToSign` bytes: `0x85 ‖ prevBlock ‖ proof ‖ slotId ‖ difficulty ‖ extra` (raw slices). */
export function byronToSignBytes(s: ByronMainHeaderSlices): Uint8Array {
    return concatBytes(new Uint8Array([0x85]), s.prevBlock, s.proof, s.slotId, s.difficulty, s.extra);
}

export interface ByronBlockSignatureCheck {
    ok: boolean;
    reason?: string;
    /** KeyHash (hex) of the genesis key that authorised this block, when known. */
    issuerKeyHash?: string;
    /** KeyHash (hex) of the key that actually signed. */
    signerKeyHash?: string;
}

/**
 * Verify a Byron main-block signature.
 * type 2: certificate must be valid and issued by the header pubkey; delegate signs ToSign.
 * type 0: header pubkey signs ToSign directly (SignBlock tag with itself as issuer).
 */
export function verifyByronBlockSignature(
    rawHeader: Uint8Array,
    protocolMagic: number,
): ByronBlockSignatureCheck {
    const s = sliceByronMainHeader(rawHeader);
    if (s.headerPubKey.length !== 64) return { ok: false, reason: "header pubkey not 64 bytes" };
    const toSign = byronToSignBytes(s);

    if (s.blockSig.type === 2) {
        const cert = s.blockSig.cert!;
        if (!verifyByronDelegationCert(cert, protocolMagic)) {
            return { ok: false, reason: "delegation certificate signature invalid" };
        }
        if (toHex(cert.issuerXPub) !== toHex(s.headerPubKey)) {
            return { ok: false, reason: "certificate issuer is not the header pubkey" };
        }
        const message = concatBytes(signTagBlock(protocolMagic, cert.issuerXPub), toSign);
        const ok = verifyEd25519Signature_sync(s.blockSig.signature, message, cert.delegateXPub.slice(0, 32));
        return {
            ok,
            reason: ok ? undefined : "block signature invalid",
            issuerKeyHash: byronKeyHash(cert.issuerXPub),
            signerKeyHash: byronKeyHash(cert.delegateXPub),
        };
    }
    if (s.blockSig.type === 0) {
        const message = concatBytes(signTagBlock(protocolMagic, s.headerPubKey), toSign);
        const ok = verifyEd25519Signature_sync(s.blockSig.signature, message, s.headerPubKey.slice(0, 32));
        const kh = byronKeyHash(s.headerPubKey);
        return { ok, reason: ok ? undefined : "block signature invalid", issuerKeyHash: kh, signerKeyHash: kh };
    }
    return { ok: false, reason: `unsupported blockSig type ${s.blockSig.type}` };
}

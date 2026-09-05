/**
 * Witness collection: turns a transaction's witness set into ed25519 items for
 * the pool and the key hashes those items vouch for once verified.
 *
 * Shelley+ vkey witness: key hash = blake2b_224(vkey); message = tx body hash.
 * Bootstrap witness: key = pubKey ‖ chainCode, the address root it vouches for is
 * `blake2b_224(sha3_256(cbor([0, [0, key], attributes])))`; message = body hash.
 * Byron witnesses are per input (twit[i] spends input[i]); the signed message is
 * `tag ‖ cbor(protocolMagic) ‖ cbor(txHash)` with tag 1 (PkWitness) or 2 (Redeem).
 */
import type { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { CborArray, CborBytes, CborUInt, Cbor, CborMap, CborTag } from "@harmoniclabs/cbor";
import { blake2b_224, sha3 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { WitnessItem } from "../workers/witnessJob";

export interface CollectedWitnesses {
    items: WitnessItem[];
    /** Per item: the vkey hash ("key") or Byron root ("root") it proves, when it verifies. */
    proves: Array<{ kind: "key" | "root"; hash: string }>;
    problems: string[];
}

function bytesOf(v: any): Uint8Array | null {
    if (v instanceof Uint8Array) return v;
    if (v?.toBuffer) return new Uint8Array(v.toBuffer());
    if (v?.bytes instanceof Uint8Array) return v.bytes;
    if (typeof v?.toString === "function" && /^[0-9a-f]+$/i.test(String(v))) return new Uint8Array(Buffer.from(String(v), "hex"));
    return null;
}

/**
 * Byron address root (cardano-ledger-byron `addrRoot`):
 * blake2b_224(sha3_256(cbor([addrType, spendingData, attributes]))). Built from
 * raw CBOR here: ledger-ts carries its own cbor copy, so its objects must not
 * cross the boundary (see memory: pass bytes, never CborObj).
 */
export function byronAddressRoot(addrType: 0 | 1 | 2, spendingTag: number, key: Uint8Array, attributesCbor: Uint8Array): string {
    const spending = Cbor.encode(new CborArray([new CborUInt(spendingTag), new CborBytes(key)])).toBuffer();
    const head = new Uint8Array([0x83, addrType]); // 3-element array, small uint type
    const all = new Uint8Array(head.length + spending.length + attributesCbor.length);
    all.set(head, 0);
    all.set(spending, head.length);
    all.set(attributesCbor, head.length + spending.length);
    return toHex(blake2b_224(new Uint8Array(sha3(all))));
}

/** The attributes map of a parsed Byron address, re-encoded as CBOR bytes. */
export function byronAddressAttributesCbor(addr: ByronAddress): Uint8Array {
    try {
        const outer = Cbor.parse((addr as any).toCborBytes());
        if (outer instanceof CborArray) {
            const tagged = outer.array[0];
            const payload = tagged instanceof CborTag ? tagged.data : null;
            if (payload instanceof CborBytes) {
                const inner = Cbor.parse(payload.bytes);
                if (inner instanceof CborArray && inner.array[1]) return Cbor.encode(inner.array[1]).toBuffer();
            }
        }
    } catch {
        /* fall through */
    }
    // Reconstruct from the decoded attributes (mainnet addresses carry none).
    const a: any = addr.attributes ?? {};
    const entries: Array<{ k: CborUInt; v: CborBytes }> = [];
    if (a.derivationPath instanceof Uint8Array) entries.push({ k: new CborUInt(1), v: new CborBytes(Cbor.encode(new CborBytes(a.derivationPath)).toBuffer()) });
    if (typeof a.networkMagic === "number") entries.push({ k: new CborUInt(2), v: new CborBytes(Cbor.encode(new CborUInt(BigInt(a.networkMagic))).toBuffer()) });
    return Cbor.encode(new CborMap(entries)).toBuffer();
}

export function bootstrapAddressRoot(pubKey: Uint8Array, chainCode: Uint8Array, attributesCbor: Uint8Array): string {
    const key = new Uint8Array(64);
    key.set(pubKey.subarray(0, 32), 0);
    key.set(chainCode.subarray(0, 32), 32);
    return byronAddressRoot(0, 0, key, attributesCbor);
}

export function collectShelleyWitnesses(bodyHash: Uint8Array, witnessSet: any): CollectedWitnesses {
    const out: CollectedWitnesses = { items: [], proves: [], problems: [] };
    for (const w of (witnessSet?.vkeyWitnesses ?? []) as any[]) {
        const vkey = bytesOf(w.vkey);
        const sig = bytesOf(w.signature);
        if (!vkey || !sig) {
            out.problems.push("vkey witness without key or signature");
            continue;
        }
        out.items.push({ publicKey: vkey, signature: sig, message: bodyHash });
        out.proves.push({ kind: "key", hash: toHex(blake2b_224(vkey)) });
    }
    for (const w of (witnessSet?.bootstrapWitnesses ?? []) as any[]) {
        const pk = bytesOf(w.pubKey);
        const sig = bytesOf(w.signature);
        const cc = bytesOf(w.chainCode);
        const attrs = bytesOf(w.attributes) ?? new Uint8Array([0xa0]);
        if (!pk || !sig || !cc) {
            out.problems.push("bootstrap witness without key, chain code or signature");
            continue;
        }
        out.items.push({ publicKey: pk, signature: sig, message: bodyHash });
        out.proves.push({ kind: "root", hash: bootstrapAddressRoot(pk, cc, attrs) });
    }
    return out;
}

/** Byron signing message: `tag ‖ cbor(magic) ‖ cbor(bytes txHash)`. */
export function byronSignedMessage(tag: 1 | 2, protocolMagic: number, txHash: Uint8Array): Uint8Array {
    const magic = Cbor.encode(new CborUInt(BigInt(protocolMagic))).toBuffer();
    const out = new Uint8Array(1 + magic.length + 2 + txHash.length);
    out[0] = tag;
    out.set(magic, 1);
    out[1 + magic.length] = 0x58;
    out[2 + magic.length] = 0x20;
    out.set(txHash, 3 + magic.length);
    return out;
}

export interface ByronWitnessCheck {
    items: WitnessItem[];
    /** Per item: the address root the witness must match, and the input it spends. */
    roots: Array<{ root: string; inputRef: string }>;
    /** Per item: witness type (0 PkWitness, 2 RedeemWitness). */
    types: number[];
    problems: string[];
}

/**
 * Byron: witness i spends input i. The witness key must hash to the spent
 * address root under that address's own attributes, and sign the tx id.
 */
export function collectByronWitnesses(
    txHash: Uint8Array,
    witnesses: any[],
    inputs: Array<{ ref: string; address: ByronAddress | null }>,
    protocolMagic: number,
): ByronWitnessCheck {
    const out: ByronWitnessCheck = { items: [], roots: [], types: [], problems: [] };
    if (witnesses.length !== inputs.length) {
        out.problems.push(`${witnesses.length} witnesses for ${inputs.length} inputs`);
        return out;
    }
    for (let i = 0; i < inputs.length; i++) {
        const w = witnesses[i];
        const inp = inputs[i]!;
        const addr = inp.address;
        if (!addr) {
            out.problems.push(`input ${inp.ref}: not a Byron address`);
            continue;
        }
        const pub = w?.pubkey as Uint8Array | undefined;
        const sig = w?.signature as Uint8Array | undefined;
        const type = Number(w?.type);
        if (!pub || !sig) {
            out.problems.push(`input ${inp.ref}: witness type ${type} has no key/signature`);
            continue;
        }
        const attrs = byronAddressAttributesCbor(addr);
        if (type === 0 && addr.type === 0) {
            out.items.push({ publicKey: pub.subarray(0, 32), signature: sig, message: byronSignedMessage(1, protocolMagic, txHash) });
            out.roots.push({ root: byronAddressRoot(0, 0, pub, attrs), inputRef: inp.ref });
            out.types.push(0);
        } else if (type === 2 && addr.type === 2) {
            out.items.push({ publicKey: pub.subarray(0, 32), signature: sig, message: byronSignedMessage(2, protocolMagic, txHash) });
            out.roots.push({ root: byronAddressRoot(2, 2, pub, attrs), inputRef: inp.ref });
            out.types.push(2);
        } else {
            out.problems.push(`input ${inp.ref}: witness type ${type} does not match address type ${addr.type}`);
        }
    }
    return out;
}

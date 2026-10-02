/**
 * Raw scans of Shelley+ blocks for the ledger facts the node-to-client queries report verbatim but the
 * rules never needed in full: pool registration parameters (relays, metadata anchor) and the anchors of
 * NewConstitution proposals. Walks the CBOR without decoding whole blocks, so the whole chain can be
 * scanned at startup (backfill) and single transaction bodies at apply time.
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { cborItemLength } from "../storage/chunkFormat";

interface Head { major: number; value: number; len: number; indefinite: boolean }
function head(b: Uint8Array, p: number): Head {
    const ib = b[p]!, major = ib >> 5, info = ib & 31;
    if (info < 24) return { major, value: info, len: 1, indefinite: false };
    if (info === 24) return { major, value: b[p + 1]!, len: 2, indefinite: false };
    if (info === 25) return { major, value: (b[p + 1]! << 8) | b[p + 2]!, len: 3, indefinite: false };
    if (info === 26) return { major, value: new DataView(b.buffer, b.byteOffset + p + 1, 4).getUint32(0, false), len: 5, indefinite: false };
    if (info === 27) return { major, value: Number(new DataView(b.buffer, b.byteOffset + p + 1, 8).getBigUint64(0, false)), len: 9, indefinite: false };
    if (info === 31) return { major, value: -1, len: 1, indefinite: true };
    throw new Error(`cbor head: unsupported info ${info}`);
}
/** Offsets of the items of the array (or set) at `p`, and the end offset. Accepts tag 258 around it. */
function items(b: Uint8Array, p: number): { starts: number[]; end: number } {
    let h = head(b, p);
    if (h.major === 6) { p += h.len; h = head(b, p); }
    if (h.major !== 4) throw new Error("expected array");
    const starts: number[] = [];
    let q = p + h.len;
    if (h.indefinite) { while (b[q] !== 0xff) { starts.push(q); q += cborItemLength(b, q); } return { starts, end: q + 1 }; }
    for (let i = 0; i < h.value; i++) { starts.push(q); q += cborItemLength(b, q); }
    return { starts, end: q };
}
/** Map entries at `p`: [keyOffset, valueOffset]. */
function entries(b: Uint8Array, p: number): Array<[number, number]> {
    const h = head(b, p);
    if (h.major !== 5) throw new Error("expected map");
    const out: Array<[number, number]> = [];
    let q = p + h.len;
    const n = h.indefinite ? Infinity : h.value;
    for (let i = 0; i < n; i++) {
        if (h.indefinite && b[q] === 0xff) break;
        const k = q; q += cborItemLength(b, q);
        out.push([k, q]); q += cborItemLength(b, q);
    }
    return out;
}
const uintAt = (b: Uint8Array, p: number) => { const h = head(b, p); if (h.major !== 0) throw new Error("expected uint"); return h.value; };
const bytesAt = (b: Uint8Array, p: number) => { const h = head(b, p); if (h.major !== 2 && h.major !== 3) throw new Error("expected bytes/text"); return b.subarray(p + h.len, p + h.len + h.value); };
const slice = (b: Uint8Array, p: number) => b.subarray(p, p + cborItemLength(b, p));
function arrayHead(n: number): Uint8Array { return n < 24 ? Uint8Array.of(0x80 | n) : Uint8Array.of(0x98, n); }
function concat(parts: Uint8Array[]): Uint8Array { let n = 0; for (const x of parts) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of parts) { o.set(x, i); i += x.length; } return o; }
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

export interface PoolRegistration { poolId: string; paramsCbor: Uint8Array }
export interface ConstitutionProposal { actionId: string; url: string; hash: string }

/**
 * A pool registration certificate `[3, operator, vrf, pledge, cost, margin, reward_account, owners,
 * relays, metadata]` → the 9-element PoolParams array cardano-node's Conway queries return: fields
 * verbatim except owners, re-encoded as a sorted CBOR set (tag 258).
 */
function poolParamsOf(b: Uint8Array, cert: number[]): PoolRegistration {
    const owners = items(b, cert[7]!).starts.map((s) => bytesAt(b, s)).map((x) => Uint8Array.from(x)).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    const ownersCbor = concat([Uint8Array.of(0xd9, 0x01, 0x02), arrayHead(owners.length), ...owners.map((o) => concat([Uint8Array.of(0x58, o.length), o]))]);
    const fields = [1, 2, 3, 4, 5, 6].map((i) => slice(b, cert[i]!));
    return { poolId: hex(bytesAt(b, cert[1]!)), paramsCbor: concat([arrayHead(9), ...fields, ownersCbor, slice(b, cert[8]!), slice(b, cert[9]!)]) };
}

/** Scan one transaction body (CBOR bytes of the body map). */
export function scanTxBody(body: Uint8Array): { pools: PoolRegistration[]; constitutions: ConstitutionProposal[] } {
    const pools: PoolRegistration[] = [], constitutions: ConstitutionProposal[] = [];
    let txid: string | null = null;
    for (const [k, v] of entries(body, 0)) {
        const key = uintAt(body, k);
        if (key === 4) {
            for (const c of items(body, v).starts) {
                const f = items(body, c).starts;
                if (f.length === 10 && uintAt(body, f[0]!) === 3) pools.push(poolParamsOf(body, f));
            }
        } else if (key === 20) {
            const props = items(body, v).starts;
            props.forEach((pp, idx) => {
                const f = items(body, pp).starts; // [deposit, reward_account, gov_action, anchor]
                const ga = items(body, f[2]!).starts;
                if (uintAt(body, ga[0]!) !== 5) return;
                const constitution = items(body, ga[2]!).starts; // [anchor, script_hash / null]
                const anchor = items(body, constitution[0]!).starts;
                txid ??= hex(blake2b_256(body));
                constitutions.push({ actionId: `${txid}:${idx}`, url: new TextDecoder().decode(bytesAt(body, anchor[0]!)), hash: hex(bytesAt(body, anchor[1]!)) });
            });
        }
    }
    return { pools, constitutions };
}

/** Scan a stored block (`[eraTag, block]` as in the chunk files). Byron blocks yield nothing. */
export function scanBlock(entry: Uint8Array): { pools: PoolRegistration[]; constitutions: ConstitutionProposal[] } {
    const top = items(entry, 0).starts;
    const era = uintAt(entry, top[0]!);
    if (era < 2) return { pools: [], constitutions: [] };
    const block = items(entry, top[1]!).starts; // [header, tx_bodies, witnesses, aux, (invalid)]
    const pools: PoolRegistration[] = [], constitutions: ConstitutionProposal[] = [];
    const invalid = new Set<number>();
    if (block.length >= 5) for (const s of items(entry, block[4]!).starts) invalid.add(uintAt(entry, s));
    items(entry, block[1]!).starts.forEach((txStart, i) => {
        if (invalid.has(i)) return; // phase-2 invalid transactions apply no certificates
        const body = slice(entry, txStart);
        if (!body.includes(0x04) && !body.includes(0x14)) return;
        const r = scanTxBody(body);
        pools.push(...r.pools); constitutions.push(...r.constitutions);
    });
    return { pools, constitutions };
}

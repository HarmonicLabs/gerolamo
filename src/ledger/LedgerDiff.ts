/**
 * One block's changes to the ledger state (docs/PLAN_LMDB_LEDGER.md §3): per database, the keys it
 * set or deleted with the value they had before (captured on first touch), plus u64 counter
 * deltas (balances, pots, blocks made). Diffs on the selected chain are consulted newest-first
 * before LMDB; `promote` applies them to LMDB and checks each `before` against the stored value.
 */

export type DiffEntry = { before: Uint8Array | undefined; after: Uint8Array | undefined; hadBefore: boolean };

export class LedgerDiff {
    readonly writes = new Map<string, Map<string, DiffEntry>>(); // db → keyHex → entry
    readonly adds = new Map<string, Map<string, bigint>>();      // db → keyHex → delta
    bytes = 0;

    constructor(readonly hash: Uint8Array, readonly prevHash: Uint8Array | null, readonly slot: number) {}

    private table(db: string): Map<string, DiffEntry> {
        let m = this.writes.get(db);
        if (!m) this.writes.set(db, (m = new Map()));
        return m;
    }

    /** Record a set; `before` is what the key held before this block (from older diffs or LMDB). */
    set(db: string, key: Uint8Array, value: Uint8Array, before: Uint8Array | undefined): void {
        const m = this.table(db), k = hex(key);
        const e = m.get(k);
        if (e) { this.bytes += value.length - (e.after?.length ?? 0); e.after = value; return; }
        m.set(k, { before, after: value, hadBefore: before !== undefined });
        this.bytes += value.length + key.length;
    }

    del(db: string, key: Uint8Array, before: Uint8Array | undefined): void {
        const m = this.table(db), k = hex(key);
        const e = m.get(k);
        if (e) { this.bytes -= e.after?.length ?? 0; e.after = undefined; return; }
        m.set(k, { before, after: undefined, hadBefore: before !== undefined });
        this.bytes += key.length;
    }

    /** Look a key up in this diff: `{ value }` (undefined value = deleted here) or null when untouched. */
    lookup(db: string, key: Uint8Array): { value: Uint8Array | undefined } | null {
        const e = this.writes.get(db)?.get(hex(key));
        return e ? { value: e.after } : null;
    }

    /** `lookup` / `addDelta` with the key already in hex (hot read path). */
    lookupHex(db: string, keyHex: string): { value: Uint8Array | undefined } | null {
        const e = this.writes.get(db)?.get(keyHex);
        return e ? { value: e.after } : null;
    }
    addDeltaHex(db: string, keyHex: string): bigint { return this.adds.get(db)?.get(keyHex) ?? 0n; }

    add(db: string, key: Uint8Array, delta: bigint): void {
        let m = this.adds.get(db);
        if (!m) this.adds.set(db, (m = new Map()));
        const k = hex(key);
        m.set(k, (m.get(k) ?? 0n) + delta);
    }

    addDelta(db: string, key: Uint8Array): bigint {
        return this.adds.get(db)?.get(hex(key)) ?? 0n;
    }

    /** Keys touched (set, deleted or added-to) in a database, as hex, for range merging. */
    touchedKeys(db: string): Set<string> {
        const out = new Set<string>(this.writes.get(db)?.keys() ?? []);
        for (const k of this.adds.get(db)?.keys() ?? []) out.add(k);
        return out;
    }

    get size(): number {
        let n = 0;
        for (const m of this.writes.values()) n += m.size;
        for (const m of this.adds.values()) n += m.size;
        return n;
    }
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

/** u64 big-endian encode/decode for counters. */
export function u64(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, false); return b; }
export function readU64(b: Uint8Array | undefined): bigint { return b && b.length >= 8 ? new DataView(b.buffer, b.byteOffset).getBigUint64(0, false) : 0n; }

// ------------------------------------------------------------------ persistence (ledger/diffs/<hash>.diff)

const DIFF_MAGIC = 0x4c444631;    // "LDF1": body only (files written before bug 245)
const DIFF_MAGIC_V2 = 0x4c444632; // "LDF2": body + trailer { u32 bodyLen | u32 crc32(body) }

/**
 * Binary form of a diff so the volatile layer survives a restart:
 *   u32 magic | hash(32) | u8 hasPrev | prevHash(32) | u64 slot
 *   u16 dbCount { u8 nameLen | name | u32 entries { u16 keyLen | key | u8 flags(1=hadBefore,2=hasBefore,4=hasAfter) | [u32 len | before] | [u32 len | after] } }
 *   u16 dbCount { u8 nameLen | name | u32 entries { u16 keyLen | key | i64 delta } }
 *   LDF2: u32 bodyLen | u32 crc32 of everything before it
 * `decodeDiff` is strict: a file cut short by a crash, one whose tail came back as zeros, or one
 * with bytes past the encoded body is rejected (bug 245), so the loader treats it as absent. An
 * LDF1 file (no trailer) still loads when its body is consumed exactly.
 */
export function encodeDiff(d: LedgerDiff): Uint8Array {
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();
    const head = new Uint8Array(4 + 32 + 1 + 32 + 8);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, DIFF_MAGIC_V2, false);
    head.set(d.hash, 4);
    head[36] = d.prevHash ? 1 : 0;
    if (d.prevHash) head.set(d.prevHash, 37);
    hv.setBigUint64(69, BigInt(d.slot), false);
    parts.push(head);
    const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, false); return b; };
    const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
    const i64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, n, false); return b; };
    const name = (s: string) => { const b = enc.encode(s); return [Uint8Array.of(b.length), b]; };
    parts.push(u16(d.writes.size));
    for (const [db, m] of d.writes) {
        parts.push(...name(db), u32(m.size));
        for (const [k, e] of m) {
            const key = unhex(k);
            parts.push(u16(key.length), key, Uint8Array.of((e.hadBefore ? 1 : 0) | (e.before ? 2 : 0) | (e.after ? 4 : 0)));
            if (e.before) parts.push(u32(e.before.length), e.before);
            if (e.after) parts.push(u32(e.after.length), e.after);
        }
    }
    parts.push(u16(d.adds.size));
    for (const [db, m] of d.adds) {
        parts.push(...name(db), u32(m.size));
        for (const [k, delta] of m) { const key = unhex(k); parts.push(u16(key.length), key, i64(delta)); }
    }
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n + 8); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    const tv = new DataView(out.buffer, n, 8);
    tv.setUint32(0, n, false);
    tv.setUint32(4, crc32(out.subarray(0, n)), false);
    return out;
}

export function decodeDiff(b: Uint8Array): LedgerDiff {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 77) throw new Error(`decodeDiff: short header (${b.length} B)`);
    const magic = dv.getUint32(0, false);
    if (magic !== DIFF_MAGIC && magic !== DIFF_MAGIC_V2) throw new Error("decodeDiff: bad magic");
    let end = b.length;
    if (magic === DIFF_MAGIC_V2) {
        if (b.length < 77 + 8) throw new Error("decodeDiff: truncated (no trailer)");
        const bodyLen = dv.getUint32(b.length - 8, false);
        if (bodyLen !== b.length - 8) throw new Error(`decodeDiff: truncated (body ${bodyLen} B, file ${b.length} B)`);
        if (crc32(b.subarray(0, bodyLen)) !== dv.getUint32(b.length - 4, false)) throw new Error("decodeDiff: checksum mismatch");
        end = bodyLen;
    }
    const hash = b.slice(4, 36);
    const prev = b[36] ? b.slice(37, 69) : null;
    const slot = Number(dv.getBigUint64(69, false));
    const d = new LedgerDiff(hash, prev, slot);
    const dec = new TextDecoder();
    let o = 77;
    const need = (n: number) => { if (o + n > end) throw new Error(`decodeDiff: truncated at byte ${o} (${n} needed, ${end - o} left)`); };
    const rd8 = () => { need(1); return b[o++]!; };
    const rd16 = () => { need(2); const v = dv.getUint16(o, false); o += 2; return v; };
    const rd32 = () => { need(4); const v = dv.getUint32(o, false); o += 4; return v; };
    const bytes = (n: number) => { need(n); const v = b.slice(o, o + n); o += n; return v; };
    const nDbs = rd16();
    for (let i = 0; i < nDbs; i++) {
        const db = dec.decode(bytes(rd8()));
        const n = rd32();
        const m = new Map<string, DiffEntry>();
        for (let j = 0; j < n; j++) {
            const key = bytes(rd16());
            const flags = rd8();
            const before = flags & 2 ? bytes(rd32()) : undefined;
            const after = flags & 4 ? bytes(rd32()) : undefined;
            m.set(hex(key), { before, after, hadBefore: (flags & 1) !== 0 });
            d.bytes += key.length + (after?.length ?? 0);
        }
        d.writes.set(db, m);
    }
    const nAdds = rd16();
    for (let i = 0; i < nAdds; i++) {
        const db = dec.decode(bytes(rd8()));
        const n = rd32();
        const m = new Map<string, bigint>();
        for (let j = 0; j < n; j++) { const key = bytes(rd16()); need(8); const delta = dv.getBigInt64(o, false); o += 8; m.set(hex(key), delta); }
        d.adds.set(db, m);
    }
    if (o !== end) throw new Error(`decodeDiff: ${end - o} byte(s) past the encoded body`);
    return d;
}

/** CRC-32 (IEEE), table-driven; diffs are kilobytes, so a plain loop is fine. */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export function crc32(b: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

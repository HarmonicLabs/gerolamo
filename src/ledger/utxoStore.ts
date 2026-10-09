/**
 * UTxO group over the LedgerStore (docs/PLAN_LMDB_LEDGER.md phase 1).
 *
 * Databases:
 *   utxo          key txid(32) ‖ index(u16)        value: record (see `encodeRow` — the same fields
 *                                                  the SQLite `utxo` row carries, tx_out JSON included,
 *                                                  so the rules read exactly what they read today)
 *   utxo_addr     key addr(utf8) ‖ 0x00 ‖ txid ‖ index   → empty   (address lookups)
 *   utxo_rs       key refScriptHash(28) ‖ txid ‖ index    → empty   (reference-script lookups)
 *   stake_bal     key stakeKey(typed hex → bytes)          → u64     (sum of lovelace at the credential's addresses)
 *   utxo_stats    key "count" → u64
 *   utxo_idx      payment / delegation credential and asset → output (see utxoIndex.ts; UTxO RPC searches)
 *
 * A UTxO reference is the string `txid:index` everywhere else in the node; keys are built from it.
 */
import type { LedgerStore, LedgerView } from "./LedgerStore";
import { DB_IDX, indexKeysOf, refKeyOfIndexKey, utxoIndexEnabled } from "./utxoIndex";

export const DB_UTXO = "utxo", DB_ADDR = "utxo_addr", DB_RS = "utxo_rs", DB_STAKE_BAL = "stake_bal", DB_STATS = "utxo_stats";
const COUNT_KEY = new TextEncoder().encode("count");

export interface UtxoRecord {
    utxo_ref: string;
    tx_out: string;            // JSON as stored today
    tx_hash: string | null;
    address: string | null;
    lovelace: string | null;   // decimal
    reference_script_hash: string | null;
    stake_key: string | null;  // typed hex
}

export function refKey(utxoRef: string): Uint8Array {
    const i = utxoRef.indexOf(":");
    const txid = utxoRef.slice(0, i), index = Number(utxoRef.slice(i + 1));
    const out = new Uint8Array(34);
    out.set(Buffer.from(txid, "hex"), 0);
    new DataView(out.buffer).setUint16(32, index, false);
    return out;
}

export function keyRef(key: Uint8Array): string {
    return `${Buffer.from(key.subarray(0, 32)).toString("hex")}:${new DataView(key.buffer, key.byteOffset).getUint16(32, false)}`;
}

const enc = new TextEncoder(), dec = new TextDecoder();
const EMPTY = new Uint8Array(0);

/** Record: u8 flags | u64 lovelace | u16 addrLen | addr | u8 rsLen | rs | u8 skLen | sk | u8 txHashLen | txHash | tx_out JSON. */
export function encodeRow(r: Omit<UtxoRecord, "utxo_ref">): Uint8Array {
    const addr = r.address ? enc.encode(r.address) : new Uint8Array(0);
    const rs = r.reference_script_hash ? Buffer.from(r.reference_script_hash, "hex") : new Uint8Array(0);
    const sk = r.stake_key ? Buffer.from(r.stake_key, "hex") : new Uint8Array(0);
    const th = r.tx_hash ? Buffer.from(r.tx_hash, "hex") : new Uint8Array(0);
    const json = enc.encode(r.tx_out);
    const out = new Uint8Array(1 + 8 + 2 + addr.length + 1 + rs.length + 1 + sk.length + 1 + th.length + json.length);
    const dv = new DataView(out.buffer);
    let o = 0;
    out[o++] = (r.address ? 1 : 0) | (r.lovelace ? 2 : 0) | (r.reference_script_hash ? 4 : 0) | (r.stake_key ? 8 : 0) | (r.tx_hash ? 16 : 0);
    dv.setBigUint64(o, r.lovelace ? BigInt(r.lovelace) : 0n, false); o += 8;
    dv.setUint16(o, addr.length, false); o += 2; out.set(addr, o); o += addr.length;
    out[o++] = rs.length; out.set(rs, o); o += rs.length;
    out[o++] = sk.length; out.set(sk, o); o += sk.length;
    out[o++] = th.length; out.set(th, o); o += th.length;
    out.set(json, o);
    return out;
}

export function decodeRow(utxoRef: string, b: Uint8Array): UtxoRecord {
    const dv = new DataView(b.buffer, b.byteOffset);
    let o = 0;
    const flags = b[o++]!;
    const lovelace = dv.getBigUint64(o, false); o += 8;
    const addrLen = dv.getUint16(o, false); o += 2; const address = addrLen ? dec.decode(b.subarray(o, o + addrLen)) : null; o += addrLen;
    const rsLen = b[o++]!; const rs = rsLen ? Buffer.from(b.subarray(o, o + rsLen)).toString("hex") : null; o += rsLen;
    const skLen = b[o++]!; const sk = skLen ? Buffer.from(b.subarray(o, o + skLen)).toString("hex") : null; o += skLen;
    const thLen = b[o++]!; const th = thLen ? Buffer.from(b.subarray(o, o + thLen)).toString("hex") : null; o += thLen;
    return { utxo_ref: utxoRef, tx_out: dec.decode(b.subarray(o)), tx_hash: flags & 16 ? th : null, address: flags & 1 ? address : null, lovelace: flags & 2 ? lovelace.toString() : null, reference_script_hash: flags & 4 ? rs : null, stake_key: flags & 8 ? sk : null };
}

function addrKey(address: string, key: Uint8Array): Uint8Array {
    const a = enc.encode(address);
    const out = new Uint8Array(a.length + 1 + key.length);
    out.set(a, 0); out[a.length] = 0; out.set(key, a.length + 1);
    return out;
}
function rsKey(rsHex: string, key: Uint8Array): Uint8Array {
    const h = Buffer.from(rsHex, "hex");
    const out = new Uint8Array(h.length + key.length);
    out.set(h, 0); out.set(key, h.length);
    return out;
}

/** Writes: inside an open block of the store. */
export class UtxoWrites {
    constructor(private readonly store: LedgerStore) {}

    put(r: UtxoRecord): void {
        const key = refKey(r.utxo_ref);
        const before = this.store.get(DB_UTXO, key);
        if (before) this.removeIndexes(key, decodeRow(r.utxo_ref, before)); // replaced row (idempotent re-apply)
        this.store.put(DB_UTXO, key, encodeRow(r));
        if (r.address) this.store.put(DB_ADDR, addrKey(r.address, key), new Uint8Array(0));
        if (r.reference_script_hash) this.store.put(DB_RS, rsKey(r.reference_script_hash, key), new Uint8Array(0));
        if (r.stake_key && r.lovelace) this.store.addU64(DB_STAKE_BAL, Buffer.from(r.stake_key, "hex"), BigInt(r.lovelace));
        if (utxoIndexEnabled()) for (const ik of indexKeysOf(r, key)) this.store.put(DB_IDX, ik, EMPTY);
        if (!before) this.store.addU64(DB_STATS, COUNT_KEY, 1n);
    }

    /** Delete spent outputs; returns the refs that existed (and their records). */
    del(refs: string[]): UtxoRecord[] {
        const out: UtxoRecord[] = [];
        for (const ref of refs) {
            const key = refKey(ref);
            const raw = this.store.get(DB_UTXO, key);
            if (!raw) continue;
            const r = decodeRow(ref, raw);
            this.removeIndexes(key, r);
            this.store.del(DB_UTXO, key);
            this.store.addU64(DB_STATS, COUNT_KEY, -1n);
            out.push(r);
        }
        return out;
    }

    private removeIndexes(key: Uint8Array, r: UtxoRecord): void {
        if (r.address) this.store.del(DB_ADDR, addrKey(r.address, key));
        if (r.reference_script_hash) this.store.del(DB_RS, rsKey(r.reference_script_hash, key));
        if (r.stake_key && r.lovelace) this.store.addU64(DB_STAKE_BAL, Buffer.from(r.stake_key, "hex"), -BigInt(r.lovelace));
        if (utxoIndexEnabled()) for (const ik of indexKeysOf(r, key)) this.store.del(DB_IDX, ik);
    }
}

/** Reads over the store or a frozen view. */
export class UtxoReads {
    constructor(private readonly s: LedgerStore | LedgerView) {}

    get(utxoRef: string): UtxoRecord | null {
        const raw = this.s.get(DB_UTXO, refKey(utxoRef));
        return raw ? decodeRow(utxoRef, raw) : null;
    }

    getMany(refs: string[]): UtxoRecord[] {
        const out: UtxoRecord[] = [];
        for (const ref of refs) { const r = this.get(ref); if (r) out.push(r); }
        return out;
    }

    has(utxoRef: string): boolean { return this.s.get(DB_UTXO, refKey(utxoRef)) !== undefined; }

    byTxHash(txHashHex: string): UtxoRecord[] {
        const out: UtxoRecord[] = [];
        for (const [k, v] of this.s.range(DB_UTXO, Uint8Array.from(Buffer.from(txHashHex, "hex")))) out.push(decodeRow(keyRef(k), v));
        return out.sort((a, b) => Number(a.utxo_ref.split(":")[1]) - Number(b.utxo_ref.split(":")[1]));
    }

    byAddress(address: string, limit?: number): UtxoRecord[] {
        const prefix = new Uint8Array(enc.encode(address).length + 1); prefix.set(enc.encode(address)); prefix[prefix.length - 1] = 0;
        const out: UtxoRecord[] = [];
        for (const [k] of this.s.range(DB_ADDR, prefix, { limit })) {
            const ref = keyRef(k.subarray(prefix.length));
            const r = this.get(ref);
            if (r) out.push(r);
        }
        return out;
    }

    /** Output keys (txid ‖ index) at an exact address, ascending. */
    addressRefKeys(address: string, limit?: number): Uint8Array[] {
        const a = enc.encode(address);
        const prefix = new Uint8Array(a.length + 1); prefix.set(a);
        const out: Uint8Array[] = [];
        for (const [k] of this.s.range(DB_ADDR, prefix, { limit })) out.push(k.subarray(prefix.length));
        return out;
    }

    /** Output keys under a `utxo_idx` prefix (payment / delegation credential, policy or asset; see utxoIndex.ts). */
    indexRefKeys(prefix: Uint8Array, limit?: number): Uint8Array[] {
        const out: Uint8Array[] = [];
        for (const [k] of this.s.range(DB_IDX, prefix, { limit })) out.push(refKeyOfIndexKey(k));
        return out;
    }

    /** One output by key (txid ‖ index). */
    getByKey(key: Uint8Array): UtxoRecord | null {
        const raw = this.s.get(DB_UTXO, key);
        return raw ? decodeRow(keyRef(key), raw) : null;
    }

    refsWithReferenceScript(refs: string[]): number {
        let n = 0;
        for (const ref of refs) { const r = this.get(ref); if (r?.reference_script_hash) n++; }
        return n;
    }

    byReferenceScript(rsHex: string): UtxoRecord[] {
        const out: UtxoRecord[] = [];
        for (const [k] of this.s.range(DB_RS, Uint8Array.from(Buffer.from(rsHex, "hex")))) { const r = this.get(keyRef(k.subarray(28))); if (r) out.push(r); }
        return out;
    }

    count(): number { return Number(this.s.getU64(DB_STATS, COUNT_KEY)); }

    /** Sum of every output's lovelace (full scan; the first Shelley boundary's reserves). */
    totalLovelace(): bigint { let t = 0n; for (const [, v] of this.s.range(DB_UTXO, new Uint8Array(0))) t += new DataView(v.buffer, v.byteOffset).getBigUint64(1, false); return t; }

    stakeBalance(stakeKeyHex: string): bigint { return this.s.getU64(DB_STAKE_BAL, Buffer.from(stakeKeyHex, "hex")); }
}

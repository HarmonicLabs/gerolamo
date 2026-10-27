/**
 * Secondary UTxO indexes for UTxO RPC `SearchUtxos` (docs/parity/utxorpc.md, item 482), one LMDB
 * database `utxo_idx` with a kind byte per index; the values are empty:
 *
 *   0x01 ‖ payment credential hash (28) ‖ txid (32) ‖ index (u16)          Shelley addresses
 *   0x02 ‖ delegation credential hash (28) ‖ txid ‖ index                 base addresses (types 0–3)
 *   0x03 ‖ policy id (28) ‖ name length (u8) ‖ asset name ‖ txid ‖ index   every native asset held
 *   0x04 ‖ datum hash (32) ‖ txid ‖ index                              outputs with a datum (inline: its hash)
 *   0x00 ‖ "v1"                                                         backfill marker
 *
 * `UtxoWrites` keeps them with every put / delete (same block diff, so a rollback undoes them).
 * `backfillUtxoIndex` builds them once for a store written before they existed. A hit is always
 * resolved through the `utxo` database, so an index entry whose output is gone reads as nothing.
 */
import { settings } from "../config/settings";
import { blake2b_256 } from "@harmoniclabs/crypto";
import type { LedgerStore } from "./LedgerStore";

export const DB_IDX = "utxo_idx";

/**
 * --no-utxo-index (config utxoIndex: false) stops maintaining the indexes (a safety valve; about 12 µs per output with
 * an asset, measured in item 482). The marker is then cleared at open, so turning them back on
 * rebuilds what is missing; keys of outputs spent meanwhile stay behind and read as nothing.
 */
let indexOverride: boolean | null = null;
export function utxoIndexEnabled(): boolean { return indexOverride ?? settings().utxoIndex; }
export function setUtxoIndexEnabled(on: boolean): void { indexOverride = on; }
export const IDX_PAYMENT = 1, IDX_DELEGATION = 2, IDX_ASSET = 3, IDX_DATUM = 4;
export const IDX_MARKER = Uint8Array.of(0, 0x76, 0x31); // 0x00 "v1"

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Raw bytes of a Shelley bech32 address (`addr…` / `addr_test…`); null for Byron (base58) or anything else. */
export function shelleyAddressBytes(address: string): Uint8Array | null {
    if (!address.startsWith("addr")) return null;
    const i = address.lastIndexOf("1");
    if (i <= 0 || address.length < i + 7) return null;
    let acc = 0, bits = 0;
    const out: number[] = [];
    for (const c of address.slice(i + 1, -6)) {
        const v = BECH32.indexOf(c);
        if (v < 0) return null;
        acc = ((acc << 5) | v) & 0xffffff;
        bits += 5;
        while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    return Uint8Array.from(out);
}

/** Payment and delegation credential hashes of Shelley address bytes (header types 0–7). */
export function addressParts(raw: Uint8Array | null): { payment: Uint8Array | null; delegation: Uint8Array | null } {
    if (!raw || raw.length < 29) return { payment: null, delegation: null };
    const type = raw[0]! >> 4;
    if (type > 7) return { payment: null, delegation: null };
    const payment = raw.subarray(1, 29);
    const delegation = type <= 3 && raw.length >= 57 ? raw.subarray(29, 57) : null;
    return { payment, delegation };
}

interface TxOutFacts { assets: Array<[string, string]>; datumHash: string | null; inlineDatum: string | null }

/** Assets (`[policy, name]` hex) and datum of a stored `tx_out` JSON, parsed only when it holds either. */
export function txOutFacts(txOut: string): TxOutFacts {
    const out: TxOutFacts = { assets: [], datumHash: null, inlineDatum: null };
    const at = txOut.indexOf('"assets":{');
    const hasAssets = at >= 0 && txOut[at + 10] !== "}";
    const hasDatum = txOut.includes('"inline_datum":"') || txOut.includes('"datum_hash":"');
    if (!hasAssets && !hasDatum) return out;
    let json: any;
    try { json = JSON.parse(txOut); } catch { return out; }
    for (const [policy, names] of Object.entries((json?.assets ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!/^[0-9a-f]{56}$/i.test(policy) || !names || typeof names !== "object") continue;
        for (const [name, q] of Object.entries(names)) if (/^[0-9a-f]*$/i.test(name) && name.length <= 64 && String(q) !== "0") out.assets.push([policy.toLowerCase(), name.toLowerCase()]);
    }
    if (typeof json?.inline_datum === "string" && /^[0-9a-f]+$/i.test(json.inline_datum)) out.inlineDatum = json.inline_datum.toLowerCase();
    else if (typeof json?.datum_hash === "string" && /^[0-9a-f]{64}$/i.test(json.datum_hash)) out.datumHash = json.datum_hash.toLowerCase();
    return out;
}

/** `[policy, name]` pairs of a stored `tx_out` JSON. */
export function assetsOfTxOut(txOut: string): Array<[string, string]> { return txOutFacts(txOut).assets; }

const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export function datumPrefix(hash: Uint8Array): Uint8Array { return cat(Uint8Array.of(IDX_DATUM), hash); }
export function credPrefix(kind: typeof IDX_PAYMENT | typeof IDX_DELEGATION, hash: Uint8Array): Uint8Array { return cat(Uint8Array.of(kind), hash); }
/** Prefix of a policy's assets, or of one asset when `nameHex` is given. */
export function assetPrefix(policy: Uint8Array, name?: Uint8Array): Uint8Array {
    return name ? cat(Uint8Array.of(IDX_ASSET), policy, Uint8Array.of(name.length), name) : cat(Uint8Array.of(IDX_ASSET), policy);
}

/** Every index key of one output (`refKey` = txid ‖ index). */
export function indexKeysOf(r: { address: string | null; tx_out: string }, refKey: Uint8Array): Uint8Array[] {
    const keys: Uint8Array[] = [];
    const { payment, delegation } = addressParts(r.address ? shelleyAddressBytes(r.address) : null);
    if (payment) keys.push(cat(credPrefix(IDX_PAYMENT, payment), refKey));
    if (delegation) keys.push(cat(credPrefix(IDX_DELEGATION, delegation), refKey));
    const facts = txOutFacts(r.tx_out);
    for (const [policy, name] of facts.assets) keys.push(cat(assetPrefix(hexBytes(policy), hexBytes(name)), refKey));
    const datumHash = facts.inlineDatum ? blake2b_256(hexBytes(facts.inlineDatum)) : facts.datumHash ? hexBytes(facts.datumHash) : null;
    if (datumHash) keys.push(cat(datumPrefix(datumHash), refKey));
    return keys;
}

/** The output reference (last 34 bytes) of an index key. */
export function refKeyOfIndexKey(k: Uint8Array): Uint8Array { return k.subarray(k.length - 34); }

/** A store whose every output went through `UtxoWrites` (an import into an empty store): its indexes are complete. */
export function markUtxoIndexBuilt(st: LedgerStore): void {
    if (utxoIndexEnabled()) st.env.writeSync((t) => t.put(DB_IDX, IDX_MARKER, new Uint8Array(0)));
}

/**
 * Build the indexes of a store written before they existed (once; the marker records it). The
 * LMDB state is scanned in batches and the keys go straight into LMDB; so do the keys of outputs
 * created in the volatile blocks above it (a rollback of those leaves dangling keys, which read as
 * nothing). Runs before the node applies blocks. Returns the outputs indexed, or null when done before.
 */
export function backfillUtxoIndex(st: LedgerStore, decode: (ref: Uint8Array, v: Uint8Array) => { address: string | null; tx_out: string }, opts: { batch?: number; log?: (msg: string) => void } = {}): number | null {
    const marked = st.env.read((t) => t.get(DB_IDX, IDX_MARKER)) !== undefined;
    if (!utxoIndexEnabled()) { if (marked) st.env.writeSync((t) => { t.del(DB_IDX, IDX_MARKER); }); return null; }
    if (marked) return null;
    const batch = opts.batch ?? 20_000;
    const t0 = Date.now();
    let from: Uint8Array | undefined, n = 0;
    for (;;) {
        const rows: Array<[Uint8Array, Uint8Array]> = [];
        st.env.read((t) => { for (const [k, v] of t.range("utxo", { from, limit: batch + 1 })) rows.push([k, v]); });
        if (from && rows.length && Buffer.compare(Buffer.from(rows[0]![0]), Buffer.from(from)) === 0) rows.shift(); // `from` is inclusive
        if (!rows.length) break;
        const keys: Uint8Array[] = [];
        for (const [k, v] of rows) for (const ik of indexKeysOf(decode(k, v), k)) keys.push(ik);
        if (keys.length) st.env.writeSync((t) => { for (const ik of keys) t.put(DB_IDX, ik, new Uint8Array(0)); });
        n += rows.length;
        from = rows[rows.length - 1]![0];
        if (opts.log && n % (batch * 25) === 0) opts.log(`UTxO index backfill: ${n} outputs`);
    }
    const volatileKeys: Uint8Array[] = [];
    for (const [k, v] of st.volatileEntries("utxo")) if (v) { n++; for (const ik of indexKeysOf(decode(k, v), k)) volatileKeys.push(ik); }
    st.env.writeSync((t) => { for (const ik of volatileKeys) t.put(DB_IDX, ik, new Uint8Array(0)); t.put(DB_IDX, IDX_MARKER, new Uint8Array(0)); });
    opts.log?.(`UTxO index backfill: ${n} outputs indexed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return n;
}

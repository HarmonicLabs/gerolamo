#!/usr/bin/env bun
/**
 * Find (and with --yes remove) the UTxO entries an LMDB ledger store holds that the reference
 * cardano-node's UTxO does not, and the entries whose lovelace differs from it (bugs 350–353).
 *
 *   bun scripts/store-repair-phantoms.ts <ledgerDir> --socket <relay node.socket> --magic 2 [--dry-run]
 *       [--refs txid#ix,…] [--batch 2000] [--json out.json]
 *   bun scripts/store-repair-phantoms.ts <ledgerDir> --socket … --magic 2 --yes     (the node STOPPED)
 *
 * Every key of the store's `utxo` (or only `--refs`) is looked up on the relay with
 * GetUTxOByTxIn, the relay acquired at the very block the store is pinned to (its newest held
 * block), so a spend between the two tips cannot pass for a phantom. Reported:
 *   phantom   in the store, not in the relay's UTxO (the Byron genesis output re-seeded on a snapshot
 *             import, bug 350; outputs created and spent inside a rolled-back block, bug 351);
 *   lovelace  the row's lovelace column or its tx_out `amount` differs from the relay's coin (a
 *             SQLite INTEGER read through a JS number above 2^53, bug 352).
 * Dry run (default): the store is opened READ-ONLY (safe beside the running node); nothing changes.
 * --yes: refuses while any process holds the store's data.mdb open; deletes the phantoms through
 * UtxoWrites.del (utxo, utxo_addr, utxo_rs, stake_bal, utxo_stats in one LMDB transaction) and
 * rewrites the lovelace rows from the relay's coin. Only keys no volatile diff touches are written
 * directly (a diff's before-image would no longer match at promotion); others are reported.
 * Exit 0 when the store matches the relay, 1 when entries were found (dry run) or left, 2 on error.
 */
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { LedgerStore } from "../src/ledger/LedgerStore";
import { DB_UTXO, UtxoWrites, decodeRow, keyRef, refKey } from "../src/ledger/utxoStore";
import { pin, type Pinned } from "../src/ledger/storeCompare";
import { openLsq } from "./lib/lsq";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const socket = opt("socket"), magic = Number(opt("magic") ?? 2), batch = Number(opt("batch") ?? 2000);
const yes = argv.includes("--yes");
if (!dir || !socket) { console.error("usage: bun scripts/store-repair-phantoms.ts <ledgerDir> --socket <node.socket> [--magic 2] [--dry-run | --yes] [--refs txid#ix,…] [--batch 2000] [--json out.json]"); process.exit(2); }
const onlyRefs = opt("refs")?.split(",").filter(Boolean).map((r) => r.replace("#", ":").toLowerCase());

/** Processes (other than this one) holding `<dir>/data.mdb` open. */
function holders(ledgerDir: string): number[] {
    const target = realpathSync(join(ledgerDir, "data.mdb"));
    const out: number[] = [];
    for (const p of readdirSync("/proc")) {
        if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
        let fds: string[] = [];
        try { fds = readdirSync(`/proc/${p}/fd`); } catch { continue; }
        for (const fd of fds) { try { if (readlinkSync(`/proc/${p}/fd/${fd}`) === target) { out.push(Number(p)); break; } } catch { /* gone */ } }
    }
    return out;
}

// ── minimal CBOR walking over the relay's answer (a map of up to `batch` outputs; no object tree) ──
function head(b: Uint8Array, o: number): { mt: number; n: bigint; p: number; indef: boolean } {
    const ib = b[o]!, mt = ib >> 5, ai = ib & 31;
    let p = o + 1, n = 0n;
    if (ai < 24) n = BigInt(ai);
    else if (ai <= 27) { const w = 1 << (ai - 24); for (let i = 0; i < w; i++) n = (n << 8n) | BigInt(b[p + i]!); p += w; }
    else if (ai === 31) return { mt, n: -1n, p, indef: true };
    return { mt, n, p, indef: false };
}
function skip(b: Uint8Array, o: number): number {
    const h = head(b, o);
    if (h.mt === 6) return skip(b, h.p);
    if (h.indef) { let p = h.p; while (b[p] !== 0xff) p = skip(b, p); return p + 1; }
    if (h.mt === 2 || h.mt === 3) return h.p + Number(h.n);
    if (h.mt === 4) { let p = h.p; for (let i = 0n; i < h.n; i++) p = skip(b, p); return p; }
    if (h.mt === 5) { let p = h.p; for (let i = 0n; i < 2n * h.n; i++) p = skip(b, p); return p; }
    return h.p;
}
/** Coin of a Value: `coin` or `[coin, multiasset]`. */
function coinOf(b: Uint8Array, o: number): bigint { const h = head(b, o); return h.mt === 4 ? head(b, h.p).n : h.n; }
/** Coin of a TxOut: legacy `[addr, value, …]` or post-Alonzo `{0: addr, 1: value, …}`. */
function txOutCoin(b: Uint8Array, o: number): bigint {
    const h = head(b, o);
    if (h.mt === 4) return coinOf(b, skip(b, h.p));
    let p = h.p;
    for (let i = 0n; h.indef ? b[p] !== 0xff : i < h.n; i++) { const k = head(b, p); const v = skip(b, p); if (k.n === 1n) return coinOf(b, v); p = skip(b, v); }
    throw new Error("TxOut without a value");
}
/** `{ "txid:ix" → coin }` of a GetUTxOByTxIn answer (`[utxoMap]` — the HFC "current era" wrapper). */
function parseUtxoAnswer(b: Uint8Array): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const wrap = head(b, 0);
    if (wrap.mt !== 4 || wrap.n !== 1n) throw new Error(`era mismatch or unexpected answer ${Buffer.from(b.subarray(0, 24)).toString("hex")}`);
    const m = head(b, wrap.p);
    let p = m.p;
    for (let i = 0n; m.indef ? b[p] !== 0xff : i < m.n; i++) {
        const k = head(b, p); // [txid, ix]
        const id = head(b, k.p); const idBytes = b.subarray(id.p, id.p + Number(id.n));
        const ix = head(b, id.p + Number(id.n));
        const v = skip(b, p);
        out.set(`${Buffer.from(idBytes).toString("hex")}:${ix.n}`, txOutCoin(b, v));
        p = skip(b, v);
    }
    return out;
}

const t0 = performance.now();
if (yes) { const h = holders(dir); if (h.length) { console.error(`--yes: the store is open in process(es) ${h.join(", ")}; stop the node first`); process.exit(2); } }
let pinned: Pinned | null = null;
for (let attempt = 0; attempt < 10 && !pinned; attempt++) {
    const st0 = LedgerStore.open(dir, { readOnly: !yes });
    const held = st0.heldBlocks();
    const tip = held[held.length - 1];
    if (!tip) { console.error(`store ${dir} holds no block`); process.exit(2); }
    try { pinned = pin("store", dir, st0, tip.hash); } catch (err) { st0.close(); if ((err as Error).message !== "moved") throw err; }
}
if (!pinned) { console.error("could not pin the store (the node kept promoting); try again"); process.exit(2); }
const view = pinned.view.withTxn(pinned.txn);
console.log(`store ${dir}: pinned at block ${pinned.at.hash} slot ${pinned.at.slot} (anchor ${pinned.anchorSlot}, ${pinned.depth} volatile)`);

const lsq = await openLsq(socket, magic, { acquire: false, timeoutMs: 300_000 });
const acq = await lsq.acquire({ slot: pinned.at.slot, hash: pinned.at.hash });
if (!acq.ok) { console.error(`the relay cannot acquire the store's block (slot ${pinned.at.slot}): ${acq.failure} — the stores are on different chains or the block left the relay's volatile window; rerun`); lsq.close(); pinned.close(); process.exit(2); }

interface Ours { ref: string; lovelace: string | null; amount: string | null; address: string | null; stakeKey: string | null; volatile: boolean }
const phantoms: Ours[] = [], coinDiffs: Array<Ours & { relay: string }> = [];
let checked = 0;
const touchedByDiff = (key: Uint8Array) => { const below = pinned!.txn.get(DB_UTXO, key); const at = view.get(DB_UTXO, key); return (below === undefined) !== (at === undefined) || (below !== undefined && at !== undefined && Buffer.compare(Buffer.from(below), Buffer.from(at)) !== 0); };
async function check(rows: Array<[Uint8Array, Uint8Array]>): Promise<void> {
    if (!rows.length) return;
    const ins = rows.map(([k]) => new CborArray([new CborBytes(k.subarray(0, 32)), new CborUInt(new DataView(k.buffer, k.byteOffset + 32).getUint16(0, false))]));
    const q = new CborArray([new CborUInt(0), new CborArray([new CborUInt(0), new CborArray([new CborUInt(6), new CborArray([new CborUInt(15), new CborTag(258, new CborArray(ins))])])])]);
    const relay = parseUtxoAnswer(await lsq.queryRaw(q));
    for (const [k, v] of rows) {
        checked++;
        const ref = keyRef(k);
        const r = decodeRow(ref, v);
        let amount: string | null = null;
        try { amount = String(JSON.parse(r.tx_out).amount ?? null); } catch { /* malformed row: reported through the coin check */ }
        const o: Ours = { ref, lovelace: r.lovelace, amount, address: r.address, stakeKey: r.stake_key, volatile: touchedByDiff(k) };
        const coin = relay.get(ref);
        if (coin === undefined) phantoms.push(o);
        else if (r.lovelace !== coin.toString() || amount !== coin.toString()) coinDiffs.push({ ...o, relay: coin.toString() });
    }
}
let pending: Array<[Uint8Array, Uint8Array]> = [];
if (onlyRefs) {
    for (const ref of onlyRefs) { const k = refKey(ref); const v = view.get(DB_UTXO, k); if (v) pending.push([k, v]); else console.log(`  ${ref}: not in the store`); }
    await check(pending);
} else {
    for (const [k, v] of view.scan(DB_UTXO)) {
        pending.push([k, v]);
        if (pending.length >= batch) { await check(pending); pending = []; if (checked % 200_000 < batch) console.log(`  ${checked} outputs checked, ${phantoms.length} phantom(s), ${coinDiffs.length} lovelace difference(s), ${((performance.now() - t0) / 1000).toFixed(0)} s`); }
    }
    await check(pending);
}
lsq.close();
const ada = (s: string | null) => (s == null ? "?" : s);
console.log(`checked ${checked} output(s) against the relay at slot ${pinned.at.slot}: ${phantoms.length} phantom(s), ${coinDiffs.length} lovelace difference(s)`);
for (const p of phantoms) console.log(`  phantom  ${p.ref.replace(":", "#")}  ${ada(p.lovelace)} lovelace @ ${p.address}${p.stakeKey ? ` (stake ${p.stakeKey})` : ""}${p.volatile ? "  [touched by a volatile diff]" : ""}`);
for (const c of coinDiffs) console.log(`  lovelace ${c.ref.replace(":", "#")}  column ${c.lovelace}, tx_out amount ${c.amount}, relay ${c.relay} @ ${c.address}${c.volatile ? "  [touched by a volatile diff]" : ""}`);
const out = opt("json");
if (out) await Bun.write(out, JSON.stringify({ store: dir, at: pinned.at, checked, phantoms, coinDiffs }, null, 1));

if (!yes) { pinned.close(); console.log(`dry run (read-only): nothing changed; ${((performance.now() - t0) / 1000).toFixed(0)} s`); process.exit(phantoms.length + coinDiffs.length ? 1 : 0); }

// ── --yes: the node is stopped; write the base state directly (keys no volatile diff touches) ──
const st = pinned.store;
pinned.txn.abort();
const del = phantoms.filter((p) => !p.volatile), fix = coinDiffs.filter((c) => !c.volatile);
const w = new UtxoWrites(st);
await st.applyDirect(() => {
    w.del(del.map((p) => p.ref));
    for (const c of fix) {
        const raw = st.env.read((t) => t.get(DB_UTXO, refKey(c.ref)));
        if (!raw) continue;
        const r = decodeRow(c.ref, raw);
        const j = JSON.parse(r.tx_out);
        j.amount = c.relay;
        if (j.assets && j.assets[""]?.[""] !== undefined) j.assets[""][""] = c.relay; // the lovelace entry of the applier's value map
        w.put({ ...r, tx_out: JSON.stringify(j), lovelace: c.relay }); // put re-indexes: the stake balance moves by the difference
    }
});
st.close();
const left = phantoms.length - del.length + coinDiffs.length - fix.length;
console.log(`--yes: ${del.length} phantom(s) deleted, ${fix.length} lovelace row(s) rewritten${left ? `; ${left} entr(y/ies) touched by volatile diffs left — rerun once they are promoted` : ""}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
process.exit(left ? 1 : 0);

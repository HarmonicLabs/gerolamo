#!/usr/bin/env bun
/**
 * Recompute an epoch's stored nonce record from the node's own data (bug 341) and, with --yes,
 * write it back. The node must be STOPPED for --yes; the dry run is read-only and safe beside it.
 *
 * From the ledger store (pinned at its newest block, read-only): η0 of E − 1, the evolver state at
 * the start of E − 1 (start ηv / ηc, and the snapshot point / ηh when the state was imported). From
 * the block store (selected chain, read-only): every block from the start of E − 1 to the tip,
 * replayed through the same NonceEvolver the node runs (protocol version per epoch from the stored
 * epoch parameters, so Conway's 4k/f window). Prints stored vs recomputed vs Koios for:
 *   η0(E − 1) (the replay's input), η0(E), the start state of E (ηv, ηc after TICKN), and the
 *   running ηv / ηc of E at the tip (what the per-range snapshot stores).
 *
 *   bun scripts/nonce-repair.ts <nodeDir> --epoch 1328 [--network preview] [--yes]
 *
 * <nodeDir> holds ledger/ (LMDB) and db/ (chunk block store). --yes refuses while a process still
 * references <nodeDir>, and writes only the record of E (η0, source "local", ηv / ηc at the tip,
 * start ηv / ηc), keeping its start slot / ηh fields.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toHex, fromHex } from "@harmoniclabs/uint8array-utils";
import { LedgerStore } from "../src/ledger/LedgerStore";
import { GovReads, GovWrites, type NonceRow } from "../src/ledger/govStore";
import { pin, type Pinned } from "../src/ledger/storeCompare";
import { BlockStore } from "../src/storage/blockStore";
import { selectedChain, setSelectedTipHash } from "../src/storage/blockReads";
import { setEpochNetwork, firstSlotOfEpoch, epochForSlot } from "../src/utils/epochFromSlotCalculations";
import { NonceEvolver, type TicknResult } from "../src/utils/nonceEvolver";
import { nonceFactsOf } from "../src/utils/nonceReplay";
import { prevHashToNonce } from "../src/utils/calcEpochNonce";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const nodeDir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const E = Number(opt("epoch"));
if (!nodeDir || !Number.isInteger(E) || E < 2) { console.error("usage: bun scripts/nonce-repair.ts <nodeDir> --epoch E [--network preview] [--yes]"); process.exit(2); }
const net = opt("network") ?? "preview";
const write = argv.includes("--yes");
setEpochNetwork(net);
const dir = resolve(nodeDir);
const ledgerDir = join(dir, "ledger"), blockDir = join(dir, "db");
const genesis = JSON.parse(readFileSync(join(import.meta.dir, "..", "src", "config", net, "shelley-genesis.json"), "utf8"));
const k = Number(genesis.securityParam ?? 2160);

/** Pids (other than ours) whose command line or environment names the node directory. */
function processesUsing(path: string): number[] {
    const out: number[] = [];
    for (const p of readdirSync("/proc")) {
        if (!/^\d+$/.test(p) || Number(p) === process.pid || Number(p) === process.ppid) continue;
        for (const f of ["cmdline", "environ"]) {
            try { if (readFileSync(`/proc/${p}/${f}`).includes(path)) { out.push(Number(p)); break; } } catch { /* gone / not ours */ }
        }
    }
    return out;
}
if (write) {
    const pids = processesUsing(dir);
    if (pids.length) { console.error(`refusing --yes: process(es) ${pids.join(", ")} still reference ${dir}; stop the node (and its supervisor) first`); process.exit(2); }
}

// ── ledger store, read-only, pinned at its newest block ──
let pinned: Pinned | null = null;
for (let attempt = 0; attempt < 10 && !pinned; attempt++) {
    const st0 = LedgerStore.open(ledgerDir, { readOnly: true });
    const tip = st0.heldBlocks().at(-1);
    if (!tip) { console.error(`ledger ${ledgerDir} holds no block`); process.exit(2); }
    try { pinned = pin("ledger", ledgerDir, st0, tip.hash); } catch (err) { st0.close(); if ((err as Error).message !== "moved") throw err; }
}
if (!pinned) { console.error("could not pin the ledger store (the node kept promoting); try again"); process.exit(2); }
const g = new GovReads(pinned.view.withTxn(pinned.txn));
const prevRow = g.nonce(E - 1), row = g.nonce(E);
const protocolMajor = (e: number): number | null => { const p = g.epochParams(e)?.params?.protocol_major_ver; return p == null ? null : Number(p); };
const majors = new Map<number, number | null>();
for (let e = E - 2; e <= E + 1; e++) majors.set(e, protocolMajor(e));
console.log(`ledger ${ledgerDir}: read at block ${pinned.at.hash.slice(0, 16)}… slot ${pinned.at.slot} (anchor ${pinned.anchorSlot ?? "origin"}, ${pinned.depth} volatile)`);
pinned.close();
if (!prevRow?.nonceHex || prevRow.startEvolvingHex == null || prevRow.startCandidateHex == null) { console.error(`epoch ${E - 1}: no stored η0 / start state (${JSON.stringify(prevRow)}); cannot replay`); process.exit(2); }

// ── block store, read-only: the selected chain from the start of E − 1 to the tip ──
const bs = await BlockStore.open(blockDir, { k, readOnly: true });
try { const h = readFileSync(join(blockDir, "gerolamo", "selected-tip.hex"), "utf8").trim(); if (/^[0-9a-f]{64}$/i.test(h)) setSelectedTipHash(fromHex(h)); } catch { /* volatile top */ }
const firstPrev = Number(firstSlotOfEpoch(E - 1)), firstE = Number(firstSlotOfEpoch(E));
const fromSlot = prevRow.startSlot != null ? prevRow.startSlot + 1 : firstPrev;
let etaHHex = prevRow.startSlot != null ? prevRow.startLabHex : null;
if (prevRow.startSlot == null) {
    // ηh carried into E − 1: the previous hash of the last block of E − 2 (the node's bootstrap rule).
    let last: { slot: number; prev: Uint8Array | null } | null = null;
    for await (const b of selectedChain(bs, Number(firstSlotOfEpoch(E - 2)), firstPrev - 1)) { const f = nonceFactsOf({ slot: b.slot, block_data: b.bytes }); if (f) last = { slot: Number(f.slot), prev: f.prevHash }; }
    if (!last) { console.error(`no stored block in epoch ${E - 2}: cannot derive ηh`); process.exit(2); }
    etaHHex = last.prev ? toHex(prevHashToNonce(last.prev)) : null;
    console.log(`ηh into ${E - 1}: from the block at slot ${last.slot} → ${etaHHex}`);
}
const ev = new NonceEvolver(genesis);
for (const [e, m] of majors) ev.setProtocolMajor(e, m);
ev.bootstrap(E - 1, prevRow.nonceHex, { etaVHex: prevRow.startEvolvingHex, etaCHex: prevRow.startCandidateHex, etaHHex });
const ticks: TicknResult[] = [];
let n = 0, nE = 0, tipSlot = -1;
for await (const b of selectedChain(bs, fromSlot, Number.MAX_SAFE_INTEGER)) {
    const f = nonceFactsOf({ slot: b.slot, block_data: b.bytes });
    if (!f) continue;
    if (Number(epochForSlot(f.slot)) > E) break; // the record of E is all we rebuild
    ticks.push(...ev.processBlock(f.slot, f.bnonce, f.prevHash));
    n++; if (Number(f.slot) >= firstE) nE++;
    tipSlot = Number(f.slot);
}
const t = ticks.find((x) => x.epoch === E);
if (!t) { console.error(`replayed ${n} block(s) from slot ${fromSlot} to ${tipSlot} but crossed no boundary into ${E}`); process.exit(2); }
const snap = ev.snapshot();
console.log(`replayed ${n} block(s), slots ${fromSlot}..${tipSlot} (${t.nBlocksPrev} in ${E - 1}, ${t.nBeforeFreeze} before the freeze; ${nE} in ${E}); freeze window ${ev.freezeWindowFor(E - 1)} slots (protocol ${majors.get(E - 1)})`);

let koios: Record<number, string | null> = {};
try {
    const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
    for (const e of [E - 1, E]) { const r = await fetch(`${base}/epoch_params?_epoch_no=${e}`, { headers: { accept: "application/json" } }); koios[e] = r.ok ? String(((await r.json()) as any[])[0]?.nonce ?? "") || null : null; }
} catch (err) { console.log(`Koios unavailable: ${(err as Error).message}`); }

const recomputed: NonceRow = {
    nonceHex: t.eta0Hex, source: "local",
    evolvingHex: nE > 0 ? snap.etaVHex : row?.evolvingHex ?? t.etaVHex, candidateHex: nE > 0 ? snap.etaCHex : row?.candidateHex ?? t.etaCHex,
    startEvolvingHex: t.etaVHex, startCandidateHex: t.etaCHex,
    startSlot: row?.startSlot ?? null, startLabHex: row?.startLabHex ?? null,
};
const line = (name: string, stored: string | null | undefined, ours: string | null, ko?: string | null) => {
    const same = (stored ?? null) === ours;
    console.log(`  ${(same ? "same" : "DIFF").padEnd(4)} ${name.padEnd(20)} stored ${stored ?? "absent"}\n${" ".repeat(26)}recomputed ${ours}${ko !== undefined ? `\n${" ".repeat(26)}Koios ${ko ?? "absent"}${ko ? (ko === ours ? " (= recomputed)" : " (≠ recomputed)") : ""}` : ""}`);
    return same;
};
console.log(`epoch ${E - 1} (input):`);
line(`η0(${E - 1})`, prevRow.nonceHex, prevRow.nonceHex, koios[E - 1]);
console.log(`epoch ${E} (record):`);
let ok = true;
ok = line(`η0(${E})`, row?.nonceHex, recomputed.nonceHex, koios[E]) && ok;
ok = line("source", row?.source, "local") && ok;
ok = line("start ηv", row?.startEvolvingHex, recomputed.startEvolvingHex) && ok;
ok = line("start ηc", row?.startCandidateHex, recomputed.startCandidateHex) && ok;
ok = line(`ηv at slot ${tipSlot}`, row?.evolvingHex, recomputed.evolvingHex) && ok;
ok = line(`ηc at slot ${tipSlot}`, row?.candidateHex, recomputed.candidateHex) && ok;
if (koios[E] && koios[E] !== recomputed.nonceHex) { console.error(`recomputed η0(${E}) differs from Koios: not writing`); process.exit(1); }
if (ok) { console.log("stored record already matches; nothing to write"); process.exit(0); }
if (!write) { console.log(`dry run: re-run with --yes (node stopped) to write the recomputed record of epoch ${E}`); process.exit(0); }

const st = LedgerStore.open(ledgerDir);
try {
    await st.applyDirect(() => new GovWrites(st).putNonce(E, recomputed));
    console.log(`wrote the record of epoch ${E}: η0 ${recomputed.nonceHex}`);
    const back = new GovReads(st).nonce(E);
    if (back?.nonceHex !== recomputed.nonceHex) { console.error("read-back differs!"); process.exit(1); }
} finally { st.close(); }

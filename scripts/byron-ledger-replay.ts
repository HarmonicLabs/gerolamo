/**
 * Replay of the Byron chain-validation state the node keeps (src/consensus/byron/ByronLedger.ts,
 * cardano-node's path: `applyChainTick`, then `validateBlock` / `validateBoundary`) and, with
 * --utxo, of the Byron UTXO rules with the *adopted* parameters
 (rules/byronTxRules.evaluateByronTxRules on the transactions as rules/blockRules decodes them:
 * size limit and fee on the on-chain `ATxAux` bytes), over a cardano-node immutable directory,
 * read-only. The UTxO set is rebuilt in memory from the genesis file; witness signatures and
 * key-to-root hashes are not recomputed (unchanged rules; pure-TS ed25519 / sha3 would take hours),
 * witness types are still matched against the spent addresses.
 *
 *   bun scripts/byron-ledger-replay.ts <immutable dir> --network mainnet [--utxo] [--no-sigs] [--to-slot N] [--quiet]
 *
 * Prints every adoption with the parameters it changed, the slot from which the Byron→Shelley
 * transition is known (`byronTransition`) and its epoch against the first non-Byron block's, the
 * largest block / header / transaction against the limit in force, and every rule failure.
 * Exit 1 on any failure: on a real chain each one is a false rejection by our code.
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { ChunkStore } from "../src/storage/chunkStore";
import { splitEraBlock } from "../src/consensus/bodyHash";
import {
    applyByronBoundary, applyByronMainBlock, byronBoundaryFacts, byronLedgerConfigFromGenesis, byronMainBlockFacts, byronTransitionEpoch,
    decodeByronLedger, encodeByronLedgerCore, encodeByronLedgerTip, initialByronLedgerState, tickByronLedger, type ByronLedgerState,
} from "../src/consensus/byron/ByronLedger";
import { changedFields, pvKey } from "../src/consensus/byron/ByronUpdate";
import { byronGenesisUtxos } from "../src/consensus/byron/genesisUtxo";
import { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { addressString, advanceResolved } from "../src/consensus/rules/blockRulesPure";
import { byronBlockTxs, byronTxAuxSizes } from "../src/consensus/rules/blockRules";
import { evaluateByronTxRules } from "../src/consensus/rules/byronTxRules";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const network = opt("network");
if (!dir || !network) {
    console.error("usage: bun scripts/byron-ledger-replay.ts <immutable dir> --network <mainnet|preprod> [--utxo] [--no-sigs] [--to-slot N] [--quiet]");
    process.exit(2);
}
const genesisFile = `${import.meta.dir}/../src/config/${network}/byron-genesis.json`;
const genesis = await Bun.file(genesisFile).json();
const cfg = byronLedgerConfigFromGenesis(genesis, { skipSignatures: argv.includes("--no-sigs") });
const withUtxo = argv.includes("--utxo");
const quiet = argv.includes("--quiet");
const toSlot = Number(opt("to-slot") ?? Number.MAX_SAFE_INTEGER);
const store = await ChunkStore.open(dir, { chunkSlots: Number(cfg.epochSlots), cacheChunks: 4, readOnly: true, hashIndexPath: false });

// in-memory UTxO: ref → [address, lovelace]
const utxo = new Map<string, [string, bigint]>();
if (withUtxo) for (const u of byronGenesisUtxos(genesis).utxos) utxo.set(u.utxoRef, [u.address, u.lovelace]);
const flat = (x: string) => Buffer.from(x, "latin1").toString("latin1");
const addrMemo = new Map<string, { type: number; root: string } | null>();
const addrOf = (s: string) => {
    let a = addrMemo.get(s);
    if (a === undefined) {
        try { const x = ByronAddress.fromBase58(s); a = { type: Number(x.type), root: toHex(x.rootHash) }; } catch { a = null; }
        if (addrMemo.size > 200_000) addrMemo.clear();
        addrMemo.set(s, a);
    }
    return a;
};

let st: ByronLedgerState = initialByronLedgerState(cfg);
const failures: string[] = [];
const fail = (slot: bigint | number, m: string) => { failures.push(`slot ${slot}: ${m}`); if (failures.length <= 50) console.log(`FAIL slot ${slot}: ${m}`); };
const t0 = performance.now();
let mains = 0, ebbs = 0, txs = 0, txBlocks = 0, persistRoundTrips = 0, coreWrites = 0, lastCore = "";
let transitionKnownAt: { slot: bigint; blockNo: bigint | null; epoch: bigint } | null = null;
type Max = { size: number; slot: bigint; limit: bigint };
const regimes = new Map<string, { block: Max; header: Max; tx: Max; from: bigint }>();
const regime = () => { const k = pvKey(st.update.adoptedProtocolVersion); let r = regimes.get(k); if (!r) regimes.set(k, (r = { block: { size: 0, slot: 0n, limit: 0n }, header: { size: 0, slot: 0n, limit: 0n }, tx: { size: 0, slot: 0n, limit: 0n }, from: st.lastSlot })); return r; };
const logAdoption = (slot: bigint | number, from: ByronLedgerState, to: ByronLedgerState, at: string) => {
    const pp = to.update.adoptedProtocolParameters;
    console.log(`[slot ${slot}] ADOPTED ${pvKey(to.update.adoptedProtocolVersion)} at epoch ${BigInt(slot) / cfg.epochSlots} (${at}); changed: ${changedFields(from.update.adoptedProtocolParameters, pp).map((k) => `${k}=${JSON.stringify((pp as any)[k], (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`).join(", ") || "none"}`);
};
const note = (m: Max, size: number, slot: bigint, limit: bigint) => { if (size > m.size) { m.size = size; m.slot = slot; m.limit = limit; } };

for await (const b of store.iterate(0, toSlot, { includeEbb: true })) {
    const { era, rawBlock } = splitEraBlock(b.bytes);
    if (era > 1) {
        const epoch = BigInt(b.slot) / cfg.epochSlots;
        const end = byronTransitionEpoch(cfg, st, 2);
        const ticked = tickByronLedger(cfg, st, BigInt(b.slot));
        console.log(`\nfirst non-Byron block (era tag ${era}) at slot ${b.slot}, Byron-epoch arithmetic ${epoch}`);
        console.log(`  byronTransition at the last Byron block: ${end ?? "unknown"}${transitionKnownAt ? ` (known since slot ${transitionKnownAt.slot}, block ${transitionKnownAt.blockNo}, epoch ${transitionKnownAt.epoch})` : ""}`);
        console.log(`  tick to slot ${b.slot}: adopted ${pvKey(ticked.update.adoptedProtocolVersion)}`);
        if (end == null || end !== epoch) fail(b.slot, `Shelley transition from the Byron update state is ${end ?? "unknown"}, the chain's first post-Byron block is in epoch ${epoch}`);
        if (ticked.update.adoptedProtocolVersion.major !== 2) fail(b.slot, `ticking to the first Shelley slot adopts ${pvKey(ticked.update.adoptedProtocolVersion)}, not major 2`);
        break;
    }
    const before = st;
    if (era === 0) {
        const bf = byronBoundaryFacts(rawBlock, cfg.epochSlots); // (the chunk index files an EBB under its epoch number, not a slot)
        const r = applyByronBoundary(cfg, st, bf);
        for (const e of r.errors) fail(bf.slot, e);
        // an epoch that opens with an EBB runs its UPIEC at the EBB's tick (bug 302)
        if (r.state.update.adoptedProtocolVersion !== st.update.adoptedProtocolVersion) logAdoption(bf.slot, st, r.state, "EBB tick");
        st = r.state;
        ebbs++;
    } else {
        const f = byronMainBlockFacts(rawBlock, cfg.epochSlots);
        const end = byronTransitionEpoch(cfg, st, 2);
        if (end != null && f.slot >= end * cfg.epochSlots) fail(f.slot, `Byron block past the known transition (epoch ${end})`);
        const ticked = tickByronLedger(cfg, st, f.slot);
        const pp = ticked.update.adoptedProtocolParameters;
        if (ticked.update.adoptedProtocolVersion !== st.update.adoptedProtocolVersion) logAdoption(f.slot, st, ticked, "main-block tick");
        st = ticked;
        const rg = regime();
        note(rg.block, f.blockSize, f.slot, pp.maxBlockSize);
        note(rg.header, f.headerSize, f.slot, pp.maxHeaderSize);
        if (withUtxo) {
            const sizes = byronTxAuxSizes(b.bytes) ?? [];
            if (sizes.length) {
                txBlocks++;
                const blk = MultiEraBlock.fromCbor(b.bytes);
                const { txs: list, failures: undecodable } = byronBlockTxs(blk);
                for (const e of undecodable) fail(f.slot, e);
                if (sizes.length !== list.length) fail(f.slot, `${sizes.length} ATxAux slices, ${list.length} decoded transactions`);
                // the block's transactions in order, each against the UTxO its predecessors left
                const resolved = new Map<string, ResolvedUtxo>();
                list.forEach((t, i) => {
                    for (const r of t.refs) if (!resolved.has(r)) { const u = utxo.get(r); if (u) resolved.set(r, { ref: r, address: u[0], value: new Map([["lovelace", u[1]]]), referenceScriptHash: null, hasDatum: false }); }
                    const size = sizes[i] ?? null;
                    if (size != null) note(rg.tx, size, f.slot, pp.maxTxSize);
                    // collectByronWitnesses without the signature / root crypto (pure-TS sha3, ~0.5 ms per input,
                    // unchanged by this work): witness types against the spent addresses, roots taken as matching
                    const problems: string[] = [], types: number[] = [], roots: Array<{ root: string; inputRef: string }> = [];
                    if (t.witnesses.length !== t.refs.length) problems.push(`${t.witnesses.length} witnesses for ${t.refs.length} inputs`);
                    else t.refs.forEach((ref, j) => {
                        const u = resolved.get(ref);
                        const a = u ? addrOf(u.address) : null;
                        const type = Number(t.witnesses[j]?.type);
                        if (!a) { problems.push(`input ${ref}: not a Byron address`); return; }
                        if (!((type === 0 && a.type === 0) || (type === 2 && a.type === 2))) { problems.push(`input ${ref}: witness type ${type} does not match address type ${a.type}`); return; }
                        types.push(type); roots.push({ root: a.root, inputRef: ref });
                    });
                    const r = evaluateByronTxRules({
                        txHashHex: toHex(t.hash), inputs: t.tx.inputs ?? [], outputs: t.tx.outputs ?? [], resolved,
                        witnesses: { items: roots.map(() => ({ publicKey: new Uint8Array(32), signature: new Uint8Array(64), message: new Uint8Array(0) })), roots, types, problems },
                        witnessOk: roots.map(() => true), witnessTypes: types,
                        feePolicy: pp.txFeePolicy, txSizeBytes: (() => { try { return t.tx.toCborBytes().length; } catch { return null; } })(),
                        txAuxSizeBytes: size, maxTxSize: pp.maxTxSize,
                    });
                    for (const e of r.failures) fail(f.slot, `tx ${toHex(t.hash).slice(0, 16)}: ${e}`);
                    const h = toHex(t.hash);
                    const outs = ((t.tx.outputs ?? []) as any[]).map((o) => ({ address: addressString(o.address), value: new Map([["lovelace", BigInt(o.amount ?? 0)]]) }));
                    advanceResolved(resolved, h, t.tx.inputs ?? [], outs);
                    for (const ref of t.refs) utxo.delete(ref);
                    // flat copies: a base58 string built char by char is a rope of ~100 fibers, and 2 M of them held in the map exhaust the heap
                    outs.forEach((o, k) => utxo.set(flat(`${h}:${k}`), [flat(o.address), o.value.get("lovelace")!]));
                    txs++;
                });
            }
        }
        const r = applyByronMainBlock(cfg, st, f);
        for (const e of r.errors) fail(f.slot, e);
        st = r.state;
        if (!quiet) {
            const p = f.payload.proposal;
            if (p) console.log(`[slot ${f.slot}] proposal ${p.upId.slice(0, 12)} pv ${pvKey(p.protocolVersion)} sv ${p.softwareVersion.appName}:${p.softwareVersion.number} ppu {${Object.keys(p.ppUpdate).join(",")}}`);
            if (f.payload.votes.length) console.log(`[slot ${f.slot}] ${f.payload.votes.length} vote(s)`);
            if (st.update.candidateProtocolUpdates[0] && st.update.candidateProtocolUpdates[0] !== before.update.candidateProtocolUpdates[0]) console.log(`[slot ${f.slot}] candidate ${pvKey(st.update.candidateProtocolUpdates[0].protocolVersion)} (block ${f.blockNo})`);
            if (f.certs.length) console.log(`[slot ${f.slot}] ${f.certs.length} delegation certificate(s)`);
        }
        mains++;
    }
    if (!transitionKnownAt) { const e = byronTransitionEpoch(cfg, st, 2); if (e != null) { transitionKnownAt = { slot: st.lastSlot, blockNo: st.tipBlockNo, epoch: e }; console.log(`[slot ${st.lastSlot}] Byron→Shelley transition known: epoch ${e}`); } }
    // persistence: what the node writes must read back as the same state
    const core = encodeByronLedgerCore(st);
    if (core !== lastCore) {
        coreWrites++;
        lastCore = core;
        const back = decodeByronLedger(core, encodeByronLedgerTip(st));
        if (encodeByronLedgerCore(back) !== core || encodeByronLedgerTip(back) !== encodeByronLedgerTip(st)) fail(b.slot, "persisted state does not round-trip");
        persistRoundTrips++;
    }
    if ((mains + ebbs) % 100_000 === 0) Bun.gc(true);
    if ((mains + ebbs) % 250_000 === 0) console.log(`  … ${mains} main blocks, slot ${b.slot}, ${((performance.now() - t0) / 1000).toFixed(0)} s, adopted ${pvKey(st.update.adoptedProtocolVersion)}${withUtxo ? `, ${txs} txs, UTxO ${utxo.size}` : ""}, rss ${(process.memoryUsage().rss / 2 ** 30).toFixed(2)} GB`);
}

console.log(`\n${mains} main blocks + ${ebbs} EBBs${withUtxo ? `, ${txs} txs in ${txBlocks} blocks, final UTxO ${utxo.size}` : ""} in ${((performance.now() - t0) / 1000).toFixed(1)} s; core state written ${coreWrites}× (round-trip checked)`);
console.log(`adopted ${pvKey(st.update.adoptedProtocolVersion)}; delegation map ${st.delegation.map.size} keys, ${st.delegation.scheduled.length} scheduled`);
for (const [v, r] of regimes) console.log(`  under ${v} (from slot ${r.from}): largest block ${r.block.size} B @${r.block.slot} (limit ${r.block.limit}), header ${r.header.size} B (limit ${r.header.limit})${withUtxo ? `, tx ${r.tx.size} B @${r.tx.slot} (limit ${r.tx.limit})` : ""}`);
if (failures.length) { console.log(`FAIL: ${failures.length} failure(s)`); process.exit(1); }
console.log("OK: no rule failures");
process.exit(0);

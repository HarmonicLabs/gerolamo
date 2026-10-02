#!/usr/bin/env bun
/**
 * Replay the voting (tag 4) and proposing (tag 5) redeemer rules over a chunk directory, read-only
 * (bug 277): every transaction that casts a vote by a script voter (CC hot or DRep script), submits a
 * proposal guarded by a policy script, or carries a tag 4/5 redeemer is evaluated
 *   - by the node's UTXOW redeemer ↔ purpose match (rules/alonzoRules.ts through evaluateTxRules:
 *     `extra redeemer` / `missing redeemer` for the Voting / Proposing purposes), and
 *   - by Plutus phase 2 (rules/phase2.ts), whose verdict must be the block's is_valid flag,
 * with inputs, collateral and reference inputs resolved from the chain itself (two passes, as
 * scripts/plutus-replay.ts). Any redeemer message on a transaction the chain adopted is a false rejection.
 *
 *   bun scripts/gov-redeemers-replay.ts <immutable dir> --params <db with epoch_params> [--network preview] [--from-slot N]
 *   bun scripts/gov-redeemers-replay.ts <immutable dir> --network preprod --no-phase2      (the match only; no parameters needed)
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { MultiEraBlock, TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { ChunkStore } from "../src/storage/chunkStore";
import { items, scanBlock, skip, uint, witnessRedeemers } from "./lib/cborWalk";
import { epochForSlot, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import { evaluateTxRules } from "../src/consensus/rules/txRules";
import { outputLike, ruleParams } from "../src/consensus/rules/blockRulesPure";
import { evaluatePhase2 } from "../src/consensus/rules/phase2";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv[0];
const noPhase2 = argv.includes("--no-phase2");
if (!dir || dir.startsWith("--") || (!opt("params") && !noPhase2)) { console.error("usage: gov-redeemers-replay.ts <immutable dir> --params <db> [--network preview] [--from-slot N] | --no-phase2"); process.exit(2); }
const network = opt("network") ?? "preview";
setEpochNetwork(network);
const genesis = JSON.parse(readFileSync(`${import.meta.dir}/../src/config/${network}/shelley-genesis.json`, "utf8"));
const config = { network, networkMagic: Number(genesis.networkMagic) };
const fromSlot = Number(opt("from-slot") ?? (network === "preprod" ? 68_774_400 : 55_814_400)); // the Conway hard fork (preview epoch 646, preprod 163)
const store = await ChunkStore.open(dir, { chunkSlots: network === "preview" ? 4320 : 21600, cacheChunks: 4, readOnly: true, hashIndexPath: false });
const pdb = opt("params") ? new Database(opt("params")!, { readonly: true }) : null;
const rawParams = new Map<number, Record<string, unknown> | null>();
const rawFor = (e: number) => { if (!pdb) return null; if (!rawParams.has(e)) { const r = pdb.query("SELECT params FROM epoch_params WHERE epoch = ?").get(e) as { params: string } | null; rawParams.set(e, r ? JSON.parse(r.params) : null); } return rawParams.get(e)!; };
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const txHashOf = (b: Uint8Array) => new Bun.CryptoHasher("blake2b256").update(b).digest("hex");

function bodyFields(b: Uint8Array, s: number): Map<number, number> { const m = items(b, s).starts, f = new Map<number, number>(); for (let i = 0; i < m.length; i += 2) f.set(uint(b, m[i]!), m[i + 1]!); return f; }
function refsAt(b: Uint8Array, p: number | undefined): string[] {
    if (p == null) return [];
    return items(b, p).starts.map((s) => { const e = items(b, s).starts; const [a, z] = [e[0]!, skip(b, e[0]!)]; return `${hex(b.subarray(a + (z - a - 32), z))}:${uint(b, e[1]!)}`; });
}
const isNull = (b: Uint8Array, p: number) => b[p] === 0xf6;
/** What the governance redeemer rules look at in a body: script voters (CC hot / DRep scripts) and guarded proposals. */
function govShape(b: Uint8Array, f: Map<number, number>): { scriptVoters: number; guarded: number; voters: number; proposals: number } {
    let scriptVoters = 0, guarded = 0, voters = 0, proposals = 0;
    const vp = f.get(19);
    if (vp != null) { const m = items(b, vp).starts; for (let i = 0; i < m.length; i += 2) { voters++; const tag = uint(b, items(b, m[i]!).starts[0]!); if (tag === 1 || tag === 3) scriptVoters++; } }
    const pp = f.get(20);
    if (pp != null) for (const p of items(b, pp).starts) {
        proposals++;
        const ga = items(b, items(b, p).starts[2]!).starts, kind = uint(b, ga[0]!);
        const pol = kind === 0 ? ga[3] : kind === 2 ? ga[2] : undefined;
        if (pol != null && !isNull(b, pol)) guarded++;
    }
    return { scriptVoters, guarded, voters, proposals };
}

// ── pass A: candidate transactions and the refs they read ──
const t0 = performance.now();
const needed = new Set<string>();
const candidates = new Set<string>(); // `${slot}:${i}`
const cov = { candidates: 0, valid: 0, invalid: 0, scriptVotes: 0, guardedProposals: 0, voteRedeemers: 0, proposeRedeemers: 0, txsWithVoteRedeemers: 0, txsWithProposeRedeemers: 0, voteRedeemersAtNonZeroIndex: 0, voteTxsWithSeveralVoters: 0, proposeRedeemersAtNonZeroIndex: 0, scriptVoteTxsWithoutRedeemer: 0 };
for await (const blk of store.iterate(fromSlot)) {
    const s = scanBlock(blk.bytes);
    if (!s || s.era < 7) continue;
    for (let i = 0; i < s.bodies.length; i++) {
        const b = blk.bytes, f = bodyFields(b, s.bodies[i]![0]);
        const rs = witnessRedeemers(b, s.witnessStarts[i]!);
        const nv = rs.filter((r) => r.tag === 4).length, np = rs.filter((r) => r.tag === 5).length;
        const g = f.has(19) || f.has(20) ? govShape(b, f) : { scriptVoters: 0, guarded: 0, voters: 0, proposals: 0 };
        if (!nv && !np && !g.scriptVoters && !g.guarded) continue;
        candidates.add(`${blk.slot}:${i}`);
        cov.candidates++; if (s.invalid.has(i)) cov.invalid++; else cov.valid++;
        cov.scriptVotes += g.scriptVoters; cov.guardedProposals += g.guarded; cov.voteRedeemers += nv; cov.proposeRedeemers += np;
        if (nv) cov.txsWithVoteRedeemers++; if (np) cov.txsWithProposeRedeemers++;
        // the index ↔ purpose mapping is exercised only where a redeemer does not point at the first voter / proposal
        cov.voteRedeemersAtNonZeroIndex += rs.filter((r) => r.tag === 4 && r.index > 0).length;
        cov.proposeRedeemersAtNonZeroIndex += rs.filter((r) => r.tag === 5 && r.index > 0).length;
        if (nv && g.voters > 1) cov.voteTxsWithSeveralVoters++;
        if (g.scriptVoters && !nv) cov.scriptVoteTxsWithoutRedeemer++;
        for (const key of [0, 13, 18]) for (const r of refsAt(b, f.get(key))) needed.add(r);
    }
}
console.log(`pass A: ${JSON.stringify(cov)}; ${needed.size} refs to resolve, ${((performance.now() - t0) / 1000).toFixed(0)} s`);

// ── pass B: resolve from the chain, evaluate the candidates ──
const live = new Map<string, Uint8Array>();
const res = { evaluated: 0, unresolved: 0, matchMessages: 0, matchOnValid: 0, phase2Ok: 0, phase2Mismatch: 0, phase2NoVerdict: 0, examples: [] as string[] };
const t1 = performance.now();
for await (const blk of store.iterate(0)) {
    const b = blk.bytes;
    const s = scanBlock(b);
    if (!s) continue;
    let parsed: any = null;
    for (let i = 0; i < s.bodies.length; i++) {
        const [a, z] = s.bodies[i]!;
        const f = bodyFields(b, a);
        const valid = !s.invalid.has(i);
        if (candidates.has(`${blk.slot}:${i}`)) {
            const refs = new Set([0, 13, 18].flatMap((key) => refsAt(b, f.get(key))));
            const resolved = new Map<string, ResolvedUtxo>();
            let missing = 0;
            for (const r of refs) {
                const o = live.get(r);
                if (!o) { missing++; continue; }
                const u = outputLike(TxOut.fromCbor(o));
                resolved.set(r, { ref: r, address: u.address, value: u.value, referenceScriptHash: u.referenceScriptHash ?? null, referenceScriptCbor: u.referenceScriptCbor ?? null, hasDatum: !!u.hasDatum, datumHash: u.datumHash ?? null, inlineDatumCbor: u.inlineDatumCbor ?? null });
            }
            if (missing) { res.unresolved++; if (res.examples.length < 30) res.examples.push(`unresolved slot ${blk.slot} tx ${i}: ${missing} ref(s)`); }
            else {
                parsed ??= MultiEraBlock.fromCbor(b);
                const e = Number(epochForSlot(blk.slot)), raw = rawFor(e);
                const params = raw ? epochParamsFromRecord(e, raw) : null;
                const body: any = parsed.block.transactionBodies[i], ws: any = parsed.block.transactionWitnessSets[i];
                // signatures are not what this replays (only the redeemer messages are kept)
                const r = evaluateTxRules({ era: s.era, body, witnessSet: ws, slot: BigInt(blk.slot), resolved, provenKeys: new Set(), provenRoots: new Set(), isPoolRegistered: () => true, params: ruleParams(params, genesis, s.era, config.network), txSizeBytes: null });
                const msgs = [...r.failures, ...r.reports].filter((m) => /redeemer/.test(m));
                res.evaluated++;
                if (msgs.length) { res.matchMessages++; if (valid) res.matchOnValid++; if (res.examples.length < 30) res.examples.push(`${valid ? "VALID" : "invalid"} slot ${blk.slot} tx ${i} ${txHashOf(b.subarray(a, z)).slice(0, 16)}: ${msgs.join(" | ").slice(0, 300)}`); }
                if (!noPhase2 && witnessRedeemers(b, s.witnessStarts[i]!).length) {
                    const p2 = await evaluatePhase2({ era: s.era, bodyBytes: b.subarray(a, z), witnessSetBytes: b.subarray(s.witnessStarts[i]!, skip(b, s.witnessStarts[i]!)), resolved, params, markedInvalid: !valid, network });
                    if (p2.error && !p2.collect) { res.phase2NoVerdict++; if (res.examples.length < 30) res.examples.push(`phase 2 no verdict slot ${blk.slot} tx ${i}: ${p2.error}`); }
                    else if ((p2.ok && !p2.error) === valid) res.phase2Ok++;
                    else { res.phase2Mismatch++; if (res.examples.length < 30) res.examples.push(`phase 2 ${valid ? "valid tx failed" : "invalid tx passed"} slot ${blk.slot} tx ${i}: ${p2.error ?? p2.redeemers.filter((x) => !x.ok).map((x) => `${x.tag}:${x.index} ${x.reason ?? ""}`).join("; ")}`); }
                }
            }
        }
        const txHash = txHashOf(b.subarray(a, z));
        if (valid) for (const r of refsAt(b, f.get(0))) live.delete(r);
        else for (const r of refsAt(b, f.get(13))) live.delete(r);
        const outsP = f.get(1);
        const outs = outsP != null ? items(b, outsP).starts : [];
        if (valid) outs.forEach((p, j) => { const r = `${txHash}:${j}`; if (needed.has(r)) live.set(r, b.slice(p, skip(b, p))); });
        else if (f.get(16) != null) { const r = `${txHash}:${outs.length}`; const p = f.get(16)!; if (needed.has(r)) live.set(r, b.slice(p, skip(b, p))); }
    }
}
console.log(JSON.stringify({ coverage: cov, result: res, secs: Math.round((performance.now() - t1) / 1000) }, null, 2));
process.exit(res.matchOnValid || res.phase2Mismatch ? 1 : 0);

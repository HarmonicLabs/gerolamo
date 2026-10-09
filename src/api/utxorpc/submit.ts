/**
 * UTxO RPC v1alpha SubmitService: SubmitTx (the node's validating mempool), EvalTx (the node's
 * Plutus evaluator, scripts run with the transaction budget so the real cost is reported),
 * WaitForTx (MEMPOOL when the mempool holds it, CONFIRMED once a block of the selected chain
 * carries it), ReadMempool and WatchMempool.
 */
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import { cardano, submit, type submitConnect } from "@utxorpc/spec";
import { parseCbor } from "../../consensus/plutus/cbor";
import { evaluatePhase2Sync } from "../../consensus/rules/phase2";
import { tierRefScriptFee } from "../../consensus/rules/txRules";
import { toFraction } from "../../network/n2c/pparamsCbor";
import { bigIntMsg, blockTxs, plutusData, referencedInputs, txFromBytes, txIdOf, u8 } from "./mapper";
import { AsyncQueue, bad, chainWaiter, needStore, resolverFor, unavailable, type UtxorpcLimits } from "./common";
import { followChain, pointOf } from "./chain";
import { selectedTip } from "../../storage/blockReads";
import { needsResolvedInputs, txPredicateMatches, type AnyTxPredicate } from "./predicates";
import type { UtxorpcProvider } from "./provider";

type SubmitImpl = ServiceImpl<typeof submitConnect.SubmitService>;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function rawTx(tx: submit.AnyChainTx | undefined): Uint8Array {
    if (!tx || tx.type.case !== "raw" || !tx.type.value.length) throw bad("missing or unsupported tx type (send raw CBOR)");
    return tx.type.value;
}

/** A mempool transaction as `TxInMempool` (inputs resolved from the ledger when the predicate needs them). */
function inMempool(p: UtxorpcProvider, txId: string, bytes: Uint8Array, resolve: boolean): submit.TxInMempool {
    let parsed: cardano.Tx | undefined;
    try { parsed = txFromBytes(bytes, resolve ? resolverFor(p, null) : undefined); } catch { parsed = undefined; }
    return new submit.TxInMempool({ ref: u8(Buffer.from(txId, "hex")), nativeBytes: u8(bytes), stage: submit.Stage.MEMPOOL, parsedState: parsed ? { case: "cardano", value: parsed } : { case: undefined } });
}

/** Evaluate every redeemer of a transaction; the report carries each one's measured units, the sum, the fee and the failures. */
export async function evalTx(p: UtxorpcProvider, bytes: Uint8Array): Promise<cardano.TxEval> {
    let n;
    try { n = parseCbor(bytes); } catch { throw bad("the transaction does not decode"); }
    if (n.t !== "a" || n.v.length < 3) throw bad("not a transaction");
    const [body, wits] = n.v as [any, any];
    const ctx = await p.evalContext(referencedInputs(body));
    if (!ctx) throw unavailable("evaluation needs the ledger store and the current protocol parameters");
    const errors: cardano.EvalError[] = [];
    const missing = referencedInputs(body).filter((r) => !ctx.resolved.has(r));
    for (const r of missing) errors.push(new cardano.EvalError({ msg: `input ${r} is not in the UTxO set` }));
    const raw = ctx.params.raw ?? {};
    const big = (v: unknown, d: bigint) => { try { return v == null ? d : BigInt(String(v)); } catch { return d; } };
    const budget = { mem: big(raw.max_tx_ex_mem, 14_000_000n), cpu: big(raw.max_tx_ex_steps, 10_000_000_000n) };
    const r = evaluatePhase2Sync({ era: 7, bodyBytes: bytes.subarray(body.s, body.e), witnessSetBytes: bytes.subarray(wits.s, wits.e), resolved: ctx.resolved, params: ctx.params, markedInvalid: false, traces: true, network: ctx.network, budget });
    if (r.error) errors.push(new cardano.EvalError({ msg: r.error }));
    const traces: cardano.EvalTrace[] = [];
    let mem = 0n, steps = 0n;
    const redeemers: cardano.Redeemer[] = [];
    const witRedeemers = new Map<string, { data: any; original: Uint8Array }>();
    for (const [k, v] of wits.t === "m" ? wits.v : []) {
        if (k.t !== "u" || k.v !== 5n) continue;
        const inner = v.t === "tag" ? v.v : v;
        if (inner.t === "a") for (const it of inner.v) { const [tag, index, data] = it.v; witRedeemers.set(`${tag.v}:${index.v}`, { data, original: bytes.subarray(it.s, it.e) }); }
        else if (inner.t === "m") for (const [kk, vv] of inner.v) { const [tag, index] = kk.v; witRedeemers.set(`${tag.v}:${index.v}`, { data: vv.v[0], original: new Uint8Array(0) }); }
    }
    for (const o of r.redeemers) {
        const spent = o.spent ?? { mem: 0n, cpu: 0n };
        mem += spent.mem; steps += spent.cpu;
        const w = witRedeemers.get(`${o.tag}:${o.index}`);
        redeemers.push(new cardano.Redeemer({ purpose: (o.tag + 1) as cardano.RedeemerPurpose, index: o.index, exUnits: new cardano.ExUnits({ memory: spent.mem, steps: spent.cpu }), payload: w ? plutusData(w.data) : undefined, originalCbor: w?.original.length ? u8(w.original) : undefined }));
        for (const l of o.logs ?? []) traces.push(new cardano.EvalTrace({ msg: l }));
        if (o.spent && !o.ok) errors.push(new cardano.EvalError({ msg: `redeemer ${o.tag}:${o.index}: ${o.reason ?? "script failed"}` }));
    }
    // fee with the measured units: size·a + b + ⌈prices · units⌉ + tiered reference-script fee
    let fee = big(raw.min_fee_a, 0n) * BigInt(bytes.length) + big(raw.min_fee_b, 0n);
    if ((mem > 0n || steps > 0n) && raw.price_mem != null && raw.price_step != null) {
        const [mn, md] = toFraction(raw.price_mem), [sn, sd] = toFraction(raw.price_step);
        const num = mem * mn * sd + steps * sn * md, den = md * sd;
        fee += (num + den - 1n) / den;
    }
    let refBytes = 0;
    for (const ref of referencedInputs(body)) { const u = ctx.resolved.get(ref); if (u?.referenceScriptCbor) refBytes += u.referenceScriptCbor.length / 2; }
    const perByte = raw.min_fee_ref_script_cost_per_byte;
    if (refBytes > 0 && perByte != null) fee += tierRefScriptFee(refBytes, Number(perByte));
    return new cardano.TxEval({ fee: bigIntMsg(fee), exUnits: new cardano.ExUnits({ memory: mem, steps }), errors, traces, redeemers });
}

export function submitService(p: UtxorpcProvider, limits: UtxorpcLimits): Partial<SubmitImpl> {
    void limits;
    return {
        async submitTx(req) {
            const bytes = rawTx(req.tx);
            let id: Uint8Array;
            try { id = txIdOf(bytes); } catch { throw bad("the transaction does not decode"); }
            const v = await p.submitTx(bytes);
            if (!v.accepted) throw bad(`could not process tx: ${v.reason ?? "rejected"}`);
            return new submit.SubmitTxResponse({ ref: u8(id) });
        },

        async evalTx(req) {
            const report = await evalTx(p, rawTx(req.tx));
            return new submit.EvalTxResponse({ report: new submit.AnyChainEval({ chain: { case: "cardano", value: report } }) });
        },

        async readMempool() {
            const m = p.mempool();
            if (!m) return new submit.ReadMempoolResponse();
            const s = await m.snapshot();
            return new submit.ReadMempoolResponse({ items: s.txs.map((t) => inMempool(p, t.txId, t.bytes, false)) });
        },

        async *waitForTx(req, ctx: HandlerContext) {
            const pending = new Set<string>();
            for (const r of req.ref) {
                if (r.length !== 32) throw bad(`transaction reference must be 32 bytes, got ${r.length}`);
                pending.add(hex(r));
            }
            if (!pending.size) return;
            const store = needStore(p);
            const reported = new Map<string, submit.Stage>();
            const out = new AsyncQueue<submit.WaitForTxResponse>();
            const report = (id: string, stage: submit.Stage) => {
                if ((reported.get(id) ?? 0) >= stage) return;
                reported.set(id, stage);
                out.push(new submit.WaitForTxResponse({ ref: u8(Buffer.from(id, "hex")), stage }));
                if (stage === submit.Stage.CONFIRMED) { pending.delete(id); if (!pending.size) out.close(); }
            };
            const stop = new AbortController();
            const signal = AbortSignal.any([ctx.signal, stop.signal]);
            // already on chain: an output of it is unspent, or a volatile block carries it
            const utxos = p.utxos();
            const tip = await selectedTip(store);
            for (const id of [...pending]) if (utxos && utxos.byTxHash(id).length) report(id, submit.Stage.CONFIRMED);
            if (tip && pending.size) {
                for (const v of store.volatileChain(tip.hash)) {
                    let ids: string[];
                    try { ids = blockTxs(v.bytes).map((t) => t.id); } catch { continue; }
                    for (const id of ids) if (pending.has(id)) report(id, submit.Stage.CONFIRMED);
                    if (!pending.size) break;
                }
            }
            const mp = p.mempool();
            if (pending.size && mp) {
                void (async () => {
                    let version = -1;
                    while (!signal.aborted && pending.size) {
                        const s = await mp.snapshot();
                        if (s.version !== version) { version = s.version; for (const t of s.txs) if (pending.has(t.txId)) report(t.txId, submit.Stage.MEMPOOL); }
                        await mp.waitForChange(version, signal);
                    }
                })().catch((e) => out.fail(e));
            }
            if (pending.size) {
                void (async () => {
                    const start = tip ? pointOf(tip) : { slot: 0n, hash: new Uint8Array(0), height: 0n };
                    for await (const ev of followChain(store, start, { signal, waitForChange: chainWaiter(p) })) {
                        if (ev.kind !== "apply") continue;
                        let ids: string[];
                        try { ids = blockTxs(ev.block.bytes).map((t) => t.id); } catch { continue; }
                        for (const id of ids) if (pending.has(id)) report(id, submit.Stage.CONFIRMED);
                        if (!pending.size) break;
                    }
                })().catch((e) => out.fail(e));
            } else out.close();
            try { yield* out.drain(signal); } finally { stop.abort(); }
        },

        async *watchMempool(req, ctx: HandlerContext) {
            const m = p.mempool();
            if (!m) throw unavailable("the node runs no mempool");
            const pred = req.predicate as unknown as AnyTxPredicate | undefined;
            const resolve = needsResolvedInputs(pred);
            const seen = new Set<string>();
            let version = -1;
            while (!ctx.signal.aborted) {
                const s = await m.snapshot();
                if (s.version !== version) {
                    version = s.version;
                    const now = new Set<string>();
                    for (const t of s.txs) {
                        now.add(t.txId);
                        if (seen.has(t.txId)) continue;
                        seen.add(t.txId);
                        const item = inMempool(p, t.txId, t.bytes, resolve);
                        if (pred && (item.parsedState.case !== "cardano" || !txPredicateMatches(pred, item.parsedState.value))) continue;
                        yield new submit.WatchMempoolResponse({ tx: item });
                    }
                    for (const id of [...seen]) if (!now.has(id)) seen.delete(id);
                }
                await m.waitForChange(version, ctx.signal);
            }
        },
    };
}


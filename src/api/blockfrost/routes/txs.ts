/** Transactions, submission, mempool and script evaluation. */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { mempoolTxHashToString } from "@harmoniclabs/shared-cardano-mempool-ts";
import { GlobalSharedMempool } from "../../../network/SharedMempool";
import { getStoredEpochParams, epochParamsFromRecord } from "../../../consensus/epochParams";
import { rationalOf, scriptExecutionFee } from "../../../consensus/rules/ledgerChecks";
import { evaluatePhase2Sync } from "../../../consensus/rules/phase2";
import { resolvedFromRow, type ResolvedUtxo } from "../../../consensus/rules/resolvedUtxo";
import { ledgerUtxoReads } from "../../../ledger/nodeLedgerStore";
import { mbSql } from "../../../db/minibf/explorerIndexer";
import { redeemerScriptHash } from "../../../db/minibf/writer";
import { certDelegatesPool, certDeregisters, certRegisters, REDEEMER_PURPOSES, scriptHash, txCbor, txFactsOfCbor, type TxFact } from "../../../db/minibf/blockFacts";
import { poolIdBech32, rewardAccountBech32, stakeAddressOf } from "../../../db/minibf/cardanoIds";
import { hex } from "../../../db/minibf/cborWalk";
import { epochForSlot } from "../../../utils/epochFromSlotCalculations";
import { metadataJson } from "../cborJson";
import { badRequest, bfError, HttpError, isHex64, json, notFound, pageOf, paging } from "../http";
import { route, type Ctx, type Route } from "../router";
import { amountOf, blockTime, mb, outputFactToResolved, resolveOutputs, txContext, type ResolvedOut, type TxCtx } from "../chain";
import { currentEpoch } from "./core";
import { ledger } from "../ledger";
import { deriveAddress, parseXPub } from "../xpub";

const sumAmounts = (outs: Array<{ lovelace: string; assets: Array<{ unit: string; quantity: string }> }>): Array<{ unit: string; quantity: string }> => {
    let lovelace = 0n;
    const units = new Map<string, bigint>();
    for (const o of outs) { lovelace += BigInt(o.lovelace); for (const a of o.assets) units.set(a.unit, (units.get(a.unit) ?? 0n) + BigInt(a.quantity)); }
    return amountOf(lovelace, [...units].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([unit, q]) => ({ unit, quantity: q.toString() })));
};

/** Deposit taken (positive) or refunded (negative): value conservation when every input is known, else the certificates. */
async function depositOf(tx: TxFact, ins: Array<ResolvedOut | null>, epoch: number): Promise<bigint> {
    if (!tx.valid || tx.byron) return 0n;
    if (ins.every((x) => x != null)) {
        const inSum = ins.reduce((a, x) => a + BigInt(x!.lovelace), 0n);
        const wd = tx.withdrawals.reduce((a, w) => a + w.amount, 0n);
        const out = tx.outputs.reduce((a, o) => a + o.lovelace, 0n);
        return inSum + wd - out - tx.fee - tx.donation;
    }
    const p = (await getStoredEpochParams(epoch)) ?? {};
    const keyDep = BigInt(String(p.key_deposit ?? 0)), poolDep = BigInt(String(p.pool_deposit ?? 0));
    let d = 0n;
    for (const c of tx.certs) {
        if (c.coin != null && (c.tag === 7 || c.tag === 11 || c.tag === 12 || c.tag === 13 || c.tag === 16)) d += c.coin;
        else if (c.coin != null && (c.tag === 8 || c.tag === 17)) d -= c.coin;
        else if (c.tag === 0) d += keyDep;
        else if (c.tag === 1) d -= keyDep;
        else if (c.tag === 3) d += poolDep;
    }
    for (const pr of tx.proposals) d += pr.deposit;
    return d;
}

export async function bfTx(t: TxCtx, c: Ctx): Promise<Record<string, unknown>> {
    const { tx, loc, block } = t;
    const ins = await resolveOutputs(tx.inputs);
    const outs = tx.valid ? tx.outputs : tx.collateralReturn ? [tx.collateralReturn] : [];
    const epoch = Number(epochForSlot(loc.slot, c.net));
    // Byron transactions carry no fee field: inputs − outputs, computed by the applier (mb_tx.fee)
    const fee = tx.byron ? BigInt(loc.fee ?? "0") : tx.valid ? tx.fee : loc.fee != null ? BigInt(loc.fee) : tx.totalCollateral ?? 0n;
    return {
        hash: tx.hash,
        block: block.hash,
        block_height: block.blockNo ?? 0,
        block_time: blockTime(loc.slot, c.net),
        slot: loc.slot,
        index: tx.index,
        output_amount: sumAmounts(outs.map((o) => ({ lovelace: o.lovelace.toString(), assets: o.assets.map((a) => ({ unit: a.policy + a.name, quantity: a.qty.toString() })) }))),
        fees: fee.toString(),
        deposit: (await depositOf(tx, ins, epoch)).toString(),
        size: tx.size,
        invalid_before: tx.validFrom == null ? null : tx.validFrom.toString(),
        invalid_hereafter: tx.ttl == null ? null : tx.ttl.toString(),
        utxo_count: tx.inputs.length + tx.outputs.length,
        withdrawal_count: tx.withdrawals.length,
        mir_cert_count: tx.certs.filter((x) => x.tag === 6).length,
        delegation_count: tx.certs.filter((x) => certDelegatesPool(x.tag)).length,
        stake_cert_count: tx.certs.filter((x) => certRegisters(x.tag) || certDeregisters(x.tag)).length,
        pool_update_count: tx.certs.filter((x) => x.tag === 3).length,
        pool_retire_count: tx.certs.filter((x) => x.tag === 4).length,
        asset_mint_or_burn_count: tx.mint.length,
        redeemer_count: tx.redeemers.length,
        valid_contract: tx.valid,
        treasury_donation: tx.donation.toString(),
    };
}

const inputJson = (r: ResolvedOut | null, ref: { txHash: string; index: number }, flags: { collateral: boolean; reference: boolean }) => ({
    address: r?.address ?? "",
    amount: r ? amountOf(r.lovelace, r.assets) : amountOf("0", []),
    tx_hash: ref.txHash,
    output_index: ref.index,
    data_hash: r?.dataHash ?? null,
    inline_datum: r?.inlineDatum ?? null,
    reference_script_hash: r?.referenceScriptHash ?? null,
    collateral: flags.collateral,
    reference: flags.reference,
});

export async function txUtxos(t: TxCtx): Promise<Record<string, unknown>> {
    const { tx } = t;
    const [ins, refs, cols] = await Promise.all([resolveOutputs(tx.inputs), resolveOutputs(tx.referenceInputs), resolveOutputs(tx.collateral)]);
    const consumed = await resolveOutputs([...tx.outputs, ...(tx.collateralReturn ? [tx.collateralReturn] : [])].map((o) => ({ txHash: tx.hash, index: o.index })));
    const outJson = (o: TxFact["outputs"][number], collateral: boolean, i: number) => {
        const r = outputFactToResolved(tx.hash, o);
        return { address: r.address ?? "", amount: amountOf(r.lovelace, r.assets), output_index: o.index, data_hash: r.dataHash, inline_datum: r.inlineDatum, collateral, reference_script_hash: r.referenceScriptHash, consumed_by_tx: consumed[i]?.consumedBy ?? null };
    };
    return {
        hash: tx.hash,
        inputs: [
            ...tx.inputs.map((ref, i) => inputJson(ins[i]!, ref, { collateral: false, reference: false })),
            ...tx.referenceInputs.map((ref, i) => inputJson(refs[i]!, ref, { collateral: false, reference: true })),
            ...tx.collateral.map((ref, i) => inputJson(cols[i]!, ref, { collateral: true, reference: false })),
        ],
        outputs: [
            ...tx.outputs.map((o, i) => outJson(o, false, i)),
            ...(tx.collateralReturn ? [outJson(tx.collateralReturn, true, tx.outputs.length)] : []),
        ],
    };
}

const POOL_META_NULL = { ticker: null, name: null, description: null, homepage: null };
export function poolCertJson(cert: TxFact["certs"][number], c: Ctx, epoch: number): Record<string, unknown> {
    const p = cert.pool_params!;
    const net = (p.rewardAccount[0]! & 0x0f) === 1 ? "mainnet" : c.network;
    return {
        cert_index: cert.index,
        pool_id: poolIdBech32(p.operator),
        vrf_key: p.vrf,
        pledge: p.pledge.toString(),
        margin_cost: p.margin.den === 0n ? 0 : Number(p.margin.num) / Number(p.margin.den),
        fixed_cost: p.cost.toString(),
        reward_account: rewardAccountBech32(p.rewardAccount),
        owners: p.owners.map((o) => stakeAddressOf(o, net)),
        metadata: p.metadata ? { url: p.metadata.url, hash: p.metadata.hash, ...POOL_META_NULL } : null,
        relays: p.relays,
        active_epoch: epoch + 2,
    };
}

async function redeemersJson(t: TxCtx, c: Ctx): Promise<unknown[]> {
    const { tx, loc } = t;
    const epoch = Number(epochForSlot(loc.slot, c.net));
    const p = (await getStoredEpochParams(epoch)) ?? {};
    const pm = rationalOf(p.price_mem), ps = rationalOf(p.price_step);
    let stored = new Map<string, string | null>();
    try {
        const r = await mb`SELECT purpose, idx, script_hash FROM mb_redeemer WHERE tx_hash = ${tx.hash}`;
        stored = new Map(r.map((x) => [`${x[0]}:${x[1]}`, x[2] == null ? null : String(x[2])]));
    } catch { /* */ }
    const out: unknown[] = [];
    for (const r of [...tx.redeemers].sort((a, b) => a.index - b.index || a.tag - b.tag)) {
        const sh = stored.get(`${r.tag}:${r.index}`) ?? (await redeemerScriptHash(mbSql() as any, tx, r.tag, r.index));
        const dh = hex(blake2b_256(r.data));
        out.push({
            tx_index: r.index,
            purpose: REDEEMER_PURPOSES[r.tag] ?? "spend",
            script_hash: sh ?? "",
            redeemer_data_hash: dh,
            datum_hash: dh,
            unit_mem: r.mem.toString(),
            unit_steps: r.steps.toString(),
            fee: pm && ps ? scriptExecutionFee(r.mem, r.steps, pm, ps).toString() : "0",
        });
    }
    return out;
}

const labelSort = (a: { label: bigint }, b: { label: bigint }) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

// ------------------------------------------------------------------ mempool

async function mempoolHashes(): Promise<string[]> {
    const entries = await GlobalSharedMempool.getTxHashesAndSizes();
    return entries.map((e) => { try { return mempoolTxHashToString(e.hash).toLowerCase(); } catch { return ""; } }).filter(Boolean);
}
async function mempoolTx(hash: string): Promise<Uint8Array | null> {
    try { return await GlobalSharedMempool.getTx(Uint8Array.from(Buffer.from(hash, "hex"))); } catch { return null; }
}

// ------------------------------------------------------------------ evaluation

function encodeBytesHead(n: number): number[] {
    if (n < 24) return [0x40 | n];
    if (n < 0x100) return [0x58, n];
    if (n < 0x10000) return [0x59, n >> 8, n & 0xff];
    return [0x5a, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Body of /utils/txs/evaluate: the transaction as hex or base64 text, or raw CBOR bytes. */
async function txBytesOfBody(req: Request): Promise<Uint8Array> {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    const raw = new Uint8Array(await req.arrayBuffer());
    if (!raw.length) throw badRequest("Empty transaction body");
    if (ct.includes("json")) {
        try { const j = JSON.parse(new TextDecoder().decode(raw)); return textToBytes(String(j.cbor ?? "")); } catch { throw badRequest("Invalid JSON body"); }
    }
    if (raw[0] === 0x84 || raw[0] === 0x83) return raw;
    return textToBytes(new TextDecoder().decode(raw));
}
function textToBytes(s: string): Uint8Array {
    const t = s.trim().replace(/^"|"$/g, "");
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return Uint8Array.from(Buffer.from(t, "hex"));
    if (/^[A-Za-z0-9+/=_-]+$/.test(t)) return Uint8Array.from(Buffer.from(t, "base64"));
    throw badRequest("Transaction must be CBOR in base16 or base64");
}

const V5_PURPOSE = ["spend", "mint", "certificate", "withdrawal", "vote", "propose"];
const V6_PURPOSE = ["spend", "mint", "publish", "withdraw", "vote", "propose"];

/** Ogmios-style `additionalUtxoSet` entry → a resolved output. */
function additionalUtxo(entry: any): [string, ResolvedUtxo] | null {
    try {
        const [i, o] = entry as [any, any];
        const ref = `${String(i.txId ?? i.transaction?.id).toLowerCase()}:${Number(i.index)}`;
        const value: Record<string, unknown> = o.value ?? {};
        const coins = String((value as any).coins ?? (value as any).ada?.lovelace ?? 0);
        const assets: Record<string, Record<string, string>> = {};
        // asset keys: "policy.name" (Ogmios v5) or "policyname"
        for (const [k, v] of Object.entries((value as any).assets ?? {})) {
            const dot = k.indexOf(".");
            const policy = dot >= 0 ? k.slice(0, dot) : k.slice(0, 56), name = dot >= 0 ? k.slice(dot + 1) : k.slice(56);
            (assets[policy.toLowerCase()] ??= {})[name.toLowerCase()] = String(v);
        }
        // Ogmios v5: { "plutus:v2": "<hex>" } (or a raw `[lang, bytes]` CBOR hex string)
        let script: string | null = typeof o.script === "string" ? o.script : null;
        let scriptHashHex: string | null = null;
        if (o.script && typeof o.script === "object") {
            const [k, v] = Object.entries(o.script as Record<string, string>)[0] ?? [];
            const lang = k === "plutus:v1" ? 1 : k === "plutus:v2" ? 2 : k === "plutus:v3" ? 3 : 0;
            if (lang && typeof v === "string") {
                script = Buffer.from([0x82, lang, ...encodeBytesHead(v.length / 2), ...Buffer.from(v, "hex")]).toString("hex");
                scriptHashHex = scriptHash((["timelock", "plutusV1", "plutusV2", "plutusV3"] as const)[lang]!, Uint8Array.from(Buffer.from(v, "hex")));
            }
        }
        const txOut = JSON.stringify({ address: o.address, amount: coins, assets, ...(o.datumHash || o.datum_hash ? { datum_hash: o.datumHash ?? o.datum_hash } : {}), ...(o.datum ? { inline_datum: o.datum } : {}), ...(script ? { reference_script_cbor: script } : {}) });
        return [ref, resolvedFromRow({ utxo_ref: ref, address: o.address, tx_out: txOut, reference_script_hash: scriptHashHex })];
    } catch { return null; }
}

async function evaluate(c: Ctx, txBytes: Uint8Array, extra: Map<string, ResolvedUtxo>): Promise<Response> {
    let tx: TxFact;
    try { tx = txFactsOfCbor(txBytes); } catch (e: any) { throw badRequest(`Transaction CBOR could not be decoded: ${e?.message ?? e}`); }
    const resolved = new Map(extra);
    const ur = ledger()?.utxo ?? ledgerUtxoReads();
    for (const r of [...tx.inputs, ...tx.referenceInputs, ...tx.collateral]) {
        const k = `${r.txHash}:${r.index}`;
        if (resolved.has(k)) continue;
        const u = ur?.get(k);
        if (u) resolved.set(k, resolvedFromRow({ utxo_ref: k, address: u.address, tx_out: u.tx_out, reference_script_hash: u.reference_script_hash }));
    }
    const epoch = await currentEpoch(c.net);
    const raw = await getStoredEpochParams(epoch);
    const params = raw ? epochParamsFromRecord(epoch, raw) : null;
    const budget = { mem: BigInt(String(raw?.max_tx_ex_mem ?? 14_000_000)), cpu: BigInt(String(raw?.max_tx_ex_steps ?? 10_000_000_000)) };
    const r = evaluatePhase2Sync({ era: 7, bodyBytes: tx.body, witnessSetBytes: tx.witness, resolved, params, markedInvalid: false, budget, network: c.network, traces: true });
    const v6 = c.url.searchParams.get("version") === "6";
    const key = (tag: number, index: number) => `${V5_PURPOSE[tag] ?? "spend"}:${index}`;
    if (v6) {
        if (r.error || !r.ok) {
            return json({ jsonrpc: "2.0", method: "evaluateTransaction", error: { code: 3010, message: r.error ?? "Some scripts of the transactions terminated with error(s).", data: r.redeemers.filter((x) => !x.ok).map((x) => ({ validator: { purpose: V6_PURPOSE[x.tag], index: x.index }, error: { code: 3012, message: x.reason ?? "validator failed", data: { traces: x.logs ?? [] } } })) }, id: null });
        }
        return json({ jsonrpc: "2.0", method: "evaluateTransaction", result: r.redeemers.map((x) => ({ validator: { purpose: V6_PURPOSE[x.tag], index: x.index }, budget: { memory: Number(x.spent?.mem ?? 0n), cpu: Number(x.spent?.cpu ?? 0n) } })), id: null });
    }
    const base = { type: "jsonwsp/response", version: "1.0", servicename: "ogmios", methodname: "EvaluateTx", reflection: { id: crypto.randomUUID() } };
    if (r.error) return json({ ...base, result: { EvaluationFailure: { CannotCreateEvaluationContext: { reason: r.error } } } });
    if (!r.ok) return json({ ...base, result: { EvaluationFailure: { ScriptFailures: Object.fromEntries(r.redeemers.filter((x) => !x.ok).map((x) => [key(x.tag, x.index), [{ validatorFailed: { error: x.reason ?? "validator failed", traces: x.logs ?? [] } }]])) } } });
    return json({ ...base, result: { EvaluationResult: Object.fromEntries(r.redeemers.map((x) => [key(x.tag, x.index), { memory: Number(x.spent?.mem ?? 0n), steps: Number(x.spent?.cpu ?? 0n) }])) } });
}

// ------------------------------------------------------------------ submit

async function submit(c: Ctx): Promise<Response> {
    if (!c.submitTx) return bfError(503, "Service Unavailable", "Tx submit not available (no peer manager)");
    const ct = (c.req.headers.get("content-type") || "").toLowerCase();
    let txCbor: Uint8Array;
    if (ct.includes("application/cbor") || ct.includes("octet-stream")) txCbor = new Uint8Array(await c.req.arrayBuffer());
    else {
        const text = (await c.req.text()).trim();
        if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) txCbor = Uint8Array.from(Buffer.from(text, "hex"));
        else txCbor = new Uint8Array(Buffer.from(text, "utf8"));
    }
    if (txCbor.length === 0) return bfError(400, "Bad Request", "Empty transaction body");
    let txId: Uint8Array;
    try {
        const f = txFactsOfCbor(txCbor);
        txId = Uint8Array.from(Buffer.from(f.hash, "hex"));
    } catch (e: any) {
        return bfError(400, "Bad Request", `Transaction CBOR could not be decoded: ${e?.message ?? String(e)}`);
    }
    let result;
    try { result = await c.submitTx(txCbor, txId); } catch (e: any) { return bfError(503, "Service Unavailable", e?.message ?? "submit failed"); }
    // shared-cardano-mempool-ts MempoolAppendStatus: 0 Ok, 1 AlreadyPresent, 2 InsufficientSpace, 3 MaxTxsReached
    if (result.status !== "success" && result.status !== "0" && result.status !== "1") {
        const why = result.status === "2" ? "insufficient space" : result.status === "3" ? "max transactions reached" : result.status;
        return bfError(400, "Bad Request", `Mempool rejected the transaction: ${why}`);
    }
    // Blockfrost: 200 with the transaction id as a JSON string; the mempool verdict rides in headers
    return json(hex(txId), 200, { "X-Gerolamo-Mempool-Status": String(result.status), "X-Gerolamo-Mempool-Txs": String(result.nTxs), "X-Gerolamo-Mempool-Space": String(result.availableSpace) });
}

const ctxOf = (c: Ctx) => txContext(c.params.hash!.toLowerCase());

export const txRoutes: Route[] = [
    route("GET", "/txs/{hash}", async (c) => bfTx(await ctxOf(c), c)),
    route("GET", "/txs/{hash}/utxos", async (c) => txUtxos(await ctxOf(c))),
    route("GET", "/txs/{hash}/stakes", async (c) => {
        const { tx } = await ctxOf(c);
        return tx.certs.filter((x) => (certRegisters(x.tag) || certDeregisters(x.tag)) && x.stake).map((x) => ({ cert_index: x.index, address: stakeAddressOf(x.stake!, c.network), registration: certRegisters(x.tag) }));
    }),
    route("GET", "/txs/{hash}/delegations", async (c) => {
        const t = await ctxOf(c);
        const epoch = Number(epochForSlot(t.loc.slot, c.net));
        return t.tx.certs.filter((x) => certDelegatesPool(x.tag) && x.stake && x.pool).map((x, i) => ({ index: i, cert_index: x.index, address: stakeAddressOf(x.stake!, c.network), pool_id: poolIdBech32(x.pool!), active_epoch: epoch + 2 }));
    }),
    route("GET", "/txs/{hash}/withdrawals", async (c) => (await ctxOf(c)).tx.withdrawals.map((w) => ({ address: rewardAccountBech32(w.rewardAccount), amount: w.amount.toString() }))),
    route("GET", "/txs/{hash}/mirs", async (c) => {
        const { tx } = await ctxOf(c);
        return tx.certs.filter((x) => x.mir).flatMap((x) => x.mir!.to.map((m) => ({ pot: x.mir!.pot, cert_index: x.index, address: stakeAddressOf(m.stake, c.network), amount: m.amount.toString() })));
    }),
    route("GET", "/txs/{hash}/pool_updates", async (c) => {
        const t = await ctxOf(c);
        const epoch = Number(epochForSlot(t.loc.slot, c.net));
        return t.tx.certs.filter((x) => x.tag === 3 && x.pool_params).map((x) => poolCertJson(x, c, epoch));
    }),
    route("GET", "/txs/{hash}/pool_retires", async (c) => (await ctxOf(c)).tx.certs.filter((x) => x.tag === 4).map((x) => ({ cert_index: x.index, pool_id: poolIdBech32(x.pool!), retiring_epoch: x.retire_epoch! }))),
    route("GET", "/txs/{hash}/metadata", async (c) => [...(await ctxOf(c)).tx.metadata].sort(labelSort).map((m) => ({ label: m.label.toString(), json_metadata: metadataJson(m.value) }))),
    route("GET", "/txs/{hash}/metadata/cbor", async (c) => [...(await ctxOf(c)).tx.metadata].sort(labelSort).map((m) => ({ label: m.label.toString(), cbor_metadata: "\\x" + hex(m.value), metadata: hex(m.value) }))),
    route("GET", "/txs/{hash}/redeemers", async (c) => redeemersJson(await ctxOf(c), c)),
    route("GET", "/txs/{hash}/required_signers", async (c) => (await ctxOf(c)).tx.requiredSigners.map((h) => ({ witness_hash: h }))),
    route("GET", "/txs/{hash}/cbor", async (c) => { const t = await ctxOf(c); return { cbor: hex(txCbor(t.tx, t.facts.era)) }; }),
    route("POST", "/tx/submit", submit),

    route("GET", "/mempool", async (c) => pageOf((await mempoolHashes()).map((tx_hash) => ({ tx_hash })), paging(c.url))),
    route("GET", "/mempool/txs", async () => {
        // Gerolamo extension: the local mempool with sizes (the desktop app reads it)
        const entries = await GlobalSharedMempool.getTxHashesAndSizes();
        const txs = entries.map((e) => { let h = ""; try { h = mempoolTxHashToString(e.hash); } catch { h = ""; } return { tx_hash: h, size: e.size }; });
        return { count: txs.length, txs, note: "Local SharedMempool snapshot" };
    }),
    route("GET", "/mempool/{hash}", async (c) => {
        const h = c.params.hash!.toLowerCase();
        if (!isHex64(h)) throw notFound();
        const bytes = await mempoolTx(h);
        if (!bytes) throw notFound();
        const tx = txFactsOfCbor(bytes);
        const ins = await resolveOutputs(tx.inputs);
        const outs = tx.outputs;
        return {
            tx: {
                hash: tx.hash,
                output_amount: sumAmounts(outs.map((o) => ({ lovelace: o.lovelace.toString(), assets: o.assets.map((a) => ({ unit: a.policy + a.name, quantity: a.qty.toString() })) }))),
                fees: tx.fee.toString(),
                deposit: (await depositOf(tx, ins, await currentEpoch(c.net))).toString(),
                size: bytes.length,
                invalid_before: tx.validFrom == null ? null : tx.validFrom.toString(),
                invalid_hereafter: tx.ttl == null ? null : tx.ttl.toString(),
                utxo_count: tx.inputs.length + tx.outputs.length,
                withdrawal_count: tx.withdrawals.length,
                mir_cert_count: tx.certs.filter((x) => x.tag === 6).length,
                delegation_count: tx.certs.filter((x) => certDelegatesPool(x.tag)).length,
                stake_cert_count: tx.certs.filter((x) => certRegisters(x.tag) || certDeregisters(x.tag)).length,
                pool_update_count: tx.certs.filter((x) => x.tag === 3).length,
                pool_retire_count: tx.certs.filter((x) => x.tag === 4).length,
                asset_mint_or_burn_count: tx.mint.length,
                redeemer_count: tx.redeemers.length,
                valid_contract: tx.valid,
            },
            inputs: [
                ...tx.inputs.map((r, i) => ({ address: ins[i]?.address ?? undefined, tx_hash: r.txHash, output_index: r.index, collateral: false, reference: false })),
                ...tx.referenceInputs.map((r) => ({ tx_hash: r.txHash, output_index: r.index, collateral: false, reference: true })),
                ...tx.collateral.map((r) => ({ tx_hash: r.txHash, output_index: r.index, collateral: true, reference: false })),
            ],
            outputs: outs.map((o) => { const r = outputFactToResolved(tx.hash, o); return { address: r.address ?? "", amount: amountOf(r.lovelace, r.assets), output_index: o.index, data_hash: r.dataHash, inline_datum: r.inlineDatum, collateral: false, reference_script_hash: r.referenceScriptHash }; }),
            redeemers: tx.redeemers.map((r) => ({ tx_index: r.index, purpose: REDEEMER_PURPOSES[r.tag] ?? "spend", unit_mem: r.mem.toString(), unit_steps: r.steps.toString() })),
        };
    }),
    route("GET", "/mempool/addresses/{address}", async (c) => {
        const want = c.params.address!;
        const out: Array<{ tx_hash: string }> = [];
        for (const h of await mempoolHashes()) {
            const bytes = await mempoolTx(h);
            if (!bytes) continue;
            let tx: TxFact;
            try { tx = txFactsOfCbor(bytes); } catch { continue; }
            const ins = await resolveOutputs(tx.inputs);
            if (tx.outputs.some((o) => o.address === want) || ins.some((i) => i?.address === want)) out.push({ tx_hash: h });
        }
        return pageOf(out, paging(c.url));
    }),

    route("GET", "/utils/addresses/xpub/{xpub}/{role}/{index}", async (c) => {
        const x = parseXPub(c.params.xpub!);
        if (!x) throw badRequest("Invalid or malformed xpub format. Has to be hex of length 128.");
        const uint = (v: string, what: string) => { if (!/^\d+$/.test(v) || Number(v) >= 0x80000000) throw badRequest(`Missing, out of range or malformed ${what}.`); return Number(v); };
        const role = uint(c.params.role!, "role"), index = uint(c.params.index!, "index");
        return { xpub: c.params.xpub!, role, index, address: deriveAddress(x, role, index, c.network === "mainnet") };
    }),
    route("POST", "/utils/txs/evaluate", async (c) => evaluate(c, await txBytesOfBody(c.req), new Map())),
    route("POST", "/utils/txs/evaluate/utxos", async (c) => {
        let body: any;
        try { body = await c.req.json(); } catch { throw badRequest("Invalid JSON body"); }
        const extra = new Map<string, ResolvedUtxo>();
        for (const e of Array.isArray(body?.additionalUtxoSet) ? body.additionalUtxoSet : []) { const r = additionalUtxo(e); if (r) extra.set(r[0], r[1]); }
        return evaluate(c, textToBytes(String(body?.cbor ?? "")), extra);
    }),
];
void HttpError;

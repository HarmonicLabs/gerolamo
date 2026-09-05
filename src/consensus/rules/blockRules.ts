/**
 * Block-level driver for the transaction rules: resolves every input the block
 * spends in one query, verifies every witness signature in one pool job, then
 * evaluates the era's rules per transaction.
 */
import { MultiEraBlock, ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { effectiveRedeemers } from "./alonzoRules";
import { outputAddressString } from "../../utils/byronAddressString";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { readFileSync } from "node:fs";
import { getUtxoRowsByRefs, registeredPools, rewardBalancesFor } from "../../db/rulesQueries";
import { typedCredHexOf } from "../../db/stakeCred";
import { getByronTxPayloads, isByronBlock } from "../../utils/eraAccessors";
import type { EpochBodyParams } from "../epochParams";
import type { ValidationPool } from "../workers/ValidationPool";
import { runWitnessVerifyJob, type WitnessItem } from "../workers/witnessJob";
import { evaluateByronTxRules } from "./byronTxRules";
import { resolvedFromRow, utxoRefOf, type ResolvedUtxo } from "./resolvedUtxo";
import { parseStoredAddress } from "./requiredSigners";
import { evaluateAlonzoRules } from "./alonzoRules";
import { extractLedgerTxOutMetadata } from "../../db/minibf/txOutMetadata";
import { evaluateTxRules, type TxRuleParams } from "./txRules";
import { unitsOf } from "./value";
import { collectByronWitnesses, collectShelleyWitnesses } from "./witnesses";
import { shadowEvaluateTx } from "./plutusEval";

export interface BlockRuleContext {
    config: any;
    pool: ValidationPool | null;
    params: EpochBodyParams | null;
    genesis: any;
    slot: bigint;
}

export interface BlockRuleOutcome {
    failures: string[];
    reports: string[];
    txs: number;
    witnessesVerified: number;
    /** Phase-2 shadow evaluation counters. */
    plutus: { evaluated: number; skipped: number; mismatches: number; skipReasons: Record<string, number> };
}

const big = (v: unknown, fallback: bigint): bigint => {
    if (v == null) return fallback;
    try {
        return BigInt(String(v));
    } catch {
        return fallback;
    }
};
const numOrNull = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Transaction size for the minimum-fee rule: array header + body + witness set
 * + auxiliary data (or the null byte). From Alonzo on the serialised tx also
 * carries the `isValid` flag, but the ledger's fee size excludes that byte
 * (gouroboros `TxSizeForFee`: full size − 1 for 4-element txs). Checked
 * against a real preprod Alonzo tx: 337 + 811 + none → 1150, fee = 44·1150 + 155381.
 */
export function feeSizeBytes(bodyLen: number, witLen: number, auxLen: number): number {
    return 1 + bodyLen + witLen + auxLen;
}

/** Byte length of an original CBOR slice, when the object kept one. */
function sliceLength(obj: any): number | null {
    const ref = obj?.cborRef;
    if (!ref) return null;
    try {
        if (typeof ref.toBuffer === "function") return ref.toBuffer().length;
        if (typeof ref.length === "number") return ref.length;
        if (typeof ref.end === "number" && typeof ref.start === "number") return ref.end - ref.start;
    } catch {
        /* */
    }
    return null;
}

export function ruleParams(params: EpochBodyParams | null, genesis: any, era: number, network: string): TxRuleParams {
    const raw = params?.raw ?? {};
    const pp = genesis?.protocolParams ?? {};
    const babbage = era >= 6;
    return {
        minFeeA: params?.minFeeA ?? big(pp.minFeeA, 44n),
        minFeeB: params?.minFeeB ?? big(pp.minFeeB, 155381n),
        keyDeposit: big(raw.key_deposit, big(pp.keyDeposit, 2_000_000n)),
        poolDeposit: big(raw.pool_deposit, big(pp.poolDeposit, 500_000_000n)),
        maxTxSize: params?.maxTxSize ?? Number(pp.maxTxSize ?? 16384),
        minUtxoValue: babbage || era === 5 ? null : big(raw.min_utxo, big(pp.minUTxOValue, 1_000_000n)),
        coinsPerUtxoWord: era === 5 ? big(raw.coins_per_utxo_word ?? raw.coins_per_utxo_size, 34482n) : null,
        coinsPerUtxoByte: babbage ? big(raw.coins_per_utxo_size ?? raw.coins_per_utxo_word, 4310n) : null,
        minFeeRefScriptCostPerByte: era >= 7 ? numOrNull(raw.min_fee_ref_script_cost_per_byte) : null,
        raw,
        priceMem: era >= 5 ? numOrNull(raw.price_mem) : null,
        priceStep: era >= 5 ? numOrNull(raw.price_step) : null,
        network: network === "mainnet" ? "mainnet" : "testnet",
        collateralPercent: params?.collateralPercent ?? 150,
        maxCollateralInputs: params?.maxCollateralInputs ?? null,
        maxTxExMem: raw.max_tx_ex_mem != null ? big(raw.max_tx_ex_mem, 0n) : null,
        maxTxExSteps: raw.max_tx_ex_steps != null ? big(raw.max_tx_ex_steps, 0n) : null,
    };
}

async function verifyItems(pool: ValidationPool | null, items: WitnessItem[]): Promise<boolean[]> {
    if (items.length === 0) return [];
    if (pool) return (await pool.verifyWitnesses({ kind: "witnesses", items })).ok;
    return runWitnessVerifyJob({ kind: "witnesses", items }).ok;
}

/** Address as stored: base58 for Byron addresses, bech32 for Shelley ones. */
function addressString(a: any): string {
    return outputAddressString(a);
}

/**
 * Transactions in a block are applied in order: a later tx may spend an earlier
 * one's output, and a spent input is gone for the rest of the block. Mirror that
 * on the resolved map after each tx.
 */
type OutputLike = { address: string; value: Map<string, bigint>; referenceScriptHash?: string | null; referenceScriptCbor?: string | null; hasDatum?: boolean; datumHash?: string | null; inlineDatumCbor?: string | null };

/** Everything a later transaction in the same block may need from an output created by an earlier one. */
function outputLike(o: any): OutputLike {
    const meta = extractLedgerTxOutMetadata(o);
    return {
        address: addressString(o.address),
        value: unitsOf(o.value),
        referenceScriptHash: meta.scriptRefHash ?? o.refScript?.hash?.toString?.()?.toLowerCase() ?? null,
        referenceScriptCbor: meta.scriptRefCbor,
        hasDatum: o.datum != null || !!meta.datumHash || !!meta.inlineDatumCbor,
        datumHash: meta.datumHash,
        inlineDatumCbor: meta.inlineDatumCbor,
    };
}

function advanceResolved(resolved: Map<string, ResolvedUtxo>, txHashHex: string, inputs: any[], outputs: OutputLike[], firstIndex = 0, extra: OutputLike[] = []): void {
    for (const i of inputs) {
        const r = utxoRefOf(i);
        if (r) resolved.delete(r);
    }
    [...outputs, ...extra].forEach((o, idx) => {
        const ref = `${txHashHex}:${firstIndex + idx}`;
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    });
}

async function resolveInputs(refs: Set<string>): Promise<Map<string, ResolvedUtxo>> {
    const map = new Map<string, ResolvedUtxo>();
    if (refs.size === 0) return map;
    for (const row of await getUtxoRowsByRefs([...refs])) map.set(row.utxo_ref, resolvedFromRow(row));
    return map;
}

let byronFeePolicy: { file: string; policy: { summand: bigint; multiplier: bigint } | null } | null = null;
function byronFeePolicyFor(config: any): { summand: bigint; multiplier: bigint } | null {
    const file = String(config?.byronGenesisFile ?? "");
    if (!file) return null;
    if (byronFeePolicy?.file === file) return byronFeePolicy.policy;
    let policy: { summand: bigint; multiplier: bigint } | null = null;
    try {
        const g = JSON.parse(readFileSync(file, "utf8"));
        const p = g?.blockVersionData?.txFeePolicy;
        if (p?.summand != null && p?.multiplier != null) policy = { summand: BigInt(String(p.summand)), multiplier: BigInt(String(p.multiplier)) };
    } catch {
        policy = null;
    }
    byronFeePolicy = { file, policy };
    return policy;
}

export async function evaluateBlockRules(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    if (isByronBlock(block.block as any)) return evaluateByronBlock(block, ctx);
    return evaluateShelleyBlock(block, ctx);
}

async function evaluateShelleyBlock(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    const b: any = block.block;
    const bodies: any[] = b.transactionBodies ?? [];
    const wits: any[] = b.transactionWitnessSets ?? [];
    const aux: Record<number, any> = b.auxiliaryDataSet ?? {};
    const invalid = new Set<number>((b.invalidTransactions ?? []).map((i: number | bigint) => Number(i)));
    const out: BlockRuleOutcome = { failures: [], reports: [], txs: bodies.length, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    if (bodies.length === 0) return out;

    // 1. resolve every input, collateral and reference input in one query
    const refs = new Set<string>();
    const poolIds: string[] = [];
    for (const body of bodies) {
        for (const list of [body.inputs, body.collateralInputs, body.refInputs] as any[][]) {
            for (const i of list ?? []) {
                const r = utxoRefOf(i);
                if (r) refs.add(r);
            }
        }
        for (const c of (body.certs ?? []) as any[]) {
            if (Number(c.certType) === 3) poolIds.push(String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase());
        }
    }
    const wdCreds: string[] = [];
    for (const body of bodies) for (const w of (body.withdrawals?.map ?? []) as any[]) {
        const c = typedCredHexOf(w.rewardAccount?.credentials) ?? String((w.rewardAccount?.credentials?.hash ?? w.rewardAccount?.credentials)?.toString?.() ?? "").toLowerCase();
        if (c) wdCreds.push(c);
    }
    const [resolved, pools, rewardBalances] = await Promise.all([resolveInputs(refs), registeredPools(poolIds), rewardBalancesFor(wdCreds)]);

    // 2. every witness signature in one pool job
    const items: WitnessItem[] = [];
    const perTx: Array<{ start: number; proves: Array<{ kind: "key" | "root"; hash: string }>; problems: string[] }> = [];
    for (let i = 0; i < bodies.length; i++) {
        const bodyHashHex = String(bodies[i].hash?.toString?.() ?? "");
        const bodyHash = bodyHashHex ? fromHex(bodyHashHex) : blake2b_256(bodies[i].toCborBytes());
        const c = collectShelleyWitnesses(bodyHash, wits[i]);
        perTx.push({ start: items.length, proves: c.proves, problems: c.problems });
        items.push(...c.items);
    }
    const ok = await verifyItems(ctx.pool, items);
    out.witnessesVerified = items.length;

    // 3. rules per transaction
    const params = ruleParams(ctx.params, ctx.genesis, block.era, String(ctx.config?.network ?? "mainnet"));
    let blockMem = 0n, blockSteps = 0n;
    for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        const w = perTx[i]!;
        const provenKeys = new Set<string>();
        const provenRoots = new Set<string>();
        for (let k = 0; k < w.proves.length; k++) {
            if (!ok[w.start + k]) {
                out.failures.push(`tx[${i}]: ${w.proves[k]!.kind === "key" ? "vkey" : "bootstrap"} witness ${w.proves[k]!.hash.slice(0, 12)}… has an invalid signature`);
                continue;
            }
            (w.proves[k]!.kind === "key" ? provenKeys : provenRoots).add(w.proves[k]!.hash);
        }
        for (const p of w.problems) out.failures.push(`tx[${i}]: ${p}`);
        if (invalid.has(i)) {
            // Phase-2 failure marked by the block producer: the collateral is consumed
            // (and the collateral return produced) instead of the inputs and outputs.
            const a = evaluateAlonzoRules({ era: block.era, collateralOnly: true, body, witnessSet: wits[i], resolved, plutusScripts: new Set(), nativeScripts: new Set(), params });
            for (const f of a.failures) out.failures.push(`tx[${i}]: ${f}`);
            const txHashHex = String(body.hash?.toString?.() ?? "").toLowerCase();
            if (txHashHex) {
                const ret = body.collateralReturn;
                advanceResolved(resolved, txHashHex, [...(body.collateralInputs ?? [])], [], (body.outputs ?? []).length, ret ? [outputLike(ret)] : []);
            }
            continue;
        }
        const bodyLen = sliceLength(body), witLen = sliceLength(wits[i]);
        const auxLen = aux[i] ? sliceLength(aux[i]) : 1;
        const txSizeBytes = bodyLen != null && witLen != null && auxLen != null ? feeSizeBytes(bodyLen, witLen, auxLen) : null;
        const r = evaluateTxRules({
            era: block.era,
            body,
            witnessSet: wits[i],
            slot: ctx.slot,
            resolved,
            provenKeys,
            provenRoots,
            isPoolRegistered: (p) => pools.has(p.toLowerCase()),
            params,
            txSizeBytes,
            rewardBalances,
        });
        for (const f of r.failures) out.failures.push(`tx[${i}]: ${f}`);
        for (const f of r.reports) out.reports.push(`tx[${i}]: ${f}`);
        for (const rd of effectiveRedeemers((wits[i]?.redeemers ?? []) as any[], Number(block.era))) {
            blockMem += BigInt(rd.execUnits?.mem ?? 0);
            blockSteps += BigInt(rd.execUnits?.steps ?? rd.execUnits?.cpu ?? 0);
        }
        // Phase-2 shadow: run the scripts and compare with the block's verdict (never halts).
        if (block.era >= 5 && r.failures.length === 0 && ((wits[i]?.redeemers ?? []) as any[]).length > 0) {
            try {
                const ev = await shadowEvaluateTx({ era: block.era, body, witnessSet: wits[i], bodyBytes: body.cborRef?.toBuffer?.() ?? null, witnessSetBytes: wits[i]?.cborRef?.toBuffer?.() ?? null, resolved, params: ctx.params, genesis: ctx.genesis, network: String(ctx.config?.network ?? "mainnet"), markedInvalid: invalid.has(i) });
                out.plutus.evaluated += ev.evaluated;
                out.plutus.skipped += ev.skipped;
                if (ev.mismatch) {
                    out.plutus.mismatches++;
                    out.reports.push(`tx[${i}]: plutus shadow: ${ev.mismatch}`);
                    const key = ev.mismatch.replace(/[0-9a-f]{12,}…?/g, "X").replace(/\d+/g, "N").slice(0, 80);
                    out.plutus.skipReasons[key] = (out.plutus.skipReasons[key] ?? 0) + 1;
                }
            } catch (err) {
                out.plutus.skipped++;
                out.reports.push(`tx[${i}]: plutus shadow skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const txHashHex = String(body.hash?.toString?.() ?? "").toLowerCase();
        if (txHashHex) {
            advanceResolved(resolved, txHashHex, [...(body.inputs ?? [])], ((body.outputs ?? []) as any[]).map(outputLike));
        }
    }
    const raw = ctx.params?.raw ?? {};
    const maxBlockMem = raw.max_block_ex_mem != null ? big(raw.max_block_ex_mem, 0n) : null;
    const maxBlockSteps = raw.max_block_ex_steps != null ? big(raw.max_block_ex_steps, 0n) : null;
    if (maxBlockMem != null && maxBlockMem > 0n && blockMem > maxBlockMem) out.failures.push(`block execution memory ${blockMem} > max ${maxBlockMem}`);
    if (maxBlockSteps != null && maxBlockSteps > 0n && blockSteps > maxBlockSteps) out.failures.push(`block execution steps ${blockSteps} > max ${maxBlockSteps}`);
    return out;
}

async function evaluateByronBlock(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    const entries = getByronTxPayloads(block.block as any);
    const out: BlockRuleOutcome = { failures: [], reports: [], txs: entries.length, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    if (entries.length === 0) return out;
    const magic = Number(ctx.config?.networkMagic);
    const feePolicy = byronFeePolicyFor(ctx.config);

    const refs = new Set<string>();
    const txs: Array<{ tx: any; witnesses: any[]; hash: Uint8Array; refs: string[] }> = [];
    for (const e of entries) {
        const tx = e?.tx ?? e;
        const witnesses: any[] = e?.witnesses ?? [];
        let hash: Uint8Array;
        try {
            hash = blake2b_256(tx.toCborBytes());
        } catch {
            out.failures.push("byron tx: cannot serialise for hashing");
            continue;
        }
        const list: string[] = [];
        for (const i of (tx.inputs ?? []) as any[]) {
            const r = utxoRefOf(i);
            if (r) {
                refs.add(r);
                list.push(r);
            }
        }
        txs.push({ tx, witnesses, hash, refs: list });
    }
    const resolved = await resolveInputs(refs);
    // Same-block chaining: an input may be an earlier tx's output. Seed those
    // outputs up front (address + value) so witness roots can be matched, then
    // the per-tx pass below removes spent inputs as it goes.
    for (const t of txs) {
        for (let idx = 0; idx < (t.tx.outputs ?? []).length; idx++) {
            const o = t.tx.outputs[idx];
            const ref = `${toHex(t.hash)}:${idx}`;
            if (!resolved.has(ref)) resolved.set(ref, { ref, address: addressString(o.address), value: new Map([["lovelace", BigInt(o.amount ?? 0)]]), referenceScriptHash: null, hasDatum: false });
        }
    }

    const items: WitnessItem[] = [];
    const checks = txs.map((t) => {
        const inputs = t.refs.map((ref) => {
            const u = resolved.get(ref);
            const a = u ? parseStoredAddress(u.address) : null;
            return { ref, address: a instanceof ByronAddress ? a : null };
        });
        const c = collectByronWitnesses(t.hash, t.witnesses, inputs, magic);
        const start = items.length;
        items.push(...c.items);
        return { c, start };
    });
    const ok = await verifyItems(ctx.pool, items);
    out.witnessesVerified = items.length;

    for (let i = 0; i < txs.length; i++) {
        const t = txs[i]!;
        const { c, start } = checks[i]!;
        const r = evaluateByronTxRules({
            txHashHex: toHex(t.hash),
            inputs: t.tx.inputs ?? [],
            outputs: t.tx.outputs ?? [],
            resolved,
            witnesses: c,
            witnessOk: ok.slice(start, start + c.items.length),
            witnessTypes: c.types,
            feePolicy,
            txSizeBytes: (() => { try { return t.tx.toCborBytes().length; } catch { return null; } })(),
        });
        for (const f of r.failures) out.failures.push(`tx[${i}] ${toHex(t.hash).slice(0, 12)}…: ${f}`);
        for (const f of r.reports) out.reports.push(`tx[${i}]: ${f}`);
        advanceResolved(resolved, toHex(t.hash), t.tx.inputs ?? [], ((t.tx.outputs ?? []) as any[]).map((o) => ({
            address: addressString(o.address),
            value: new Map([["lovelace", BigInt(o.amount ?? 0)]]),
        })));
    }
    return out;
}

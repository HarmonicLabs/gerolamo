/**
 * Pure part of the Shelley+ block rules: everything that needs no database once
 * the block's inputs are resolved (`BlockRuleInputs`). Kept free of `../../sql`
 * and `../../db/rulesQueries` so it can run inside validation workers (the SQL
 * module opens the live database at import time).
 *
 * Entry points: `evaluateShelleyBlockWithInputs` (the rules), `shelleyBlockReads`
 * (what a block reads), `shelleyBlockOverlay` / `applyOverlay` (evaluate block
 * N+1 before block N is applied).
 */
import type { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { effectiveRedeemers, evaluateAlonzoRules } from "./alonzoRules";
import { outputAddressString } from "../../utils/byronAddressString";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { typedCredHexOf } from "../../db/stakeCred";
import type { EpochBodyParams } from "../epochParams";
import type { UtxoRow } from "../../db/rulesQueries";
import type { ValidationPool } from "../workers/ValidationPool";
import { runWitnessVerifyJob, type WitnessItem } from "../workers/witnessJob";
import { utxoRefOf, type ResolvedUtxo } from "./resolvedUtxo";
import { extractLedgerTxOutMetadata } from "../../db/minibf/txOutMetadata";
import { evaluateTxRules, type TxRuleParams } from "./txRules";
import { unitsOf } from "./value";
import { collectShelleyWitnesses } from "./witnesses";
import { shadowEvaluateTx } from "./plutusEval";

export interface BlockRuleContext {
    config: any;
    pool: ValidationPool | null;
    params: EpochBodyParams | null;
    genesis: any;
    slot: bigint;
    /** Witness verdicts computed ahead of time by a worker (same items, same order); used when the count agrees. */
    preVerified?: boolean[] | null;
    /**
     * "rules": witnesses and ledger rules only (the applier waits on this); "shadow": only
     * the Plutus shadow evaluation (fire-and-forget on a general worker; a 100 ms script
     * budget held the applier for ~120 ms on 2 % of blocks); "both" (default): inline path.
     */
    phase?: "rules" | "shadow" | "both";
}

export interface BlockRuleOutcome {
    failures: string[];
    reports: string[];
    txs: number;
    witnessesVerified: number;
    /** Phase-2 shadow evaluation counters. */
    plutus: { evaluated: number; skipped: number; mismatches: number; skipReasons: Record<string, number> };
}

export const big = (v: unknown, fallback: bigint): bigint => {
    if (v == null) return fallback;
    try {
        return BigInt(String(v));
    } catch {
        return fallback;
    }
};
export const numOrNull = (v: unknown): number | null => {
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
export function sliceLength(obj: any): number | null {
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

export async function verifyItems(pool: ValidationPool | null, items: WitnessItem[]): Promise<boolean[]> {
    if (items.length === 0) return [];
    if (pool) return (await pool.verifyWitnesses({ kind: "witnesses", items })).ok;
    return runWitnessVerifyJob({ kind: "witnesses", items }).ok;
}

/** Address as stored: base58 for Byron addresses, bech32 for Shelley ones. */
export function addressString(a: any): string {
    return outputAddressString(a);
}

/**
 * Transactions in a block are applied in order: a later tx may spend an earlier
 * one's output, and a spent input is gone for the rest of the block. Mirror that
 * on the resolved map after each tx.
 */
export type OutputLike = { address: string; value: Map<string, bigint>; referenceScriptHash?: string | null; referenceScriptCbor?: string | null; hasDatum?: boolean; datumHash?: string | null; inlineDatumCbor?: string | null };

/** Everything a later transaction in the same block may need from an output created by an earlier one. */
export function outputLike(o: any): OutputLike {
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

export function advanceResolved(resolved: Map<string, ResolvedUtxo>, txHashHex: string, inputs: any[], outputs: OutputLike[], firstIndex = 0, extra: OutputLike[] = []): void {
    for (const i of inputs) {
        const r = utxoRefOf(i);
        if (r) resolved.delete(r);
    }
    [...outputs, ...extra].forEach((o, idx) => {
        const ref = `${txHashHex}:${firstIndex + idx}`;
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    });
}


/** Database-derived state a Shelley+ block's rules read; everything else in the evaluation is pure. */
export interface BlockRuleInputs {
    resolved: Map<string, ResolvedUtxo>;
    /** Registered pool ids (lower-case hex) among the ones the block's certificates reference. */
    pools: Set<string>;
    /** Reward-account balances for the withdrawals in the block; undefined when reward pots are not tracked (withdrawal amounts then unchecked). */
    rewardBalances: Map<string, bigint> | undefined;
    /**
     * The stored UTxO rows behind `resolved` (only the refs the database held at gather
     * time; outputs of in-flight blocks come from the overlay and have no row). The
     * applier spends from these instead of reading the UTxO set a second time. Not sent
     * to workers.
     */
    rows?: Map<string, UtxoRow>;
}

/** What a block reads from the ledger (refs, pool ids, withdrawal credentials). */
export function shelleyBlockReads(block: MultiEraBlock): { refs: Set<string>; poolIds: string[]; wdCreds: string[] } {
    const b: any = block.block;
    const bodies: any[] = b.transactionBodies ?? [];
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
    return { refs, poolIds, wdCreds };
}


/**
 * Ledger effects of a parsed block on what a following block may read, for
 * evaluating that block's rules before this one is applied: outputs created
 * (valid txs' outputs, invalid txs' collateral return), refs spent (inputs, or
 * collateral for invalid txs), pools registered, reward accounts withdrawn from.
 */
export interface BlockOverlay {
    created: Map<string, ResolvedUtxo>;
    spent: Set<string>;
    poolsRegistered: Set<string>;
    withdrawnCreds: Set<string>;
}

export function shelleyBlockOverlay(block: MultiEraBlock): BlockOverlay {
    const b: any = block.block;
    const bodies: any[] = b.transactionBodies ?? [];
    const invalid = new Set<number>((b.invalidTransactions ?? []).map((i: number | bigint) => Number(i)));
    const created = new Map<string, ResolvedUtxo>();
    const spent = new Set<string>();
    const poolsRegistered = new Set<string>();
    const withdrawnCreds = new Set<string>();
    bodies.forEach((body: any, i: number) => {
        const txHashHex = String(body.hash?.toString?.() ?? "").toLowerCase();
        if (!txHashHex) return;
        if (invalid.has(i)) {
            for (const c of body.collateralInputs ?? []) { const r = utxoRefOf(c); if (r) spent.add(r); }
            const ret = body.collateralReturn;
            if (ret) advanceResolved(created, txHashHex, [], [], (body.outputs ?? []).length, [outputLike(ret)]);
            return;
        }
        for (const inp of body.inputs ?? []) { const r = utxoRefOf(inp); if (r) spent.add(r); }
        advanceResolved(created, txHashHex, [], ((body.outputs ?? []) as any[]).map(outputLike));
        for (const c of (body.certs ?? []) as any[]) {
            if (Number(c.certType) === 3) poolsRegistered.add(String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase());
        }
        for (const w of (body.withdrawals?.map ?? []) as any[]) {
            const c = typedCredHexOf(w.rewardAccount?.credentials) ?? String((w.rewardAccount?.credentials?.hash ?? w.rewardAccount?.credentials)?.toString?.() ?? "").toLowerCase();
            if (c) withdrawnCreds.add(c);
        }
    });
    return { created, spent, poolsRegistered, withdrawnCreds };
}

/** Inputs for the next block as the ledger will look after `prev` is applied. */
export function applyOverlay(inputs: BlockRuleInputs, prev: BlockOverlay): BlockRuleInputs {
    const resolved = new Map(inputs.resolved);
    // created first, spent last: an output created and spent inside `prev` must not survive
    for (const [r, u] of prev.created) if (!resolved.has(r)) resolved.set(r, u);
    for (const r of prev.spent) resolved.delete(r);
    let rows = inputs.rows;
    if (rows && prev.spent.size) {
        rows = new Map(rows);
        for (const r of prev.spent) rows.delete(r);
    }
    const pools = new Set(inputs.pools);
    for (const p of prev.poolsRegistered) pools.add(p);
    // A withdrawal takes the whole reward balance and nothing refills it before the epoch
    // boundary, so an account an in-flight block withdraws from is exactly empty for this one.
    let rewardBalances = inputs.rewardBalances;
    if (rewardBalances && prev.withdrawnCreds.size) {
        rewardBalances = new Map(rewardBalances);
        for (const c of prev.withdrawnCreds) if (rewardBalances.has(c)) rewardBalances.set(c, 0n);
    }
    return { resolved, pools, rewardBalances, rows };
}

/**
 * `applyOverlay` for a sequence of in-flight blocks with one copy of each map instead of one
 * per overlay (the lookahead applies up to RULES_AHEAD_DEPTH overlays per scheduled block;
 * the copies were 2.6 % of the applier thread, 2026-09-07). Same result as folding
 * `applyOverlay` over `prevs` in order.
 */
export function applyOverlays(inputs: BlockRuleInputs, prevs: readonly BlockOverlay[]): BlockRuleInputs {
    if (prevs.length === 0) return inputs;
    if (prevs.length === 1) return applyOverlay(inputs, prevs[0]!);
    const resolved = new Map(inputs.resolved);
    let rows = inputs.rows ? new Map(inputs.rows) : inputs.rows;
    const pools = new Set(inputs.pools);
    let rewardBalances = inputs.rewardBalances;
    let balancesCopied = false;
    for (const prev of prevs) {
        for (const [r, u] of prev.created) if (!resolved.has(r)) resolved.set(r, u);
        for (const r of prev.spent) resolved.delete(r);
        if (rows && prev.spent.size) for (const r of prev.spent) rows.delete(r);
        for (const p of prev.poolsRegistered) pools.add(p);
        if (rewardBalances && prev.withdrawnCreds.size) {
            if (!balancesCopied) { rewardBalances = new Map(rewardBalances); balancesCopied = true; }
            for (const c of prev.withdrawnCreds) if (rewardBalances.has(c)) rewardBalances.set(c, 0n);
        }
    }
    return { resolved, pools, rewardBalances, rows };
}


/** Step 2 (pure given `inputs`): witnesses, per-tx rules, Plutus shadow, block limits. Runs on the main thread or in a worker. */
export async function evaluateShelleyBlockWithInputs(block: MultiEraBlock, ctx: BlockRuleContext, inputs: BlockRuleInputs): Promise<BlockRuleOutcome> {
    const b: any = block.block;
    const bodies: any[] = b.transactionBodies ?? [];
    const wits: any[] = b.transactionWitnessSets ?? [];
    const aux: Record<number, any> = b.auxiliaryDataSet ?? {};
    const invalid = new Set<number>((b.invalidTransactions ?? []).map((i: number | bigint) => Number(i)));
    const out: BlockRuleOutcome = { failures: [], reports: [], txs: bodies.length, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    if (bodies.length === 0) return out;
    // the block's own transactions spend from / add to this map as they are evaluated in order
    const resolved = new Map(inputs.resolved);
    const pools = inputs.pools;
    const rewardBalances = inputs.rewardBalances;
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
    const phase = ctx.phase ?? "both";
    const ok = phase === "shadow" ? items.map(() => true)
        : ctx.preVerified && ctx.preVerified.length === items.length ? ctx.preVerified : await verifyItems(ctx.pool, items);
    out.witnessesVerified = phase === "shadow" ? 0 : items.length;

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
        const r = phase === "shadow" ? { failures: [] as string[], reports: [] as string[] } : evaluateTxRules({
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
        if (phase !== "rules" && block.era >= 5 && r.failures.length === 0 && ((wits[i]?.redeemers ?? []) as any[]).length > 0) {
            try {
                const ev = await shadowEvaluateTx({ forceSample: phase === "shadow", era: block.era, body, witnessSet: wits[i], bodyBytes: body.cborRef?.toBuffer?.() ?? null, witnessSetBytes: wits[i]?.cborRef?.toBuffer?.() ?? null, resolved, params: ctx.params, genesis: ctx.genesis, network: String(ctx.config?.network ?? "mainnet"), markedInvalid: invalid.has(i) });
                out.plutus.evaluated += ev.evaluated;
                out.plutus.skipped += ev.skipped;
                if (ev.mismatch) {
                    out.plutus.mismatches++;
                    out.reports.push(`tx[${i}]: plutus shadow: ${ev.mismatch}`);
                }
                if (ev.note) {
                    // coverage gap (budget, decoding), not a verdict disagreement
                    out.reports.push(`tx[${i}]: plutus shadow skipped: ${ev.note}`);
                    const key = ev.note.replace(/[0-9a-f]{12,}…?/g, "X").replace(/\d+/g, "N").slice(0, 80);
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


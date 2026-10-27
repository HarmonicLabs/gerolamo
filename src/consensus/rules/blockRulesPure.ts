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
import type { ByronProtocolParameters } from "../byron/byronUpdateCodec";
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
import { checkBlockTxPhase2, phase2Mode } from "./phase2";
import { getEpochNetwork } from "../../utils/epochFromSlotCalculations";
import { BlockRefScriptSize, checkHeaderProtVer, checkValidityInterval, rewardAccountKey, txRefScriptsSize } from "./ledgerChecks";
import { checkDijkstraBlock, dijkstraBlockAuxDataBytes, dijkstraRefScriptParams, isDijkstraEra, rewardMapEntries, subBodiesOf, subTransactionReads, subTransactionsOf } from "./dijkstraRules";
import { requiredWitnesses } from "./requiredSigners";
import { blockAuxDataBytes } from "./scriptDataHash";

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
    /** Byron: the adopted protocol parameters of the ticked Byron ledger (consensus/byron/ByronLedger); null = the genesis file's. */
    byronParams?: ByronProtocolParameters | null;
    /** Byron: the block's `[era, block]` bytes, for the on-chain transaction sizes. */
    rawBlock?: Uint8Array | null;
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
        protocolMajor: params?.protocolMajor ?? numOrNull(raw.protocol_major_ver),
        maxValSize: era >= 5 ? params?.maxValSize ?? numOrNull(raw.max_val_size) : null,
        drepDeposit: era >= 7 && raw.drep_deposit != null ? big(raw.drep_deposit, 0n) : null,
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
    /**
     * Conway: DRep delegation of the key-hash reward accounts the block withdraws from
     * (typed hex → delegated), as of the block's start. Absent: the rule reports.
     */
    drepDelegated?: Map<string, boolean>;
    /** Registration of the reward accounts the block withdraws from (typed hex), as of the block's start. */
    stakeRegistered?: Map<string, boolean>;
    /** Treasury for `current_treasury_value` (constant within an epoch); absent/null: reported. */
    treasury?: bigint | null;
    /** Are the balances and the treasury exact (nodeLedgerStore `ledgerStateExact`)? Their rules are strict only then. */
    exactness?: { exact: boolean; why: string };
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
        const c = rewardAccountKey(w.rewardAccount);
        if (c) wdCreds.push(c);
    }
    // Dijkstra (bug 428): sub-transactions read the UTxO and accounts too; direct deposits and
    // account balance intervals read accounts
    if (isDijkstraEra(block.era)) for (const body of bodies) {
        const r = subTransactionReads(body);
        for (const x of r.refs) refs.add(x);
        poolIds.push(...r.poolIds);
        wdCreds.push(...r.creds);
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
    /** DRep delegation set (true) or dropped with the account (false) by the block's certificates, typed hex. */
    drepDelegation?: Map<string, boolean>;
    /** Stake registrations (true) and deregistrations (false) by the block's certificates, typed hex. */
    stakeRegistration?: Map<string, boolean>;
}

/** Stake-registration effect of one certificate: registrations 0, 7, 11, 12, 13; deregistrations 1, 8. */
export function stakeRegistrationEffect(cert: any): { key: string; registered: boolean } | null {
    const t = Number(cert?.certType);
    const reg = t === 0 || t === 7 || t === 11 || t === 12 || t === 13;
    if (!reg && t !== 1 && t !== 8) return null;
    const key = typedCredHexOf(cert?.stakeCredential);
    return key ? { key, registered: reg } : null;
}

/**
 * DRep-delegation effect of one certificate on its stake credential: vote delegations (9, 10,
 * 12, 13) set it, deregistrations (1, 8) drop the account with it; null = no effect.
 */
export function drepDelegationEffect(cert: any): { key: string; delegated: boolean } | null {
    const t = Number(cert?.certType);
    const set = t === 9 || t === 10 || t === 12 || t === 13;
    if (!set && t !== 1 && t !== 8) return null;
    const key = typedCredHexOf(cert?.stakeCredential);
    return key ? { key, delegated: set } : null;
}

export function shelleyBlockOverlay(block: MultiEraBlock): BlockOverlay {
    const b: any = block.block;
    const bodies: any[] = b.transactionBodies ?? [];
    const invalid = new Set<number>((b.invalidTransactions ?? []).map((i: number | bigint) => Number(i)));
    const created = new Map<string, ResolvedUtxo>();
    const spent = new Set<string>();
    const poolsRegistered = new Set<string>();
    const withdrawnCreds = new Set<string>();
    const drepDelegation = new Map<string, boolean>();
    const stakeRegistration = new Map<string, boolean>();
    bodies.forEach((body: any, i: number) => {
        const txHashHex = String(body.hash?.toString?.() ?? "").toLowerCase();
        if (!txHashHex) return;
        if (invalid.has(i)) {
            for (const c of body.collateralInputs ?? []) { const r = utxoRefOf(c); if (r) spent.add(r); }
            const ret = body.collateralReturn;
            if (ret) advanceResolved(created, txHashHex, [], [], (body.outputs ?? []).length, [outputLike(ret)]);
            return;
        }
        // Dijkstra: a valid transaction's sub-transactions take effect first (bug 429)
        for (const sb of subBodiesOf(body)) {
            const subHex = String(sb.hash?.toString?.() ?? "").toLowerCase();
            for (const inp of sb.inputs ?? []) { const r = utxoRefOf(inp); if (r) spent.add(r); }
            if (subHex) advanceResolved(created, subHex, [], ((sb.outputs ?? []) as any[]).map(outputLike));
            for (const c of (sb.certs ?? []) as any[]) {
                if (Number(c.certType) === 3) poolsRegistered.add(String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase());
                const d = drepDelegationEffect(c);
                if (d) drepDelegation.set(d.key, d.delegated);
                const r = stakeRegistrationEffect(c);
                if (r) stakeRegistration.set(r.key, r.registered);
            }
            for (const e of rewardMapEntries(sb.withdrawals)) withdrawnCreds.add(e.key);
        }
        for (const inp of body.inputs ?? []) { const r = utxoRefOf(inp); if (r) spent.add(r); }
        advanceResolved(created, txHashHex, [], ((body.outputs ?? []) as any[]).map(outputLike));
        for (const c of (body.certs ?? []) as any[]) {
            if (Number(c.certType) === 3) poolsRegistered.add(String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase());
            const d = drepDelegationEffect(c);
            if (d) drepDelegation.set(d.key, d.delegated);
            const r = stakeRegistrationEffect(c);
            if (r) stakeRegistration.set(r.key, r.registered);
        }
        for (const w of (body.withdrawals?.map ?? []) as any[]) {
            const c = rewardAccountKey(w.rewardAccount);
            if (c) withdrawnCreds.add(c);
        }
    });
    return { created, spent, poolsRegistered, withdrawnCreds, drepDelegation, stakeRegistration };
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
    let drepDelegated = inputs.drepDelegated;
    if (drepDelegated && prev.drepDelegation?.size) {
        drepDelegated = new Map(drepDelegated);
        for (const [k, v] of prev.drepDelegation) drepDelegated.set(k, v);
    }
    let stakeRegistered = inputs.stakeRegistered;
    if (stakeRegistered && prev.stakeRegistration?.size) {
        stakeRegistered = new Map(stakeRegistered);
        for (const [k, v] of prev.stakeRegistration) stakeRegistered.set(k, v);
    }
    return { resolved, pools, rewardBalances, rows, drepDelegated, stakeRegistered, treasury: inputs.treasury, exactness: inputs.exactness };
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
    const drepDelegated = inputs.drepDelegated ? new Map(inputs.drepDelegated) : undefined;
    const stakeRegistered = inputs.stakeRegistered ? new Map(inputs.stakeRegistered) : undefined;
    for (const prev of prevs) {
        if (drepDelegated && prev.drepDelegation) for (const [k, v] of prev.drepDelegation) drepDelegated.set(k, v);
        if (stakeRegistered && prev.stakeRegistration) for (const [k, v] of prev.stakeRegistration) stakeRegistered.set(k, v);
        for (const [r, u] of prev.created) if (!resolved.has(r)) resolved.set(r, u);
        for (const r of prev.spent) resolved.delete(r);
        if (rows && prev.spent.size) for (const r of prev.spent) rows.delete(r);
        for (const p of prev.poolsRegistered) pools.add(p);
        if (rewardBalances && prev.withdrawnCreds.size) {
            if (!balancesCopied) { rewardBalances = new Map(rewardBalances); balancesCopied = true; }
            for (const c of prev.withdrawnCreds) if (rewardBalances.has(c)) rewardBalances.set(c, 0n);
        }
    }
    return { resolved, pools, rewardBalances, rows, drepDelegated, stakeRegistered, treasury: inputs.treasury, exactness: inputs.exactness };
}


/** Step 2 (pure given `inputs`): witnesses, per-tx rules, Plutus shadow, block limits. Runs on the main thread or in a worker. */
export async function evaluateShelleyBlockWithInputs(block: MultiEraBlock, ctx: BlockRuleContext, inputs: BlockRuleInputs): Promise<BlockRuleOutcome> {
    const b: any = block.block;
    const bodies: any[] = b.transactionBodies ?? [];
    const wits: any[] = b.transactionWitnessSets ?? [];
    const aux: Record<number, any> = b.auxiliaryDataSet ?? {};
    const invalid = new Set<number>((b.invalidTransactions ?? []).map((i: number | bigint) => Number(i)));
    const out: BlockRuleOutcome = { failures: [], reports: [], txs: bodies.length, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    if (bodies.length === 0) {
        // an empty Dijkstra block still has its BBODY header / Peras / Leios rules (bug 427)
        if (isDijkstraEra(block.era) && (ctx.phase ?? "both") !== "shadow") {
            const p0 = ruleParams(ctx.params, ctx.genesis, block.era, String(ctx.config?.network ?? "mainnet"));
            checkDijkstraBlock(out, { block: b, protocolMajor: p0.protocolMajor ?? null });
        }
        return out;
    }
    // the block's own transactions spend from / add to this map as they are evaluated in order
    const resolved = new Map(inputs.resolved);
    const pools = inputs.pools;
    // Reward balances before each tx: a valid tx's withdrawals drain its accounts (`drainAccounts`), so a
    // later tx of the block withdrawing from the same account must take 0 (bug 272: every tx was
    // compared with the balance before the block).
    const rewardBalances = inputs.rewardBalances ? new Map(inputs.rewardBalances) : undefined;
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
    // Dijkstra sub-transactions sign their own body hash with their own witness set (bug 428)
    const perSub: Array<Array<{ start: number; proves: Array<{ kind: "key" | "root"; hash: string }>; problems: string[] }>> = [];
    if (isDijkstraEra(block.era)) for (let i = 0; i < bodies.length; i++) {
        perSub.push(subTransactionsOf(bodies[i]).map((st: any) => {
            const sb = st?.body ?? st;
            const hx = String(sb?.hash?.toString?.() ?? "");
            const c = collectShelleyWitnesses(hx ? fromHex(hx) : blake2b_256(sb.toCborBytes()), st?.witnessSet);
            const entry = { start: items.length, proves: c.proves, problems: c.problems };
            items.push(...c.items);
            return entry;
        }));
    }
    const phase = ctx.phase ?? "both";
    const ok = phase === "shadow" ? items.map(() => true)
        : ctx.preVerified && ctx.preVerified.length === items.length ? ctx.preVerified : await verifyItems(ctx.pool, items);
    out.witnessesVerified = phase === "shadow" ? 0 : items.length;

    // 3. rules per transaction
    const params = ruleParams(ctx.params, ctx.genesis, block.era, String(ctx.config?.network ?? "mainnet"));
    // Plutus phase 2 (rules/phase2.ts): enforced in the rules phase, or evaluated report-only in
    // the detached shadow job, per --plutus-phase2 (enforce | report | off).
    const p2mode = phase2Mode();
    const phase2Here = p2mode !== "off" && (phase === "shadow" ? p2mode === "report" : phase === "rules" ? p2mode === "enforce" : true);
    const p2enforce = p2mode === "enforce" && phase !== "shadow";
    const runPhase2 = (i: number, markedInvalid: boolean) => {
        const bodyBytes: Uint8Array | null = bodies[i].cborRef?.toBuffer?.() ?? null, witnessSetBytes: Uint8Array | null = wits[i]?.cborRef?.toBuffer?.() ?? null;
        if (!bodyBytes || !witnessSetBytes) { out.plutus.skipped++; out.reports.push(`tx[${i}]: plutus phase 2 not evaluated: original bytes unavailable`); return; }
        // network = the slot-geometry name (preview/preprod/mainnet/custom) the job set, never config.network,
        // whose "testnet" is the address flag and normalises to preprod (bug 144).
        let res: ReturnType<typeof checkBlockTxPhase2>;
        try { res = checkBlockTxPhase2({ era: block.era, bodyBytes, witnessSetBytes, resolved, params: ctx.params, markedInvalid, network: getEpochNetwork() }); }
        catch (err) { out.plutus.skipped++; out.reports.push(`tx[${i}]: plutus phase 2 not evaluated: ${err instanceof Error ? err.message : String(err)}`); return; }
        const v = res.verdict;
        const n = res.result.redeemers.length;
        if (v.kind === "unknown") {
            out.plutus.skipped += n;
            out.reports.push(`tx[${i}]: plutus phase 2 not evaluated: ${v.detail}`);
            const key = v.detail.replace(/[0-9a-f]{12,}…?/g, "X").replace(/\d+/g, "N").slice(0, 80);
            out.plutus.skipReasons[key] = (out.plutus.skipReasons[key] ?? 0) + 1;
            return;
        }
        out.plutus.evaluated += n;
        if (v.kind === "ok") return;
        out.plutus.mismatches++;
        const msg = `tx[${i}]: plutus phase 2 ${v.kind === "collect-error" ? "collect error" : "ValidationTagMismatch"}: ${v.detail}`;
        (p2enforce ? out.failures : out.reports).push(msg);
    };
    let blockMem = 0n, blockSteps = 0n;
    // Conway BBODY: reference-script bytes of the whole block (valid and invalid txs)
    const blockRefScripts = new BlockRefScriptSize(inputs.resolved, params.protocolMajor ?? null);
    // Conway LEDGER: DRep delegation before each tx (earlier txs of the block included)
    const drepState = inputs.drepDelegated ? new Map(inputs.drepDelegated) : null;
    const drepDelegated = drepState ? (k: string) => drepState.get(k) ?? null : undefined;
    const regState = inputs.stakeRegistered ? new Map(inputs.stakeRegistered) : null;
    const stakeRegistered = regState ? (k: string) => regState.get(k) ?? null : undefined;
    // Auxiliary data bytes: the decoder's slice, else sliced from the block (bug 184)
    let auxSlices: Map<number, Uint8Array> | null | undefined;
    const auxBytesOf = (i: number): Uint8Array | undefined => {
        if (isDijkstraEra(block.era)) {
            // Dijkstra: the bytes as carried inside the block transaction (bug 428)
            if (auxSlices === undefined) { let bb: Uint8Array | null = null; try { bb = b.cborRef?.toBuffer?.() ?? null; } catch { bb = null; } auxSlices = bb ? dijkstraBlockAuxDataBytes(bb) : null; }
            const s = auxSlices?.get(i);
            if (s) return s;
        }
        try { const own = aux[i]?.cborRef?.toBuffer?.(); if (own) return own; } catch { /* */ }
        if (auxSlices === undefined) { let bb: Uint8Array | null = null; try { bb = b.cborRef?.toBuffer?.() ?? null; } catch { bb = null; } auxSlices = bb ? blockAuxDataBytes(bb) : null; }
        return auxSlices?.get(i);
    };
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
            if (isDijkstraEra(block.era)) {
                const a = evaluateAlonzoRules({ era: block.era, collateralOnly: true, body, witnessSet: wits[i], resolved, plutusScripts: new Set(), nativeScripts: new Set(), params });
                for (const f of a.failures) out.failures.push(`tx[${i}]: ${f}`);
            } else if (phase !== "shadow") {
                // Bug 534: cardano-ledger runs the whole UTXOW / UTXO rule for a transaction marked invalid (inputs,
                // fee, value conservation, validity interval, witnesses, outputs, collateral); only LEDGER's
                // withdrawal / treasury checks, CERTS and GOV are skipped. Before, only collateral was checked here.
                const bodyLen = sliceLength(body), witLen = sliceLength(wits[i]);
                const auxDataBytes = aux[i] ? auxBytesOf(i) : null;
                const auxLen = aux[i] ? (auxDataBytes?.length ?? null) : 1;
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
                    txSizeBytes: bodyLen != null && witLen != null && auxLen != null ? feeSizeBytes(bodyLen, witLen, auxLen) : null,
                    auxDataBytes,
                    stakeRegistered,
                    refScriptBytes: block.era >= 7 ? txRefScriptsSize(body, (r) => resolved.get(r)) : 0,
                    exactness: inputs.exactness,
                    isValid: false,
                });
                for (const f of r.failures) out.failures.push(`tx[${i}]: ${f}`);
                for (const f of r.reports) out.reports.push(`tx[${i}]: ${f}`);
                // with nothing to run, nothing can fail: UTXOS ValidationTagMismatch (PassedUnexpectedly)
                if (block.era >= 5 && effectiveRedeemers((wits[i]?.redeemers ?? []) as any[], Number(block.era)).length === 0) out.failures.push(`tx[${i}]: marked invalid (phase-2) but carries no redeemers`);
            }
            // Bug 535: BBODY's maxBlockExUnits sums every transaction of the block, invalid ones included
            // (cardano-ledger Alonzo `validateExUnits`: foldMap getTotalExUnits over all txs)
            for (const rd of effectiveRedeemers((wits[i]?.redeemers ?? []) as any[], Number(block.era))) {
                blockMem += BigInt(rd.execUnits?.mem ?? 0);
                blockSteps += BigInt(rd.execUnits?.steps ?? rd.execUnits?.cpu ?? 0);
            }
            // …and its scripts must really fail (UTXOS: ValidationTagMismatch otherwise)
            if (phase2Here && block.era >= 5 && ((wits[i]?.redeemers ?? []) as any[]).length > 0) runPhase2(i, true);
            const txHashHex = String(body.hash?.toString?.() ?? "").toLowerCase();
            const ret = body.collateralReturn ? outputLike(body.collateralReturn) : null;
            blockRefScripts.add(body, true, txHashHex, ret ? [ret] : []);
            if (txHashHex) advanceResolved(resolved, txHashHex, [...(body.collateralInputs ?? [])], [], (body.outputs ?? []).length, ret ? [ret] : []);
            continue;
        }
        if (isDijkstraEra(block.era)) {
            // SUBUTXO / SUBUTXOW essentials: inputs in the UTxO before the batch, vkey witnesses
            // for the sub-transaction's own needs, validity interval, output network
            subTransactionsOf(body).forEach((st: any, j: number) => {
                const sb = st?.body ?? st;
                const sw = perSub[i]?.[j];
                const proven = new Set<string>();
                if (sw) for (let k = 0; k < sw.proves.length; k++) {
                    if (!ok[sw.start + k]) { out.failures.push(`tx[${i}].sub[${j}]: vkey witness ${sw.proves[k]!.hash.slice(0, 12)}… has an invalid signature`); continue; }
                    if (sw.proves[k]!.kind === "key") proven.add(sw.proves[k]!.hash);
                }
                for (const p of sw?.problems ?? []) out.failures.push(`tx[${i}].sub[${j}]: ${p}`);
                const missingIns = ((sb.inputs ?? []) as any[]).map(utxoRefOf).filter((r): r is string => !!r && !resolved.has(r));
                if (missingIns.length) out.failures.push(`tx[${i}].sub[${j}]: spends ${missingIns.length} input(s) not in the UTxO set: ${missingIns.slice(0, 2).join(", ")}`);
                const subSink = { failures: [] as string[], reports: [] as string[] };
                checkValidityInterval(subSink, block.era, sb, ctx.slot);
                const req = requiredWitnesses(sb, resolved);
                const missingKeys = [...req.keyHashes].filter((k) => !proven.has(k));
                if (missingKeys.length) subSink.failures.push(`missing vkey witness for ${missingKeys.length} key(s)`);
                for (const f of subSink.failures) out.failures.push(`tx[${i}].sub[${j}]: ${f}`);
                for (const f of subSink.reports) out.reports.push(`tx[${i}].sub[${j}]: ${f}`);
            });
        }
        const bodyLen = sliceLength(body), witLen = sliceLength(wits[i]);
        const auxDataBytes = aux[i] ? auxBytesOf(i) : null;
        const auxLen = aux[i] ? (auxDataBytes?.length ?? null) : 1;
        const txSizeBytes = bodyLen != null && witLen != null && auxLen != null ? feeSizeBytes(bodyLen, witLen, auxLen) : null;
        const refScriptBytes = block.era >= 7 ? txRefScriptsSize(body, (r) => resolved.get(r)) : 0;
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
            auxDataBytes,
            drepDelegated,
            stakeRegistered,
            treasury: inputs.treasury,
            refScriptBytes,
            exactness: inputs.exactness,
        });
        for (const f of r.failures) out.failures.push(`tx[${i}]: ${f}`);
        for (const f of r.reports) out.reports.push(`tx[${i}]: ${f}`);
        for (const rd of effectiveRedeemers((wits[i]?.redeemers ?? []) as any[], Number(block.era))) {
            blockMem += BigInt(rd.execUnits?.mem ?? 0);
            blockSteps += BigInt(rd.execUnits?.steps ?? rd.execUnits?.cpu ?? 0);
        }
        // Phase 2: every script succeeds within its declared units (rules/phase2.ts)
        if (phase2Here && block.era >= 5 && r.failures.length === 0 && ((wits[i]?.redeemers ?? []) as any[]).length > 0) runPhase2(i, false);
        const txHashHex = String(body.hash?.toString?.() ?? "").toLowerCase();
        const created = ((body.outputs ?? []) as any[]).map(outputLike);
        blockRefScripts.add(body, false, txHashHex, created);
        if (rewardBalances && isDijkstraEra(block.era)) {
            // Dijkstra: withdrawals may be partial and direct deposits credit accounts (sub-transactions first)
            for (const b of [...subBodiesOf(body), body]) {
                for (const e of rewardMapEntries(b.withdrawals)) if (rewardBalances.has(e.key)) rewardBalances.set(e.key, rewardBalances.get(e.key)! - e.amount);
                for (const e of rewardMapEntries(b.directDeposits)) if (rewardBalances.has(e.key)) rewardBalances.set(e.key, rewardBalances.get(e.key)! + e.amount);
            }
        } else if (rewardBalances) for (const w of (body.withdrawals?.map ?? []) as any[]) { const c = rewardAccountKey(w.rewardAccount); if (c && rewardBalances.has(c)) rewardBalances.set(c, 0n); }
        for (const c of (body.certs ?? []) as any[]) {
            const d = drepState ? drepDelegationEffect(c) : null;
            if (d) drepState!.set(d.key, d.delegated);
            const r = regState ? stakeRegistrationEffect(c) : null;
            if (r) regState!.set(r.key, r.registered);
        }
        if (isDijkstraEra(block.era)) for (const sb of subBodiesOf(body)) {
            const subHex = String(sb.hash?.toString?.() ?? "").toLowerCase();
            for (const c of (sb.certs ?? []) as any[]) {
                const d = drepState ? drepDelegationEffect(c) : null;
                if (d) drepState!.set(d.key, d.delegated);
                const r = regState ? stakeRegistrationEffect(c) : null;
                if (r) regState!.set(r.key, r.registered);
            }
            if (subHex) advanceResolved(resolved, subHex, [...(sb.inputs ?? [])], ((sb.outputs ?? []) as any[]).map(outputLike));
        }
        if (txHashHex) advanceResolved(resolved, txHashHex, [...(body.inputs ?? [])], created);
    }
    const blockSink = { failures: out.failures, reports: out.reports };
    if (isDijkstraEra(block.era)) {
        // Dijkstra BBODY (bug 427): limits from the protocol parameters, HeaderProtVerTooLow, Peras / Leios
        blockRefScripts.check(blockSink, block.era, dijkstraRefScriptParams(ctx.params?.raw).maxPerBlock ?? undefined);
        checkDijkstraBlock(blockSink, { block: b, protocolMajor: params.protocolMajor ?? null });
    } else {
        blockRefScripts.check(blockSink, block.era);
        checkHeaderProtVer(blockSink, block.era, String(ctx.config?.network ?? "mainnet"), numOrNull(b.header?.body?.protocolVersion?.major), params.protocolMajor ?? null);
    }
    const raw = ctx.params?.raw ?? {};
    const maxBlockMem = raw.max_block_ex_mem != null ? big(raw.max_block_ex_mem, 0n) : null;
    const maxBlockSteps = raw.max_block_ex_steps != null ? big(raw.max_block_ex_steps, 0n) : null;
    if (maxBlockMem != null && maxBlockMem > 0n && blockMem > maxBlockMem) out.failures.push(`block execution memory ${blockMem} > max ${maxBlockMem}`);
    if (maxBlockSteps != null && maxBlockSteps > 0n && blockSteps > maxBlockSteps) out.failures.push(`block execution steps ${blockSteps} > max ${maxBlockSteps}`);
    return out;
}


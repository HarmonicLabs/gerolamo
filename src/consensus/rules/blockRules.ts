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

import {
    addressString, advanceResolved, applyOverlay, big, evaluateShelleyBlockWithInputs, feeSizeBytes, ruleParams, shelleyBlockOverlay, shelleyBlockReads, sliceLength, verifyItems,
    type BlockOverlay, type BlockRuleContext, type BlockRuleInputs, type BlockRuleOutcome,
} from "./blockRulesPure";
export {
    applyOverlay, evaluateShelleyBlockWithInputs, feeSizeBytes, ruleParams, shelleyBlockOverlay, shelleyBlockReads,
    type BlockOverlay, type BlockRuleContext, type BlockRuleInputs, type BlockRuleOutcome,
} from "./blockRulesPure";

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


/** Step 1: resolve inputs, pools and reward balances from the database (main thread). */
export async function gatherShelleyBlockInputs(block: MultiEraBlock): Promise<BlockRuleInputs> {
    const { refs, poolIds, wdCreds } = shelleyBlockReads(block);
    const [resolved, pools, rewardBalances] = await Promise.all([resolveInputs(refs), registeredPools(poolIds), rewardBalancesFor(wdCreds)]);
    return { resolved, pools, rewardBalances };
}


async function evaluateShelleyBlock(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    const b: any = block.block;
    if (((b.transactionBodies ?? []) as any[]).length === 0) {
        return { failures: [], reports: [], txs: 0, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    }
    return evaluateShelleyBlockWithInputs(block, ctx, await gatherShelleyBlockInputs(block));
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

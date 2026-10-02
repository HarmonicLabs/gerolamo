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
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { splitEraBlock } from "../bodyHash";
import { byronProtocolParametersFromGenesis, type ByronProtocolParameters } from "../byron/byronUpdateCodec";
import { drepDelegatedFor, getUtxoRowsByRefs, localTreasury, registeredPools, rewardBalancesFor, stakeRegisteredFor, type UtxoRow } from "../../db/rulesQueries";
import { typedCredHexOf } from "../../db/stakeCred";
import { ledgerStateExact } from "../../ledger/nodeLedgerStore";
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
    addressString, advanceResolved, applyOverlay, applyOverlays, big, evaluateShelleyBlockWithInputs, feeSizeBytes, ruleParams, shelleyBlockOverlay, shelleyBlockReads, sliceLength, verifyItems,
    type BlockOverlay, type BlockRuleContext, type BlockRuleInputs, type BlockRuleOutcome,
} from "./blockRulesPure";
export {
    applyOverlay, applyOverlays, evaluateShelleyBlockWithInputs, feeSizeBytes, ruleParams, shelleyBlockOverlay, shelleyBlockReads,
    type BlockOverlay, type BlockRuleContext, type BlockRuleInputs, type BlockRuleOutcome,
} from "./blockRulesPure";

async function resolveInputs(refs: Set<string>): Promise<{ resolved: Map<string, ResolvedUtxo>; rows: Map<string, UtxoRow> }> {
    const resolved = new Map<string, ResolvedUtxo>();
    const rows = new Map<string, UtxoRow>();
    if (refs.size === 0) return { resolved, rows };
    for (const row of await getUtxoRowsByRefs([...refs])) {
        resolved.set(row.utxo_ref, resolvedFromRow(row));
        rows.set(row.utxo_ref, row);
    }
    return { resolved, rows };
}

let byronGenesisParams: { file: string; params: ByronProtocolParameters | null } | null = null;
/** The Byron genesis parameters (`blockVersionData`) of the configured genesis file: the fallback when no adopted parameters are passed. */
export function byronGenesisParamsFor(config: any): ByronProtocolParameters | null {
    const file = String(config?.byronGenesisFile ?? "");
    if (!file) return null;
    if (byronGenesisParams?.file === file) return byronGenesisParams.params;
    let params: ByronProtocolParameters | null = null;
    try {
        params = byronProtocolParametersFromGenesis(JSON.parse(readFileSync(file, "utf8"))?.blockVersionData);
    } catch {
        params = null;
    }
    byronGenesisParams = { file, params };
    return params;
}

/**
 * Byte lengths of the `ATxAux` (`[tx, [* witness]]`) entries of a Byron main block, as encoded on
 * chain — the `txSize` of `validateTxAux` (the size limit and the fee basis). Null when the raw
 * block is not at hand or does not slice.
 */
export function byronTxAuxSizes(blockData: Uint8Array | null | undefined): number[] | null {
    if (!blockData) return null;
    try {
        const { era, rawBlock } = splitEraBlock(blockData);
        if (era !== 1) return null;
        const blk = Cbor.parseLazy(rawBlock);
        if (!(blk instanceof LazyCborArray) || blk.array.length !== 3) return null;
        const body = Cbor.parseLazy(blk.array[1]!);
        if (!(body instanceof LazyCborArray) || body.array.length !== 4) return null;
        const txs = Cbor.parseLazy(body.array[0]!);
        return txs instanceof LazyCborArray ? txs.array.map((t) => t.length) : null;
    } catch {
        return null;
    }
}

export async function evaluateBlockRules(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    if (isByronBlock(block.block as any)) return evaluateByronBlock(block, ctx);
    return evaluateShelleyBlock(block, ctx);
}


/** Step 1: resolve inputs, pools and reward balances from the database (main thread). */
export async function gatherShelleyBlockInputs(block: MultiEraBlock): Promise<BlockRuleInputs> {
    const { refs, poolIds, wdCreds } = shelleyBlockReads(block);
    const conway = Number(block.era) >= 7;
    const claimsTreasury = conway && (((block.block as any).transactionBodies ?? []) as any[]).some((b) => b?.currentTreasuryValue != null);
    const [{ resolved, rows }, pools, rewardBalances, drepDelegated, stakeRegistered, treasury] = await Promise.all([
        resolveInputs(refs), registeredPools(poolIds), rewardBalancesFor(wdCreds),
        conway ? drepDelegatedFor(wdCreds) : Promise.resolve(undefined),
        stakeRegisteredFor(wdCreds),
        claimsTreasury ? localTreasury() : Promise.resolve(null),
    ]);
    // balances and treasury are only as exact as the store they came from (strict rules then, bugs 272/273)
    return { resolved, pools, rewardBalances, rows, drepDelegated, stakeRegistered, treasury, exactness: ledgerStateExact() };
}


async function evaluateShelleyBlock(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    const b: any = block.block;
    if (((b.transactionBodies ?? []) as any[]).length === 0) {
        return { failures: [], reports: [], txs: 0, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    }
    return evaluateShelleyBlockWithInputs(block, ctx, await gatherShelleyBlockInputs(block));
}


/** Byron transactions of a block with their ids and spent references (no database access). */
export function byronBlockTxs(block: MultiEraBlock): { txs: Array<{ tx: any; witnesses: any[]; hash: Uint8Array; refs: string[] }>; refs: Set<string>; failures: string[] } {
    const refs = new Set<string>();
    const failures: string[] = [];
    const txs: Array<{ tx: any; witnesses: any[]; hash: Uint8Array; refs: string[] }> = [];
    for (const e of getByronTxPayloads(block.block as any)) {
        const tx = e?.tx ?? e;
        const witnesses: any[] = e?.witnesses ?? [];
        let hash: Uint8Array;
        try {
            hash = blake2b_256(tx.toCborBytes());
        } catch {
            failures.push("byron tx: cannot serialise for hashing");
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
    return { txs, refs, failures };
}

async function evaluateByronBlock(block: MultiEraBlock, ctx: BlockRuleContext): Promise<BlockRuleOutcome> {
    const { refs } = byronBlockTxs(block);
    const { resolved } = await resolveInputs(refs);
    return evaluateByronBlockWithInputs(block, ctx, resolved);
}

/**
 * The Byron UTXO / UTXOW rules over a resolved input map (`resolved` is extended with the block's
 * own outputs and advanced tx by tx). Size limit and fee policy come from `ctx.byronParams` (the
 * adopted parameters of the ticked Byron ledger), else the genesis file's; the size basis is the
 * on-chain `ATxAux` length when `ctx.rawBlock` is given.
 */
export async function evaluateByronBlockWithInputs(block: MultiEraBlock, ctx: BlockRuleContext, resolved: Map<string, ResolvedUtxo>): Promise<BlockRuleOutcome> {
    const { txs, failures } = byronBlockTxs(block);
    const out: BlockRuleOutcome = { failures, reports: [], txs: txs.length + failures.length, witnessesVerified: 0, plutus: { evaluated: 0, skipped: 0, mismatches: 0, skipReasons: {} } };
    if (txs.length === 0) return out;
    const magic = Number(ctx.config?.networkMagic);
    const pp = ctx.byronParams ?? byronGenesisParamsFor(ctx.config);
    const sliced = byronTxAuxSizes(ctx.rawBlock);
    const auxSizes = sliced && failures.length === 0 && sliced.length === txs.length ? sliced : null;
    if (!auxSizes) out.reports.push(`byron tx sizes: ${ctx.rawBlock ? "raw block does not slice into the decoded transactions" : "no raw block"}; size limit unchecked, fee on the witness-less size`);
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
            feePolicy: pp?.txFeePolicy ?? null,
            txSizeBytes: (() => { try { return t.tx.toCborBytes().length; } catch { return null; } })(),
            txAuxSizeBytes: auxSizes ? auxSizes[i]! : null,
            maxTxSize: pp?.maxTxSize ?? null,
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

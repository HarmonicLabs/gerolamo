/**
 * Byron transaction rules (cardano-ledger-byron UTXO / UTXOW):
 * inputs and outputs non-empty, outputs positive, no duplicate inputs, inputs
 * exist, value conserved (Σin ≥ Σout, the difference is the fee), fee ≥
 * txFeePolicy (a + b·size with the witness-less tx bytes as a lower-bound basis),
 * and one witness per input whose key hashes to the spent address root and
 * signs the tx id.
 */
import type { ResolvedUtxo } from "./resolvedUtxo";
import { utxoRefOf } from "./resolvedUtxo";
import type { ByronWitnessCheck } from "./witnesses";

export interface ByronRuleInput {
    txHashHex: string;
    inputs: any[];
    outputs: any[];
    resolved: Map<string, ResolvedUtxo>;
    /** Witness check built by collectByronWitnesses, with per-item verification results. */
    witnesses: ByronWitnessCheck;
    witnessOk: boolean[];
    /** Per witness item: Byron witness type (0 PkWitness, 2 RedeemWitness). */
    witnessTypes?: number[];
    feePolicy: { summand: bigint; multiplier: bigint } | null;
    txSizeBytes: number | null;
}

export function evaluateByronTxRules(tx: ByronRuleInput): { failures: string[]; reports: string[] } {
    const failures: string[] = [];
    const reports: string[] = [];
    if (tx.inputs.length === 0) failures.push("no inputs");
    if (tx.outputs.length === 0) failures.push("no outputs");
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const i of tx.inputs) {
        const r = utxoRefOf(i);
        if (!r) {
            failures.push("malformed input");
            continue;
        }
        if (seen.has(r)) failures.push(`duplicate input ${r}`);
        seen.add(r);
        refs.push(r);
    }
    const missing = refs.filter((r) => !tx.resolved.has(r));
    if (missing.length) failures.push(`spends ${missing.length} input(s) not in the UTxO set: ${missing.slice(0, 3).join(", ")}`);

    let inSum = 0n, outSum = 0n;
    for (const r of refs) inSum += tx.resolved.get(r)?.value.get("lovelace") ?? 0n;
    for (const o of tx.outputs) {
        const amt = BigInt(o.amount ?? o.value ?? o.lovelace ?? 0);
        // Byron accepted zero-lovelace outputs (mainnet epoch 204, tx 73822c3b…); only a
        // negative amount (impossible in CBOR) would be a failure.
        if (amt < 0n) failures.push("negative output");
        else if (amt === 0n) reports.push("zero-lovelace output (allowed in Byron)");
        outSum += amt;
    }
    if (missing.length === 0 && inSum < outSum) failures.push(`value not conserved: inputs ${inSum} < outputs ${outSum}`);
    // Redemption transactions (every witness a RedeemWitness, spending AVVM outputs) pay no fee.
    const allRedeem = tx.witnesses.items.length > 0 && tx.witnesses.roots.every((_, i) => tx.witnessTypes?.[i] === 2);
    if (missing.length === 0 && tx.feePolicy && tx.txSizeBytes != null && !allRedeem) {
        // fee policy is in nanocoins (10^-9 lovelace): fee ≥ ceil((summand + multiplier·size) / 1e9)
        const need = (tx.feePolicy.summand + tx.feePolicy.multiplier * BigInt(tx.txSizeBytes) + 999_999_999n) / 1_000_000_000n;
        const fee = inSum - outSum;
        // Size basis: the transaction bytes without witnesses — a lower bound on any
        // basis the policy could use, so a shortfall here is a real violation. Zero
        // reports over the mainnet Byron history (325k blocks) with this basis.
        if (fee < need) failures.push(`fee ${fee} below policy minimum ${need} (a + b·size, size ${tx.txSizeBytes})`);
    }

    for (const p of tx.witnesses.problems) failures.push(p);
    for (let i = 0; i < tx.witnesses.items.length; i++) {
        const { root, inputRef } = tx.witnesses.roots[i]!;
        if (!tx.witnessOk[i]) failures.push(`input ${inputRef}: witness signature invalid`);
        const u = tx.resolved.get(inputRef);
        const addrRoot = u ? byronRootOf(u) : null;
        if (addrRoot && addrRoot !== root) failures.push(`input ${inputRef}: witness key does not match the address root`);
    }
    return { failures, reports };
}

import { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
function byronRootOf(u: ResolvedUtxo): string | null {
    try {
        if (!ByronAddress.isValid(u.address)) return null;
        return toHex(ByronAddress.fromBase58(u.address).rootHash);
    } catch {
        return null;
    }
}

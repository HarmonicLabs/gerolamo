/**
 * Projection deltas (`MbTxDelta`) of a stored block, built from its bytes alone (blockFacts):
 * what the applier writes per transaction, for the backfill script and tests. The spent side of
 * the address index needs the spent outputs' addresses: `addressOf` resolves them (the explorer's
 * own mb_tx_out, or the ledger's UTxO deltas). Phase-2-invalid transactions spend their collateral
 * and create their collateral return, like the applier.
 */
import type { BlockFacts, OutputFact } from "./blockFacts";
import { hex } from "./cborWalk";
import type { MbTxDelta, MbTxOut } from "./writer";

function outOf(o: OutputFact): MbTxOut {
    const assets: Record<string, Record<string, string>> = {};
    for (const a of o.assets) (assets[a.policy] ??= {})[a.name] = a.qty.toString();
    return {
        outputIndex: o.index, address: o.address, lovelace: o.lovelace.toString(),
        assetsJson: Object.keys(assets).length ? JSON.stringify(assets) : null,
        datumHash: o.datumHash, inlineDatumCbor: o.inlineDatum ? hex(o.inlineDatum) : null, scriptRefHash: o.scriptRef?.hash ?? null,
    };
}

export async function deltasOfBlock(
    facts: BlockFacts,
    meta: { hash: Uint8Array; slot: number; height: number | null },
    addressOf: (txHash: string, index: number) => Promise<string | null> | string | null,
): Promise<MbTxDelta[]> {
    const out: MbTxDelta[] = [];
    // outputs created earlier in the same block are spent by later transactions of it
    const local = new Map<string, string>();
    for (const tx of facts.txs) {
        const spends = tx.valid ? tx.inputs : tx.collateral;
        const outs = tx.valid ? tx.outputs : tx.collateralReturn ? [tx.collateralReturn] : [];
        const addresses = new Map<string, "in" | "out" | "both">();
        for (const i of spends) {
            const a = local.get(`${i.txHash}:${i.index}`) ?? (await addressOf(i.txHash, i.index));
            if (a && a.length > 8) addresses.set(a, addresses.get(a) === "in" || addresses.get(a) === "both" ? "both" : "out");
        }
        for (const o of outs) {
            if (o.address.length > 8) addresses.set(o.address, addresses.get(o.address) === "out" || addresses.get(o.address) === "both" ? "both" : "in");
            local.set(`${tx.hash}:${o.index}`, o.address);
        }
        out.push({
            txHash: tx.hash, blockHash: meta.hash, slot: meta.slot, txIndex: tx.index, blockHeight: meta.height,
            fee: tx.byron ? null : tx.valid ? tx.fee.toString() : (tx.totalCollateral ?? tx.fee).toString(),
            size: tx.size,
            invalidBefore: tx.validFrom == null ? null : tx.validFrom.toString(),
            invalidHereafter: tx.ttl == null ? null : tx.ttl.toString(),
            addresses,
            inputs: spends.map((i, n) => ({ inputIndex: n, prevTxHash: i.txHash, prevOutputIndex: i.index })),
            outputs: outs.map(outOf),
            valid: tx.valid,
        });
    }
    return out;
}

/**
 * Parse-only projection of a block into explorer (mb_*) transaction deltas — no ledger
 * rules, no UTxO lookups. Used by the extractor workers (`gerolamo extract`) and kept pure so
 * it can be unit-tested on fixture blocks. Output addresses are carried as direction "in"
 * (funds received); the input side (direction "out", spent marks) is filled by the
 * extractor's finalize pass from the stream itself, so chunks can be decoded in any order.
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { buildUtxoRowForOutput } from "../db";
import { getByronTxPayloads, getShelleyTxBodies, isByronBlock } from "../utils/eraAccessors";
import { toHex } from "@harmoniclabs/uint8array-utils";

export interface ExtractedOutput {
    i: number;
    a: string;
    l: string;
    j: string | null;
    d: string | null;
    c: string | null;
    s: string | null;
}

export interface ExtractedTx {
    txHash: string;
    txIndex: number;
    fee: string | null;
    size: number | null;
    invalidBefore: string | null;
    invalidHereafter: string | null;
    /** [inputIndex, prevTxHash, prevOutputIndex] */
    inputs: Array<[number, string, number]>;
    outputs: ExtractedOutput[];
}

export interface ExtractedBlock {
    hash: Uint8Array;
    slot: number;
    blockNo: number | null;
    txs: ExtractedTx[];
    byron: boolean;
}

function headerBlockNo(block: any): number | null {
    const h = block?.header;
    const n = h?.body?.blockNumber ?? h?.blockNumber ?? h?.body?.blockNo ?? null;
    if (n == null) return null;
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
}

function outputRow(txId: string, i: number, output: any): ExtractedOutput {
    const row = buildUtxoRowForOutput(txId, i, output);
    return {
        i,
        a: row.address ?? "",
        l: row.lovelace ?? "0",
        j: row.assetsJson ?? null,
        d: row.metadata?.datumHash ?? null,
        c: row.metadata?.inlineDatumCbor ?? null,
        s: row.metadata?.scriptRefHash ?? null,
    };
}

function shelleyTx(body: any, ti: number): ExtractedTx | null {
    let txId = "";
    try { txId = toHex(body.hash instanceof Uint8Array ? body.hash : body.hash.toBuffer()).toLowerCase(); } catch { return null; }
    const inputs: Array<[number, string, number]> = [];
    const ins: any[] = body.inputs ?? [];
    for (let i = 0; i < ins.length; i++) {
        const input = ins[i];
        inputs.push([i, String(input.utxoRef.id.toString()).toLowerCase(), Number(input.utxoRef.index)]);
    }
    const outputs = ((body.outputs ?? []) as any[]).map((o, i) => outputRow(txId, i, o));
    let size: number | null = null;
    try { size = body.toCborBytes().length; } catch { /* unknown */ }
    return {
        txHash: txId,
        txIndex: ti,
        fee: body.fee != null ? String(body.fee) : null,
        size,
        invalidBefore: body.validityIntervalStart != null ? String(body.validityIntervalStart) : null,
        invalidHereafter: body.ttl != null ? String(body.ttl) : null,
        inputs,
        outputs,
    };
}

async function byronTx(entry: any, ti: number): Promise<ExtractedTx | null> {
    // Same shapes the applier accepts (db.ts applyByronTxPayload): { transaction | tx | body }.
    const tx = entry?.transaction ?? entry?.tx ?? entry?.body ?? entry;
    if (!tx || typeof tx !== "object") return null;
    const ins: any[] = Array.isArray(tx.inputs) ? tx.inputs : Array.isArray(tx.txInputs) ? tx.txInputs : [];
    const outs: any[] = Array.isArray(tx.outputs) ? tx.outputs : Array.isArray(tx.txOutputs) ? tx.txOutputs : [];
    let txId = "";
    try {
        const h = typeof tx.hash === "function" ? tx.hash() : tx.hash;
        if (typeof h?.toString === "function" && /^[0-9a-f]{64}$/i.test(String(h.toString()))) txId = String(h.toString()).toLowerCase();
        else if (typeof tx.toCborBytes === "function") {
            const { blake2b_256 } = await import("@harmoniclabs/crypto");
            txId = toHex(blake2b_256(tx.toCborBytes()));
        }
    } catch { /* below */ }
    if (!txId) return null;
    const inputs: Array<[number, string, number]> = [];
    for (const inp of ins) {
        const id = inp?.utxoRef?.id?.toString?.() ?? inp?.txId?.toString?.() ?? inp?.id?.toString?.() ?? (inp?.txHash != null ? String(inp.txHash) : null);
        const index = inp?.utxoRef?.index ?? inp?.index ?? inp?.outputIndex;
        if (id != null && index != null) inputs.push([inputs.length, String(id).toLowerCase(), Number(index)]);
    }
    const outputs: ExtractedOutput[] = [];
    for (let i = 0; i < outs.length; i++) {
        try { outputs.push(outputRow(txId, i, outs[i])); } catch { /* unreadable Byron output: skip the row, keep the tx */ }
    }
    return { txHash: txId, txIndex: ti, fee: null, size: null, invalidBefore: null, invalidHereafter: null, inputs, outputs };
}

/** Decode one raw block (the `[era, block]` wire form from a chunk) into its explorer deltas. */
export async function extractBlock(blockCbor: Uint8Array, blockHash: Uint8Array, slot: bigint | number): Promise<ExtractedBlock> {
    const m: any = MultiEraBlock.fromCbor(blockCbor);
    const block = m.block;
    const out: ExtractedBlock = { hash: blockHash, slot: Number(slot), blockNo: headerBlockNo(block), txs: [], byron: false };
    if (isByronBlock(block)) {
        out.byron = true;
        const payloads = getByronTxPayloads(block);
        for (let ti = 0; ti < payloads.length; ti++) {
            const t = await byronTx(payloads[ti], ti);
            if (t) out.txs.push(t);
        }
        return out;
    }
    const bodies = getShelleyTxBodies(block);
    // phase-2-invalid transactions are not indexed (only their collateral moves), as in the applier
    const invalid = new Set<number>((block?.invalidTransactions ?? []).map((x: any) => Number(x)));
    for (let ti = 0; ti < bodies.length; ti++) {
        if (invalid.has(ti)) continue;
        const t = shelleyTx(bodies[ti], ti);
        if (t) out.txs.push(t);
    }
    return out;
}

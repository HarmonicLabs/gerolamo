/**
 * Chain reads for the Blockfrost API: blocks (stored block bytes + the explorer's mb_block row),
 * transactions (mb_tx locates the block; the block's bytes are decoded on demand into
 * `TxFact`s, a small cache keeps the last blocks), and resolution of spent outputs
 * (explorer outputs, then the ledger's UTxO set, then the genesis UTxO).
 */
import { getBlockListRowByHash, getBlockListRowByHeight, getBlockListRowBySlot, getMaxBlockNo, getMaxSlot, type BlockListRow } from "../../db";
import { mbSql } from "../../db/minibf/explorerIndexer";
import { blockFacts, type BlockFacts, type OutputFact, type TxFact } from "../../db/minibf/blockFacts";
import { poolIdBech32, vrfKeyBech32 } from "../../db/minibf/cardanoIds";
import { hex } from "../../db/minibf/cborWalk";
import { epochForSlot, slotInEpoch, slotToUnixTime, type EpochNetwork } from "../../utils/epochFromSlotCalculations";
import { sql } from "../../sql";
import { ledgerUtxoReads } from "../../ledger/nodeLedgerStore";
import { badRequest, MSG, notFound } from "./http";
import { ledger } from "./ledger";

export type Row = unknown[];
/** Rows of a query on the explorer projection (read-only connection). */
export async function mb(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
    const r = await (mbSql() as any)(strings, ...values).values();
    return (r as any[]).map((x) => (Array.isArray(x) ? x : Object.values(x)));
}
/** Same, from a dynamic SQL text with positional parameters (callers build only fixed SQL around `?`). */
export async function mbUnsafe(q: string, params: unknown[]): Promise<Row[]> {
    const r = await (mbSql() as any).unsafe(q, params).values();
    return (r as any[]).map((x) => (Array.isArray(x) ? x : Object.values(x)));
}
export const str = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : v instanceof Uint8Array ? hex(v) : String(v));
export const num = (v: unknown): number => Number(v ?? 0);
export const blobHex = (v: unknown): string | null => (v == null ? null : v instanceof Uint8Array ? hex(v) : Buffer.isBuffer(v) ? hex(new Uint8Array(v)) : String(v).toLowerCase());

// ------------------------------------------------------------------ blocks

export interface MbBlockRow { hash: string; slot: number; height: number | null; epoch: number | null; epochSlot: number | null; era: number | null; size: number | null; txCount: number; fees: string | null; output: string | null; leader: string | null; vrf: string | null; opCert: string | null; opCertCounter: number | null }
function toMbBlock(r: Row): MbBlockRow {
    return { hash: blobHex(r[0])!, slot: num(r[1]), height: r[2] == null ? null : num(r[2]), epoch: r[3] == null ? null : num(r[3]), epochSlot: r[4] == null ? null : num(r[4]), era: r[5] == null ? null : num(r[5]), size: r[6] == null ? null : num(r[6]), txCount: num(r[7]), fees: r[8] == null ? null : str(r[8]), output: r[9] == null ? null : str(r[9]), leader: r[10] == null ? null : str(r[10]), vrf: r[11] == null ? null : str(r[11]), opCert: r[12] == null ? null : str(r[12]), opCertCounter: r[13] == null ? null : num(r[13]) };
}
const MB_BLOCK_COLS = "hash, slot, height, epoch, epoch_slot, era, size, tx_count, fees, output, slot_leader, vrf_key, op_cert, op_cert_counter";
export async function mbBlockByHash(hashHex: string): Promise<MbBlockRow | null> {
    try {
        const r = await mbUnsafe(`SELECT ${MB_BLOCK_COLS} FROM mb_block WHERE hash = ?`, [Buffer.from(hashHex, "hex")]);
        return r.length ? toMbBlock(r[0]!) : null;
    } catch { return null; }
}
async function mbBlockHashByHeight(height: number): Promise<string | null> {
    try { const r = await mb`SELECT hash FROM mb_block WHERE height = ${height} LIMIT 1`; return r.length ? blobHex(r[0]![0]) : null; } catch { return null; }
}

/** Block by height: the store's recent window, else the explorer's height index. */
export async function blockByHeight(height: number): Promise<BlockListRow | null> {
    const r = await getBlockListRowByHeight(height);
    if (r) return r;
    const h = await mbBlockHashByHeight(height);
    return h ? getBlockListRowByHash(h) : null;
}

/** `{hash_or_number}`: 64 hex is a hash, digits a height (a slot when no block has that height, Gerolamo's older behaviour). */
export async function resolveBlock(id: string, opts: { slotFallback?: boolean } = {}): Promise<BlockListRow> {
    let row: BlockListRow | null;
    if (id === "latest") {
        const tip = Number(await getMaxSlot());
        row = tip > 0 || (await getBlockListRowBySlot(0)) ? await getBlockListRowBySlot(tip) : null;
    } else if (/^[0-9a-fA-F]{64}$/.test(id)) row = await getBlockListRowByHash(id.toLowerCase());
    else if (/^\d+$/.test(id)) {
        const n = Number(id);
        if (n > 2147483647) throw badRequest(MSG.blockNumber);
        row = await blockByHeight(n);
        if (!row && opts.slotFallback !== false) row = await getBlockListRowBySlot(n);
    } else throw badRequest(/^[0-9a-fA-F]+$/.test(id) ? MSG.blockHash : MSG.blockNumber);
    if (!row) throw notFound();
    return row;
}

const factsCache = new Map<string, BlockFacts>();
/** Decoded facts of a stored block (the last 64 kept). */
export function factsOf(row: BlockListRow): BlockFacts | null {
    const hit = factsCache.get(row.hash);
    if (hit) { factsCache.delete(row.hash); factsCache.set(row.hash, hit); return hit; }
    if (!row.blockData) return null;
    let f: BlockFacts;
    try { f = blockFacts(row.blockData); } catch { return null; }
    factsCache.set(row.hash, f);
    if (factsCache.size > 64) factsCache.delete(factsCache.keys().next().value!);
    return f;
}

export function slotLeaderText(era: number | null, leader: string | null): string {
    if (!leader) return "";
    if (era != null && era < 2) return `ByronGenesis-${leader.slice(0, 16)}`;
    return poolIdBech32(leader);
}

/** Blockfrost `BlockContent`. */
export async function bfBlock(row: BlockListRow, net: EpochNetwork, tip?: { height: number; slot: number }): Promise<Record<string, unknown>> {
    const t = tip ?? { height: await getMaxBlockNo(), slot: Number(await getMaxSlot()) };
    const m = await mbBlockByHash(row.hash);
    const isEbb = row.blockNo == null;
    let era = m?.era ?? null, txCount = m?.txCount ?? 0, fees = m?.fees ?? null, output = m?.output ?? null;
    let leader = m?.leader ?? null, vrf = m?.vrf ?? null, opCert = m?.opCert ?? null, opCertCounter = m?.opCertCounter ?? null;
    if (!m) {
        const f = factsOf(row);
        if (f) {
            era = f.era; txCount = f.txs.length; leader = f.leader; vrf = f.vrfVkey; opCert = f.opCertHotVkey; opCertCounter = f.opCertCounter;
            output = f.txs.reduce((a, tx) => a + (tx.valid ? tx.outputs.reduce((s, o) => s + o.lovelace, 0n) : tx.collateralReturn?.lovelace ?? 0n), 0n).toString();
            fees = f.era >= 2 ? f.txs.reduce((a, tx) => a + (tx.valid ? tx.fee : tx.totalCollateral ?? 0n), 0n).toString() : null;
        }
    }
    let nextBlock: string | null = null;
    if (isEbb) {
        const main = await getBlockListRowBySlot(row.slot);
        nextBlock = main && main.blockNo != null ? main.hash : null;
    } else {
        nextBlock = (await blockByHeight(row.blockNo! + 1))?.hash ?? null;
    }
    return {
        time: slotToUnixTime(row.slot, net),
        height: row.blockNo,
        hash: row.hash,
        slot: row.slot,
        epoch: Number(epochForSlot(row.slot, net)),
        epoch_slot: Number(slotInEpoch(row.slot, net)),
        slot_leader: slotLeaderText(era, leader),
        size: row.size ?? 0,
        tx_count: txCount,
        output: isEbb ? null : output,
        fees: isEbb ? null : fees,
        block_vrf: vrf ? vrfKeyBech32(vrf) : null,
        op_cert: opCert,
        op_cert_counter: opCertCounter == null ? null : String(opCertCounter),
        previous_block: row.prevHash,
        next_block: nextBlock,
        confirmations: row.blockNo != null ? Math.max(0, t.height - row.blockNo) : Math.max(0, t.slot - row.slot),
        ...(isEbb ? { ebb: true } : {}),
    };
}

export async function tipInfo(): Promise<{ height: number; slot: number }> {
    return { height: await getMaxBlockNo(), slot: Number(await getMaxSlot()) };
}

/** Hashes of a block's transactions in order (explorer, else decoded from the block). */
export async function blockTxHashes(row: BlockListRow): Promise<string[]> {
    try {
        const r = await mbUnsafe(`SELECT tx_hash FROM mb_block_tx WHERE block_hash = ? OR block_hash = ? ORDER BY tx_index`, [Buffer.from(row.hash, "hex"), row.hash]);
        if (r.length) return r.map((x) => str(x[0]));
    } catch { /* projection missing */ }
    return factsOf(row)?.txs.map((t) => t.hash) ?? [];
}

// ------------------------------------------------------------------ transactions

export interface TxLoc { hash: string; blockHash: string; slot: number; index: number; height: number | null; valid: boolean; fee: string | null }
export async function txLocation(hash: string): Promise<TxLoc | null> {
    try {
        const r = await mb`SELECT tx_hash, block_hash, slot, tx_index, block_height, valid_contract, fee FROM mb_tx WHERE tx_hash = ${hash.toLowerCase()} LIMIT 1`;
        if (!r.length) return null;
        const x = r[0]!;
        return { hash: str(x[0]), blockHash: blobHex(x[1])!, slot: num(x[2]), index: num(x[3]), height: x[4] == null ? null : num(x[4]), valid: x[5] == null ? true : num(x[5]) !== 0, fee: x[6] == null ? null : str(x[6]) };
    } catch { return null; }
}

export interface TxCtx { loc: TxLoc; block: BlockListRow; facts: BlockFacts; tx: TxFact }
/** A transaction with its block and decoded facts; 404 when unknown. */
export async function txContext(hash: string): Promise<TxCtx> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw notFound();
    const loc = await txLocation(hash);
    if (!loc) throw notFound();
    const block = await getBlockListRowByHash(loc.blockHash);
    if (!block) throw notFound();
    const facts = factsOf(block);
    const tx = facts?.txs.find((t) => t.hash === loc.hash) ?? null;
    if (!facts || !tx) throw notFound();
    return { loc, block, facts, tx };
}

// ------------------------------------------------------------------ outputs

export interface ResolvedOut {
    txHash: string; index: number; address: string | null; lovelace: string; assets: Array<{ unit: string; quantity: string }>;
    dataHash: string | null; inlineDatum: string | null; referenceScriptHash: string | null; consumedBy: string | null;
}

export function amountOf(lovelace: string | bigint, assets: Array<{ unit: string; quantity: string }>): Array<{ unit: string; quantity: string }> {
    return [{ unit: "lovelace", quantity: String(lovelace) }, ...assets];
}
export function assetsOfJson(j: unknown): Array<{ unit: string; quantity: string }> {
    if (!j) return [];
    try {
        const o = typeof j === "string" ? JSON.parse(j) : j;
        const out: Array<{ unit: string; quantity: string }> = [];
        for (const [policy, names] of Object.entries(o as Record<string, Record<string, string>>)) {
            if (!policy || !names) continue;
            for (const [name, q] of Object.entries(names)) out.push({ unit: policy + name, quantity: String(q) });
        }
        return out.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
    } catch { return []; }
}
export function outputFactToResolved(txHash: string, o: OutputFact): ResolvedOut {
    return {
        txHash, index: o.index, address: o.address, lovelace: o.lovelace.toString(),
        assets: o.assets.map((a) => ({ unit: a.policy + a.name, quantity: a.qty.toString() })).sort((a, b) => (a.unit < b.unit ? -1 : 1)),
        dataHash: o.datumHash, inlineDatum: o.inlineDatum ? hex(o.inlineDatum) : null, referenceScriptHash: o.scriptRef?.hash ?? null, consumedBy: null,
    };
}

/** The outputs behind input references, in order (null where nothing knows the output). */
export async function resolveOutputs(refs: Array<{ txHash: string; index: number }>): Promise<Array<ResolvedOut | null>> {
    const out: Array<ResolvedOut | null> = [];
    const missing: number[] = [];
    for (const ref of refs) {
        let r: Row[] = [];
        try { r = await mb`SELECT address, lovelace, assets_json, datum_hash, inline_datum_cbor, script_ref_hash, spent_by_tx FROM mb_tx_out WHERE tx_hash = ${ref.txHash} AND output_index = ${ref.index}`; } catch { /* */ }
        if (r.length) {
            const x = r[0]!;
            out.push({ txHash: ref.txHash, index: ref.index, address: x[0] == null ? null : str(x[0]), lovelace: str(x[1]) || "0", assets: assetsOfJson(x[2]), dataHash: x[3] == null ? null : str(x[3]), inlineDatum: blobHex(x[4]), referenceScriptHash: x[5] == null ? null : str(x[5]), consumedBy: x[6] == null ? null : str(x[6]) });
        } else { out.push(null); missing.push(out.length - 1); }
    }
    if (missing.length) {
        const ur = ledger()?.utxo ?? ledgerUtxoReads();
        for (const i of missing) {
            const ref = refs[i]!;
            const u = ur?.get(`${ref.txHash}:${ref.index}`);
            if (u) {
                let j: any = {};
                try { j = JSON.parse(u.tx_out); } catch { /* */ }
                out[i] = { txHash: ref.txHash, index: ref.index, address: u.address, lovelace: u.lovelace ?? String(j.amount ?? "0"), assets: assetsOfJson(j.assets), dataHash: j.datum_hash ?? null, inlineDatum: j.inline_datum ?? null, referenceScriptHash: u.reference_script_hash, consumedBy: null };
                continue;
            }
            try {
                const g = (await sql`SELECT address, lovelace FROM genesis_utxo WHERE utxo_ref = ${`${ref.txHash}:${ref.index}`}`.values()) as unknown[][];
                if (g.length) out[i] = { txHash: ref.txHash, index: ref.index, address: str(g[0]![0]), lovelace: str(g[0]![1]), assets: [], dataHash: null, inlineDatum: null, referenceScriptHash: null, consumedBy: null };
            } catch { /* no genesis table */ }
        }
    }
    return out;
}

export const blockTime = (slot: number, net: EpochNetwork): number => slotToUnixTime(slot, net);

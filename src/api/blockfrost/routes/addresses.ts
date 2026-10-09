/** Addresses and accounts (stake addresses). */
import { getStoredEpochParams } from "../../../consensus/epochParams";
import { ledgerUtxoReads } from "../../../ledger/nodeLedgerStore";
import type { UtxoRecord } from "../../../ledger/utxoStore";
import { getUtxosByAddress } from "../../../db";
import { parseStoredTxOut } from "../../../db/minibf/txOutMetadata";
import { DREP_ABSTAIN, DREP_NO_CONFIDENCE, drepIdCip129, parseAddress, parseStakeAddress, poolIdBech32, stakeAddressOf, type ParsedAddress } from "../../../db/minibf/cardanoIds";
import { epochForSlot, type EpochNetwork } from "../../../utils/epochFromSlotCalculations";
import { badRequest, fromTo, MSG, notFound, pageOf, paging, type BlockRange, type Paging } from "../http";
import { route, type Ctx, type Route } from "../router";
import { amountOf, assetsOfJson, blobHex, blockTime, mb, mbUnsafe, num, str, type Row } from "../chain";
import { ledger, liveAccountStake, rewardPayout, snapshotCredential, snapshotPoolParam } from "../ledger";
import { currentEpoch } from "./core";

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ helpers

export interface TxMeta { hash: string; slot: number; index: number; height: number | null; blockHash: string | null }
/** Slot, index and height of transactions (one primary-key probe each). */
export async function txMetas(hashes: string[]): Promise<Map<string, TxMeta>> {
    const out = new Map<string, TxMeta>();
    const todo = [...new Set(hashes)];
    // primary-key probes in batches of 500 (one statement each)
    for (let i = 0; i < todo.length; i += 500) {
        const part = todo.slice(i, i + 500);
        const r = await mbUnsafe(`SELECT tx_hash, slot, tx_index, block_height, block_hash FROM mb_tx WHERE tx_hash IN (${part.map(() => "?").join(",")})`, part);
        for (const x of r) out.set(str(x[0]), { hash: str(x[0]), slot: num(x[1]), index: num(x[2]), height: x[3] == null ? null : num(x[3]), blockHash: blobHex(x[4]) });
        if (i + 500 < todo.length) await yieldNow();
    }
    return out;
}
const byChainOrder = (a: TxMeta, b: TxMeta) => a.slot - b.slot || a.index - b.index;

function inRange(m: TxMeta, r: BlockRange): boolean {
    const h = m.height ?? 0;
    if (r.fromHeight != null && (h < r.fromHeight || (h === r.fromHeight && r.fromIndex != null && m.index < r.fromIndex))) return false;
    if (r.toHeight != null && (h > r.toHeight || (h === r.toHeight && r.toIndex != null && m.index > r.toIndex))) return false;
    return true;
}

function sumUnits(rows: Array<{ lovelace: string; assets: Array<{ unit: string; quantity: string }> }>): Array<{ unit: string; quantity: string }> {
    let lovelace = 0n;
    const units = new Map<string, bigint>();
    for (const r of rows) { lovelace += BigInt(r.lovelace || "0"); for (const a of r.assets) units.set(a.unit, (units.get(a.unit) ?? 0n) + BigInt(a.quantity)); }
    return amountOf(lovelace, [...units].filter(([, q]) => q !== 0n).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([unit, q]) => ({ unit, quantity: q.toString() })));
}

/** A current UTxO in Blockfrost shape (before the block hash is attached). */
interface Utxo { address: string; txHash: string; index: number; lovelace: string; assets: Array<{ unit: string; quantity: string }>; dataHash: string | null; inlineDatum: string | null; refScript: string | null }
function utxoOfRecord(u: UtxoRecord): Utxo {
    const j = parseStoredTxOut(u.tx_out);
    const i = u.utxo_ref.lastIndexOf(":");
    return { address: u.address ?? j.address, txHash: u.utxo_ref.slice(0, i), index: Number(u.utxo_ref.slice(i + 1)), lovelace: u.lovelace ?? j.amount, assets: assetsOfJson(j.assets), dataHash: j.datumHash, inlineDatum: j.inlineDatumCbor, refScript: u.reference_script_hash ?? j.scriptRefHash };
}
function utxoOfRow(r: Row): Utxo {
    return { address: str(r[0]), txHash: str(r[1]), index: num(r[2]), lovelace: str(r[3]) || "0", assets: assetsOfJson(r[4]), dataHash: r[5] == null ? null : str(r[5]), inlineDatum: blobHex(r[6]), refScript: r[7] == null ? null : str(r[7]) };
}
const UTXO_COLS = "address, tx_hash, output_index, lovelace, assets_json, datum_hash, inline_datum_cbor, script_ref_hash";

/** Current UTxOs of an address: the ledger's UTxO set for a full address, the projection for a payment credential. */
async function addressUtxos(a: ParsedAddress): Promise<Utxo[]> {
    if (a.kind !== "payment_cred") {
        const ur = ledger()?.utxo ?? ledgerUtxoReads();
        if (ur) return ur.byAddress(a.address).map(utxoOfRecord);
        return (await getUtxosByAddress(a.address)).map((u: any) => utxoOfRecord({ utxo_ref: u.utxo_ref, tx_out: u.tx_out, tx_hash: u.tx_hash ?? null, address: a.address, lovelace: null, reference_script_hash: null, stake_key: null }));
    }
    const pc = (a.payment!.type === 1 ? "01" : "") + a.payment!.hash;
    return (await mbUnsafe(`SELECT ${UTXO_COLS} FROM mb_tx_out WHERE payment_cred = ? AND spent_by_tx IS NULL`, [pc])).map(utxoOfRow);
}

/** Order UTxOs by creation (block, transaction, output) and page them; attaches the block hash. */
async function utxoPage(list: Utxo[], p: Paging): Promise<unknown[]> {
    const metas = await txMetas([...new Set(list.map((u) => u.txHash))]);
    const key = (u: Utxo) => { const m = metas.get(u.txHash); return [m?.slot ?? 0, m?.index ?? 0, u.index] as const; };
    const sorted = [...list].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
    return pageOf(sorted, p).map((u) => ({
        address: u.address, tx_hash: u.txHash, tx_index: u.index, output_index: u.index, amount: amountOf(u.lovelace, u.assets),
        block: metas.get(u.txHash)?.blockHash ?? "", data_hash: u.dataHash, inline_datum: u.inlineDatum, reference_script_hash: u.refScript,
    }));
}

function addr(c: Ctx): ParsedAddress {
    const a = parseAddress(c.params.address!, c.network);
    if (!a) throw badRequest(MSG.address);
    return a;
}

/** Has the address (or payment credential) ever appeared in an output? */
async function addressSeen(a: ParsedAddress, utxos: Utxo[] | null): Promise<boolean> {
    if (utxos && utxos.length) return true;
    if (a.kind === "payment_cred") return (await mbUnsafe(`SELECT 1 FROM mb_tx_out WHERE payment_cred = ? LIMIT 1`, [(a.payment!.type === 1 ? "01" : "") + a.payment!.hash])).length > 0;
    if ((await mb`SELECT 1 FROM mb_address_tx WHERE address = ${a.address} LIMIT 1`).length) return true;
    return (await mb`SELECT 1 FROM mb_tx_out WHERE address = ${a.address} LIMIT 1`).length > 0;
}

/** One page of an address's transactions in chain order (SQL-paged for full addresses; `from`/`to` are block heights). */
async function addressTxPage(a: ParsedAddress, p: Paging, r: BlockRange): Promise<TxMeta[]> {
    if (a.kind === "payment_cred") return pageOf((await addressTxMetas(a)).filter((m) => inRange(m, r)), p);
    const o = p.order === "desc" ? "DESC" : "ASC";
    const where: string[] = ["a.address = ?"];
    const params: unknown[] = [a.address];
    if (r.fromHeight != null) { where.push("(t.block_height > ? OR (t.block_height = ? AND t.tx_index >= ?))"); params.push(r.fromHeight, r.fromHeight, r.fromIndex ?? 0); }
    if (r.toHeight != null) { where.push("(t.block_height < ? OR (t.block_height = ? AND t.tx_index <= ?))"); params.push(r.toHeight, r.toHeight, r.toIndex ?? 2147483647); }
    const rows = await mbUnsafe(`SELECT a.tx_hash, a.slot, a.tx_index, t.block_height, t.block_hash FROM mb_address_tx a LEFT JOIN mb_tx t ON t.tx_hash = a.tx_hash
        WHERE ${where.join(" AND ")} ORDER BY a.slot ${o}, a.tx_index ${o} LIMIT ? OFFSET ?`, [...params, p.count, p.offset]);
    return rows.map((x) => ({ hash: str(x[0]), slot: num(x[1]), index: num(x[2]), height: x[3] == null ? null : num(x[3]), blockHash: blobHex(x[4]) }));
}

async function addressTxCount(a: ParsedAddress): Promise<number> {
    if (a.kind === "payment_cred") return (await addressTxMetas(a)).length;
    return num((await mb`SELECT COUNT(*) FROM mb_address_tx WHERE address = ${a.address}`)[0]?.[0]);
}

/** Transactions touching an address, in chain order. */
async function addressTxMetas(a: ParsedAddress): Promise<TxMeta[]> {
    let hashes: string[];
    if (a.kind === "payment_cred") {
        const pc = (a.payment!.type === 1 ? "01" : "") + a.payment!.hash;
        const r = await mbUnsafe(`SELECT tx_hash, spent_by_tx FROM mb_tx_out WHERE payment_cred = ?`, [pc]);
        hashes = [...new Set(r.flatMap((x) => [str(x[0]), ...(x[1] == null ? [] : [str(x[1])])]))];
    } else {
        hashes = (await mb`SELECT tx_hash FROM mb_address_tx WHERE address = ${a.address}`).map((x) => str(x[0]));
    }
    const metas = await txMetas(hashes);
    return [...metas.values()].sort(byChainOrder);
}

/** All outputs ever paid to an address (for totals). */
async function addressOutputs(a: ParsedAddress): Promise<Row[]> {
    if (a.kind === "payment_cred") return mbUnsafe(`SELECT lovelace, assets_json, spent_by_tx FROM mb_tx_out WHERE payment_cred = ?`, [(a.payment!.type === 1 ? "01" : "") + a.payment!.hash]);
    return mb`SELECT lovelace, assets_json, spent_by_tx FROM mb_tx_out WHERE address = ${a.address}`;
}

async function hasNftMetadata(unit: string): Promise<boolean> {
    if (unit.length < 56) return false;
    const r = await mb`SELECT 1 FROM mb_mint m JOIN mb_tx_meta t ON t.tx_hash = m.tx_hash AND t.label = '721' WHERE m.unit = ${unit} LIMIT 1`;
    if (r.length) return true;
    return unit.slice(56).startsWith("000de140");
}

// ------------------------------------------------------------------ accounts

function stake(c: Ctx): string {
    const raw = c.params.stake_address!;
    let t = parseStakeAddress(raw, c.network);
    if (!t) { const a = parseAddress(raw, c.network); t = a?.stakeTyped ?? null; } // a base address names its stake key too
    if (!t) throw badRequest(MSG.stake);
    return t;
}

async function accountSeen(typed: string): Promise<boolean> {
    const l = ledger();
    if (l && (l.stake.isRegistered(typed) || l.stake.rewardBalance(typed) > 0n || l.stake.stakeBalance(typed) > 0n)) return true;
    if ((await mb`SELECT 1 FROM mb_cert WHERE stake = ${typed} LIMIT 1`).length) return true;
    return (await mbUnsafe(`SELECT 1 FROM mb_tx_out WHERE stake_cred = ? LIMIT 1`, [typed])).length > 0;
}

async function certHistory(typed: string, tags: number[], p: Paging): Promise<Row[]> {
    const order = p.order === "desc" ? "DESC" : "ASC";
    return mbUnsafe(`SELECT c.tx_hash, c.cert_index, c.slot, c.tx_index, c.tag, c.pool, c.coin, c.drep, t.block_height FROM mb_cert c LEFT JOIN mb_tx t ON t.tx_hash = c.tx_hash
        WHERE c.stake = ? AND c.tag IN (${tags.map(() => "?").join(",")}) ORDER BY c.slot ${order}, c.tx_index ${order}, c.cert_index ${order} LIMIT ? OFFSET ?`, [typed, ...tags, p.count, p.offset]);
}

function drepIdOf(d: { type: number; hash: string | null }): string {
    if (d.type === 2) return DREP_ABSTAIN;
    if (d.type === 3) return DREP_NO_CONFIDENCE;
    return drepIdCip129(d.type, d.hash ?? "");
}

async function accountJson(c: Ctx, typed: string): Promise<Record<string, unknown>> {
    const l = ledger();
    const registered = l?.stake.isRegistered(typed) ?? false;
    const pool = l?.stake.delegationOf(typed) ?? null;
    const withdrawable = l?.stake.rewardBalance(typed) ?? 0n;
    const sum = async (q: Promise<Row[]>) => BigInt(str((await q)[0]?.[0]) || "0");
    const withdrawals = await sum(mb`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) FROM mb_withdrawal WHERE stake = ${typed}`);
    const reserves = await sum(mb`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) FROM mb_mir WHERE stake = ${typed} AND pot = 'reserve'`);
    const treasury = await sum(mb`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) FROM mb_mir WHERE stake = ${typed} AND pot = 'treasury'`);
    const last = await mbUnsafe(`SELECT slot FROM mb_cert WHERE stake = ? AND tag IN (0, 1, 7, 8, 11, 12, 13) ORDER BY slot DESC LIMIT 1`, [typed]);
    const drep = l?.gov.drepDelegation(typed) ?? null;
    return {
        stake_address: stakeAddressOf(typed, c.network),
        active: registered && pool != null,
        registered,
        active_epoch: last.length ? Number(epochForSlot(num(last[0]![0]), c.net)) : null,
        controlled_amount: (l ? liveAccountStake(l, typed) : 0n).toString(),
        rewards_sum: (withdrawable + withdrawals).toString(),
        withdrawals_sum: withdrawals.toString(),
        reserves_sum: reserves.toString(),
        treasury_sum: treasury.toString(),
        withdrawable_amount: withdrawable.toString(),
        pool_id: pool ? poolIdBech32(pool) : null,
        drep_id: drep && registered ? drepIdOf(drep) : null,
    };
}

async function stakeOutputs(typed: string, unspentOnly: boolean): Promise<Row[]> {
    return mbUnsafe(`SELECT ${UTXO_COLS}, spent_by_tx FROM mb_tx_out WHERE stake_cred = ?${unspentOnly ? " AND spent_by_tx IS NULL" : ""}`, [typed]);
}

async function needAccount(c: Ctx): Promise<string> {
    const t = stake(c);
    if (!(await accountSeen(t))) throw notFound();
    return t;
}

const blockOf = (net: EpochNetwork) => (slot: number) => blockTime(slot, net);

export const addressRoutes: Route[] = [
    route("GET", "/addresses/{address}", async (c) => {
        const a = addr(c);
        const utxos = await addressUtxos(a);
        if (!(await addressSeen(a, utxos))) throw notFound();
        return { address: a.address, amount: sumUnits(utxos), stake_address: a.stakeTyped ? stakeAddressOf(a.stakeTyped, c.network) : null, type: a.type, script: a.script };
    }),
    route("GET", "/addresses/{address}/extended", async (c) => {
        const a = addr(c);
        const utxos = await addressUtxos(a);
        if (!(await addressSeen(a, utxos))) throw notFound();
        const amount: unknown[] = [];
        for (const x of sumUnits(utxos)) amount.push({ ...x, decimals: x.unit === "lovelace" ? 6 : null, has_nft_onchain_metadata: x.unit === "lovelace" ? false : await hasNftMetadata(x.unit) });
        return { address: a.address, amount, stake_address: a.stakeTyped ? stakeAddressOf(a.stakeTyped, c.network) : null, type: a.type, script: a.script };
    }),
    route("GET", "/addresses/{address}/total", async (c) => {
        const a = addr(c);
        const outs = await addressOutputs(a);
        if (!outs.length && !(await addressSeen(a, null))) throw notFound();
        const recv: Array<{ lovelace: string; assets: Array<{ unit: string; quantity: string }> }> = [], sent: typeof recv = [];
        let n = 0;
        for (const r of outs) {
            const v = { lovelace: str(r[0]) || "0", assets: assetsOfJson(r[1]) };
            recv.push(v); if (r[2] != null) sent.push(v);
            if (++n % 5000 === 0) await yieldNow();
        }
        return { address: a.address, received_sum: sumUnits(recv), sent_sum: sumUnits(sent), tx_count: await addressTxCount(a) };
    }),
    route("GET", "/addresses/{address}/utxos", async (c) => {
        const a = addr(c);
        const p = paging(c.url);
        const utxos = await addressUtxos(a);
        if (!(await addressSeen(a, utxos))) throw notFound();
        return utxoPage(utxos, p);
    }),
    route("GET", "/addresses/{address}/utxos/{asset}", async (c) => {
        const a = addr(c);
        const asset = c.params.asset!.toLowerCase();
        if (asset !== "lovelace" && !/^[0-9a-f]{56,120}$/.test(asset)) throw badRequest(MSG.asset);
        const p = paging(c.url);
        const utxos = await addressUtxos(a);
        if (!(await addressSeen(a, utxos))) throw notFound();
        return utxoPage(utxos.filter((u) => (asset === "lovelace" ? u.assets.length === 0 : u.assets.some((x) => x.unit === asset))), p);
    }),
    route("GET", "/addresses/{address}/txs", async (c) => {
        const a = addr(c);
        const p = paging(c.url);
        const page = await addressTxPage(a, p, { fromHeight: null, fromIndex: null, toHeight: null, toIndex: null });
        if (!page.length && !(await addressSeen(a, null))) throw notFound();
        return page.map((m) => m.hash);
    }),
    route("GET", "/addresses/{address}/transactions", async (c) => {
        const a = addr(c);
        const p = paging(c.url);
        const r = fromTo(c.url);
        const page = await addressTxPage(a, p, r);
        if (!page.length && !(await addressSeen(a, null))) throw notFound();
        return page.map((m) => ({ tx_hash: m.hash, tx_index: m.index, block_height: m.height ?? 0, block_time: blockTime(m.slot, c.net) }));
    }),

    route("GET", "/accounts/{stake_address}", async (c) => {
        const t = await needAccount(c);
        return accountJson(c, t);
    }),
    route("GET", "/accounts/{stake_address}/rewards", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const l = ledger();
        if (!l) return [];
        const cur = await currentEpoch(c.net);
        const out: Array<{ epoch: number; amount: string; pool_id: string; type: string }> = [];
        for (let e = Math.max(0, cur - 80); e <= cur; e++) {
            const amt = rewardPayout(l.stake, e, t);
            if (amt <= 0n) continue;
            const snap = snapshotCredential(l.stake, e - 1, t);
            const pool = snap?.pool ?? l.stake.delegationOf(t) ?? "";
            const params = pool ? snapshotPoolParam(l.stake, e - 1, pool)?.params ?? l.stake.pool(pool)?.params ?? null : null;
            out.push({ epoch: e, amount: amt.toString(), pool_id: pool ? poolIdBech32(pool) : "", type: params?.rewardAccount === t ? "leader" : "member" });
        }
        return pageOf(out, p);
    }),
    route("GET", "/accounts/{stake_address}/history", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const l = ledger();
        if (!l) return [];
        const out: Array<{ active_epoch: number; amount: string; pool_id: string }> = [];
        for (const takenAt of [...l.stake.snapshotEpochs()].sort((a, b) => a - b)) {
            const s = snapshotCredential(l.stake, takenAt, t);
            if (s) out.push({ active_epoch: takenAt + 1, amount: s.stake.toString(), pool_id: poolIdBech32(s.pool) });
        }
        return pageOf(out, p);
    }),
    route("GET", "/accounts/{stake_address}/delegations", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const rows = await certHistory(t, [2, 10, 11, 13], p);
        const out: unknown[] = [];
        for (const r of rows) {
            const o = await mb`SELECT COALESCE(SUM(CAST(lovelace AS INTEGER)), 0) FROM mb_tx_out WHERE tx_hash = ${str(r[0])}`;
            out.push({ active_epoch: Number(epochForSlot(num(r[2]), c.net)) + 2, tx_hash: str(r[0]), amount: str(o[0]?.[0]) || "0", pool_id: poolIdBech32(str(r[5])), tx_slot: num(r[2]), block_time: blockTime(num(r[2]), c.net), block_height: num(r[8]) });
        }
        return out;
    }),
    route("GET", "/accounts/{stake_address}/registrations", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const rows = await certHistory(t, [0, 1, 7, 8, 11, 12, 13], p);
        const out: unknown[] = [];
        for (const r of rows) {
            const tag = num(r[4]);
            const reg = tag !== 1 && tag !== 8;
            let deposit: string | null = null;
            if (reg) deposit = r[6] != null ? str(r[6]) : String((await getStoredEpochParams(Number(epochForSlot(num(r[2]), c.net))))?.key_deposit ?? "0");
            out.push({ tx_hash: str(r[0]), action: reg ? "registered" : "deregistered", deposit, tx_slot: num(r[2]), block_time: blockTime(num(r[2]), c.net), block_height: num(r[8]) });
        }
        return out;
    }),
    route("GET", "/accounts/{stake_address}/withdrawals", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT w.tx_hash, w.amount, w.slot, t.block_height FROM mb_withdrawal w LEFT JOIN mb_tx t ON t.tx_hash = w.tx_hash WHERE w.stake = ? ORDER BY w.slot ${o}, w.tx_index ${o} LIMIT ? OFFSET ?`, [t, p.count, p.offset]);
        return rows.map((r) => ({ tx_hash: str(r[0]), amount: str(r[1]), tx_slot: num(r[2]), block_time: blockTime(num(r[2]), c.net), block_height: num(r[3]) }));
    }),
    route("GET", "/accounts/{stake_address}/mirs", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT m.tx_hash, m.amount, m.slot, t.block_height FROM mb_mir m LEFT JOIN mb_tx t ON t.tx_hash = m.tx_hash WHERE m.stake = ? ORDER BY m.slot ${o}, m.tx_index ${o} LIMIT ? OFFSET ?`, [t, p.count, p.offset]);
        return rows.map((r) => ({ tx_hash: str(r[0]), amount: str(r[1]), tx_slot: num(r[2]), block_time: blockTime(num(r[2]), c.net), block_height: num(r[3]) }));
    }),
    route("GET", "/accounts/{stake_address}/addresses", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT address FROM mb_tx_out WHERE stake_cred = ? GROUP BY address ORDER BY MIN(rowid) ${o} LIMIT ? OFFSET ?`, [t, p.count, p.offset]);
        return rows.map((r) => ({ address: str(r[0]) }));
    }),
    route("GET", "/accounts/{stake_address}/addresses/assets", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const units = sumUnits((await stakeOutputs(t, true)).map((r) => ({ lovelace: "0", assets: assetsOfJson(r[4]) }))).slice(1);
        return pageOf(units, p);
    }),
    route("GET", "/accounts/{stake_address}/addresses/total", async (c) => {
        const t = await needAccount(c);
        const outs = await stakeOutputs(t, false);
        const recv = outs.map((r) => ({ lovelace: str(r[3]) || "0", assets: assetsOfJson(r[4]) }));
        const sent = outs.filter((r) => r[8] != null).map((r) => ({ lovelace: str(r[3]) || "0", assets: assetsOfJson(r[4]) }));
        const txs = new Set(outs.flatMap((r) => [str(r[1]), ...(r[8] == null ? [] : [str(r[8])])]));
        return { stake_address: stakeAddressOf(t, c.network), received_sum: sumUnits(recv), sent_sum: sumUnits(sent), tx_count: txs.size };
    }),
    route("GET", "/accounts/{stake_address}/utxos", async (c) => {
        const t = await needAccount(c);
        return utxoPage((await stakeOutputs(t, true)).map(utxoOfRow), paging(c.url));
    }),
    route("GET", "/accounts/{stake_address}/transactions", async (c) => {
        const t = await needAccount(c);
        const p = paging(c.url);
        const r = fromTo(c.url);
        const outs = await stakeOutputs(t, false);
        const addrOf = new Map<string, string>();
        for (const o of outs) { addrOf.set(str(o[1]), str(o[0])); if (o[8] != null && !addrOf.has(str(o[8]))) addrOf.set(str(o[8]), str(o[0])); }
        const metas = [...(await txMetas([...addrOf.keys()])).values()].sort(byChainOrder).filter((m) => inRange(m, r));
        return pageOf(metas, p).map((m) => ({ address: addrOf.get(m.hash) ?? "", tx_hash: m.hash, tx_index: m.index, block_height: m.height ?? 0, block_time: blockTime(m.slot, c.net) }));
    }),
];
void blockOf;

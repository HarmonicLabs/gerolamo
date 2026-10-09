/** Root, health, genesis, network, eras, epochs and blocks. */
import { getBlockListRowBySlot, getEpochNonce, getMaxSlot, listBlocksDesc, listBlocksInSlotRange, countBlocksInSlotRange, type BlockListRow } from "../../../db";
import { getStoredEpochParams } from "../../../consensus/epochParams";
import { PARAM_NAMES_V1, PARAM_NAMES_V2, PARAM_NAMES_V3 } from "../../../consensus/plutus/paramNames";
import { genesis as genesisFile } from "../../../network/n2c/lsq/queries";
import { eraTable, type EraHistoryNetwork } from "../../../network/n2c/eraHistory";
import { epochForSlot, epochLengthSlots, firstSlotOfEpoch, slotInEpoch, slotToUnixTime, type EpochNetwork } from "../../../utils/epochFromSlotCalculations";
import { hex } from "../../../db/minibf/cborWalk";
import { poolIdBech32, stakeAddressOf, parsePoolId } from "../../../db/minibf/cardanoIds";
import { txCbor } from "../../../db/minibf/blockFacts";
import { badRequest, intParam, MSG, notFound, pageOf, paging } from "../http";
import { route, type Ctx, type Route } from "../router";
import { bfBlock, blockByHeight, blockTxHashes, factsOf, mb, num, resolveBlock, resolveOutputs, str, tipInfo } from "../chain";
import { ledger, liveIndex } from "../ledger";

export const API_VERSION = "0.1.92";

const publicNet = (n: string): EraHistoryNetwork | null => (n === "preview" || n === "preprod" || n === "mainnet" ? n : null);

function genesisOf(c: Ctx): any {
    try { return genesisFile(publicNet(c.network) ?? (c.network as EraHistoryNetwork), "shelley"); } catch { return null; }
}

// ------------------------------------------------------------------ epochs

const epochCache = new Map<number, Record<string, unknown>>();
let networkCache: { at: number; network: string; body: unknown } | null = null;

/** Blockfrost `EpochContent`; completed epochs are cached. */
export async function bfEpoch(epoch: number, net: EpochNetwork): Promise<Record<string, unknown>> {
    const hit = epochCache.get(epoch);
    if (hit) return hit;
    const from = Number(firstSlotOfEpoch(epoch, net));
    const len = Number(epochLengthSlots(epoch, net));
    const to = from + len;
    const tipSlot = Number(await getMaxSlot());
    const blockCount = await countBlocksInSlotRange(from, to);
    let first: BlockListRow | null = null, last: BlockListRow | null = null;
    if (blockCount > 0) {
        first = (await listBlocksInSlotRange(from, to, 1))[0] ?? null;
        last = (await listBlocksInSlotRange(from, to, 1, blockCount - 1))[0] ?? null;
    }
    let txCount = 0, fees = 0n, output = 0n;
    try {
        const agg = await mb`SELECT COUNT(*), COALESCE(SUM(tx_count), 0), COALESCE(SUM(CAST(fees AS INTEGER)), 0), COALESCE(SUM(CAST(output AS INTEGER)), 0) FROM mb_block WHERE epoch = ${epoch}`;
        const [n, tc, fe, ou] = agg[0] ?? [0, 0, 0, 0];
        if (num(n) >= blockCount && num(n) > 0) { txCount = num(tc); fees = BigInt(str(fe) || "0"); output = BigInt(str(ou) || "0"); }
        else {
            // blocks indexed before the v2 projection: the transaction rows still cover them
            const t = await mb`SELECT COUNT(*), COALESCE(SUM(CAST(fee AS INTEGER)), 0) FROM mb_tx WHERE slot >= ${from} AND slot < ${to}`;
            txCount = num(t[0]?.[0]); fees = BigInt(str(t[0]?.[1]) || "0");
            const o = await mb`SELECT COALESCE(SUM(CAST(o.lovelace AS INTEGER)), 0) FROM mb_tx t JOIN mb_tx_out o ON o.tx_hash = t.tx_hash WHERE t.slot >= ${from} AND t.slot < ${to} AND COALESCE(t.valid_contract, 1) = 1`;
            output = BigInt(str(o[0]?.[0]) || "0");
        }
    } catch { /* projection missing */ }
    const l = ledger();
    const active = l?.stake.snapshotTotals(epoch - 1)?.total ?? null;
    const startTime = slotToUnixTime(from, net);
    const out: Record<string, unknown> = {
        epoch,
        start_time: startTime,
        end_time: slotToUnixTime(to, net),
        first_block_time: first ? slotToUnixTime(first.slot, net) : startTime,
        last_block_time: last ? slotToUnixTime(last.slot, net) : startTime,
        block_count: blockCount,
        tx_count: txCount,
        output: output.toString(),
        fees: fees.toString(),
        active_stake: active == null ? null : active.toString(),
        // Gerolamo extensions
        epoch_nonce: await getEpochNonce(epoch).catch(() => null),
        first_block: first?.hash ?? null,
        last_block: last?.hash ?? null,
        first_slot: from,
        last_slot: to - 1,
        synced: tipSlot >= to - 1 ? "complete" : tipSlot >= from ? "partial" : "none",
    };
    if (tipSlot >= to + 2160) epochCache.set(epoch, out);
    return out;
}

const COST_NAMES: Record<string, readonly string[]> = { PlutusV1: PARAM_NAMES_V1, PlutusV2: PARAM_NAMES_V2, PlutusV3: PARAM_NAMES_V3 };
const S = (v: unknown): string | null => (v == null ? null : String(v));
const N = (v: unknown): number | null => (v == null ? null : Number(v));

/** Stored parameter record → Blockfrost `EpochParamContent` (strings where Blockfrost has strings, named cost models). */
export function bfParams(epoch: number, p: Record<string, unknown>, nonce: string | null): Record<string, unknown> {
    const cm = (p.cost_models ?? null) as Record<string, unknown> | null;
    let named: Record<string, unknown> | null = null, raw: Record<string, unknown> | null = null;
    if (cm) {
        named = {}; raw = {};
        for (const [lang, v] of Object.entries(cm)) {
            if (Array.isArray(v)) {
                raw[lang] = v;
                const names = COST_NAMES[lang];
                named[lang] = names && names.length >= v.length ? Object.fromEntries(v.map((x, i) => [names[i]!, x])) : Object.fromEntries(v.map((x, i) => [String(i).padStart(3, "0"), x]));
            } else if (v && typeof v === "object") { named[lang] = v; raw[lang] = Object.values(v as Record<string, unknown>); }
        }
    }
    return {
        epoch,
        min_fee_a: N(p.min_fee_a) ?? 0, min_fee_b: N(p.min_fee_b) ?? 0,
        max_block_size: N(p.max_block_size) ?? 0, max_tx_size: N(p.max_tx_size) ?? 0, max_block_header_size: N(p.max_block_header_size) ?? 0,
        key_deposit: S(p.key_deposit) ?? "0", pool_deposit: S(p.pool_deposit) ?? "0",
        e_max: N(p.e_max) ?? 0, n_opt: N(p.n_opt) ?? 0, a0: N(p.a0) ?? 0, rho: N(p.rho) ?? 0, tau: N(p.tau) ?? 0,
        decentralisation_param: N(p.decentralisation_param) ?? 0,
        extra_entropy: p.extra_entropy == null ? null : typeof p.extra_entropy === "string" ? p.extra_entropy : JSON.stringify(p.extra_entropy),
        protocol_major_ver: N(p.protocol_major_ver) ?? 0, protocol_minor_ver: N(p.protocol_minor_ver) ?? 0,
        min_utxo: S(p.min_utxo ?? p.coins_per_utxo_size ?? p.coins_per_utxo_word) ?? "0",
        min_pool_cost: S(p.min_pool_cost) ?? "0",
        nonce: nonce ?? S(p.nonce) ?? "",
        cost_models: named, cost_models_raw: raw,
        price_mem: N(p.price_mem), price_step: N(p.price_step),
        max_tx_ex_mem: S(p.max_tx_ex_mem), max_tx_ex_steps: S(p.max_tx_ex_steps),
        max_block_ex_mem: S(p.max_block_ex_mem), max_block_ex_steps: S(p.max_block_ex_steps),
        max_val_size: S(p.max_val_size), collateral_percent: N(p.collateral_percent), max_collateral_inputs: N(p.max_collateral_inputs),
        coins_per_utxo_size: S(p.coins_per_utxo_size), coins_per_utxo_word: S(p.coins_per_utxo_word ?? p.coins_per_utxo_size),
        pvt_motion_no_confidence: N(p.pvt_motion_no_confidence), pvt_committee_normal: N(p.pvt_committee_normal), pvt_committee_no_confidence: N(p.pvt_committee_no_confidence),
        pvt_hard_fork_initiation: N(p.pvt_hard_fork_initiation), dvt_motion_no_confidence: N(p.dvt_motion_no_confidence), dvt_committee_normal: N(p.dvt_committee_normal),
        dvt_committee_no_confidence: N(p.dvt_committee_no_confidence), dvt_update_to_constitution: N(p.dvt_update_to_constitution), dvt_hard_fork_initiation: N(p.dvt_hard_fork_initiation),
        dvt_p_p_network_group: N(p.dvt_p_p_network_group), dvt_p_p_economic_group: N(p.dvt_p_p_economic_group), dvt_p_p_technical_group: N(p.dvt_p_p_technical_group),
        dvt_p_p_gov_group: N(p.dvt_p_p_gov_group), dvt_treasury_withdrawal: N(p.dvt_treasury_withdrawal),
        committee_min_size: S(p.committee_min_size), committee_max_term_length: S(p.committee_max_term_length),
        gov_action_lifetime: S(p.gov_action_lifetime), gov_action_deposit: S(p.gov_action_deposit), drep_deposit: S(p.drep_deposit), drep_activity: S(p.drep_activity),
        pvtpp_security_group: N(p.pvt_p_p_security_group ?? p.pvtpp_security_group), pvt_p_p_security_group: N(p.pvt_p_p_security_group ?? p.pvtpp_security_group),
        min_fee_ref_script_cost_per_byte: N(p.min_fee_ref_script_cost_per_byte),
    };
}

export async function paramsFor(epoch: number): Promise<Record<string, unknown>> {
    const p = await getStoredEpochParams(epoch);
    if (!p) throw notFound();
    return bfParams(epoch, p, await getEpochNonce(epoch).catch(() => null));
}

export async function currentEpoch(net: EpochNetwork): Promise<number> {
    return Number(epochForSlot(Number(await getMaxSlot()), net));
}

function epochParam(c: Ctx): number { return intParam(c.params.number!, MSG.epoch); }

async function epochExists(c: Ctx, epoch: number): Promise<void> {
    if (epoch > (await currentEpoch(c.net))) throw notFound();
}

const stakesCache = new Map<number, Array<{ cred: string; pool: string; stake: bigint }>>();
async function snapshotStakes(takenAt: number): Promise<Array<{ cred: string; pool: string; stake: bigint }>> {
    const hit = stakesCache.get(takenAt);
    if (hit) return hit;
    const l = ledger();
    if (!l) return [];
    const rows = [...l.stake.snapshotCredentials(takenAt)].map(([cred, v]) => ({ cred, pool: v.pool, stake: v.stake })).sort((a, b) => (a.cred < b.cred ? -1 : 1));
    stakesCache.set(takenAt, rows);
    if (stakesCache.size > 3) stakesCache.delete(stakesCache.keys().next().value!);
    return rows;
}

// ------------------------------------------------------------------ eras

function bfEras(c: Ctx, tipSlot: number): unknown[] {
    const n = publicNet(c.network);
    if (!n) return [];
    const t = eraTable(n);
    const byronLen = t.byron.epochSlots, shLen = t.shelley.epochSlots;
    const shelleyStart = t.eraStartEpochs[1]!;
    const slotOf = (e: number) => (e <= shelleyStart ? e * byronLen : shelleyStart * byronLen + (e - shelleyStart) * shLen);
    const timeOf = (e: number) => (e <= shelleyStart ? e * byronLen * (t.byron.slotMs / 1000) : shelleyStart * byronLen * (t.byron.slotMs / 1000) + (e - shelleyStart) * shLen * (t.shelley.slotMs / 1000));
    const cur = Number(epochForSlot(tipSlot, c.net));
    const inSafe = Number(slotInEpoch(tipSlot, c.net)) >= shLen - t.shelley.safeZone;
    const horizon = cur + (inSafe ? 2 : 1);
    const starts = t.eraStartEpochs;
    return starts.map((s, i) => {
        const e = i + 1 < starts.length ? starts[i + 1]! : horizon;
        const g = i === 0 ? t.byron : t.shelley;
        return {
            start: { time: timeOf(s), slot: slotOf(s), epoch: s },
            end: { time: timeOf(e), slot: slotOf(e), epoch: e },
            parameters: { epoch_length: g.epochSlots, slot_length: g.slotMs / 1000, safe_zone: g.safeZone },
        };
    });
}

// ------------------------------------------------------------------ blocks

async function blockList(rows: BlockListRow[], c: Ctx): Promise<unknown[]> {
    const tip = await tipInfo();
    const out: unknown[] = [];
    for (const r of rows) out.push(await bfBlock(r, c.net, tip));
    return out;
}

/** Blocks after `row` in chain order (EBBs included), skipping `skip` and returning `count`. */
async function blocksAfter(row: BlockListRow, skip: number, count: number): Promise<BlockListRow[]> {
    const out: BlockListRow[] = [];
    let seen = 0;
    const take = (b: BlockListRow) => { if (seen++ >= skip && out.length < count) out.push(b); };
    let cur: BlockListRow = row;
    if (cur.blockNo == null) {
        const main = await getBlockListRowBySlot(cur.slot);
        if (!main || main.blockNo == null) return out;
        take(main); cur = main;
    }
    while (out.length < count) {
        const n = await blockByHeight(cur.blockNo! + 1);
        if (!n) break;
        // a Byron epoch-boundary block sits between an epoch's last block and the next epoch's first one
        if (n.prevHash && n.prevHash !== cur.hash) {
            const ebb = (await listBlocksInSlotRange(n.slot, n.slot + 1, 2)).find((b) => b.blockNo == null);
            if (ebb) take(ebb);
            if (out.length >= count) break;
        }
        take(n); cur = n;
    }
    return out;
}

async function blockTxsPage(c: Ctx, row: BlockListRow): Promise<string[]> {
    return pageOf(await blockTxHashes(row), paging(c.url));
}

async function blockTxsCbor(c: Ctx, row: BlockListRow): Promise<unknown[]> {
    const p = paging(c.url);
    const f = factsOf(row);
    if (!f) return [];
    return pageOf(f.txs, p).map((t) => ({ tx_hash: t.hash, cbor: hex(txCbor(t, f.era)) }));
}

async function blockAddresses(c: Ctx, row: BlockListRow): Promise<unknown[]> {
    const p = paging(c.url, { order: false });
    const f = factsOf(row);
    if (!f) return [];
    const byAddr = new Map<string, Set<string>>();
    const add = (a: string | null, tx: string) => { if (!a) return; let s = byAddr.get(a); if (!s) { s = new Set(); byAddr.set(a, s); } s.add(tx); };
    for (const tx of f.txs) {
        const ins = await resolveOutputs(tx.valid ? tx.inputs : tx.collateral);
        for (const o of ins) add(o?.address ?? null, tx.hash);
        for (const o of tx.valid ? tx.outputs : tx.collateralReturn ? [tx.collateralReturn] : []) add(o.address, tx.hash);
    }
    const order = new Map(f.txs.map((t, i) => [t.hash, i]));
    return [...byAddr.keys()].sort().slice(p.offset, p.offset + p.count).map((a) => ({ address: a, transactions: [...byAddr.get(a)!].sort((x, y) => order.get(x)! - order.get(y)!).map((tx_hash) => ({ tx_hash })) }));
}

export const coreRoutes: Route[] = [
    route("GET", "/", async () => ({ url: "/api/v0", version: API_VERSION, node: "gerolamo" })),
    route("GET", "/health", async () => ({ is_healthy: true })),
    route("GET", "/health/clock", async () => ({ server_time: Date.now() })),
    route("GET", "/genesis", async (c) => {
        const g = genesisOf(c);
        if (!g) throw notFound();
        return {
            active_slots_coefficient: Number(g.activeSlotsCoeff), update_quorum: Number(g.updateQuorum), max_lovelace_supply: String(g.maxLovelaceSupply),
            network_magic: Number(g.networkMagic), epoch_length: Number(g.epochLength), system_start: Math.floor(Date.parse(g.systemStart) / 1000),
            slots_per_kes_period: Number(g.slotsPerKESPeriod), slot_length: Number(g.slotLength), max_kes_evolutions: Number(g.maxKESEvolutions), security_param: Number(g.securityParam),
        };
    }),
    route("GET", "/network", async (c) => {
        // whole-ledger sums (registered keys, pools, DReps, live stake): cached for a minute
        if (networkCache && Date.now() - networkCache.at < 60_000 && networkCache.network === c.network) return networkCache.body;
        const g = genesisOf(c);
        const max = BigInt(String(g?.maxLovelaceSupply ?? "45000000000000000"));
        const l = ledger();
        const pots = l?.stake.pots() ?? null;
        const reserves = pots?.reserves ?? null, treasury = pots?.treasury ?? null;
        const total = reserves != null ? max - reserves : null;
        let circulating: bigint | null = null, live: bigint | null = null, active: bigint | null = null;
        if (l && total != null && treasury != null) {
            const ep = await currentEpoch(c.net);
            const p = (await getStoredEpochParams(ep)) ?? {};
            const keyDep = BigInt(String(p.key_deposit ?? 0)), poolDep = BigInt(String(p.pool_deposit ?? 0));
            let deposited = 0n;
            deposited += keyDep * BigInt(l.stake.registeredStakeKeys().size);
            deposited += poolDep * BigInt(l.stake.pools().size);
            for (const [, d] of l.gov.dreps()) deposited += BigInt(d.deposit);
            for (const pr of l.gov.proposals("active")) deposited += BigInt(pr.deposit);
            circulating = total - treasury - deposited - (pots!.feePot ?? 0n) - (pots!.donationPot ?? 0n);
            live = (await liveIndex(l)).total;
            active = l.stake.snapshotTotals(ep - 1)?.total ?? null;
        }
        const s = (v: bigint | null) => (v == null ? "0" : v.toString());
        const body = {
            supply: { max: max.toString(), total: s(total), circulating: s(circulating), locked: "0", treasury: s(treasury), reserves: s(reserves) },
            stake: { live: s(live), active: s(active) },
        };
        networkCache = { at: Date.now(), network: c.network, body };
        return body;
    }),
    route("GET", "/network/eras", async (c) => bfEras(c, Number(await getMaxSlot()))),

    route("GET", "/epochs/latest", async (c) => bfEpoch(await currentEpoch(c.net), c.net)),
    route("GET", "/epochs/latest/parameters", async (c) => paramsFor(await currentEpoch(c.net))),
    route("GET", "/epochs/{number}", async (c) => { const e = epochParam(c); await epochExists(c, e); return bfEpoch(e, c.net); }),
    route("GET", "/epochs/{number}/parameters", async (c) => { const e = epochParam(c); await epochExists(c, e); return paramsFor(e); }),
    route("GET", "/epochs/{number}/next", async (c) => {
        const e = epochParam(c); await epochExists(c, e);
        const p = paging(c.url, { order: false });
        const cur = await currentEpoch(c.net);
        const out: unknown[] = [];
        for (let x = e + 1 + p.offset; x <= cur && out.length < p.count; x++) out.push(await bfEpoch(x, c.net));
        return out;
    }),
    route("GET", "/epochs/{number}/previous", async (c) => {
        const e = epochParam(c); await epochExists(c, e);
        const p = paging(c.url, { order: false });
        const hi = e - 1 - p.offset, lo = Math.max(0, hi - p.count + 1);
        const out: unknown[] = [];
        for (let x = lo; x <= hi; x++) out.push(await bfEpoch(x, c.net));
        return out;
    }),
    route("GET", "/epochs/{number}/stakes", async (c) => {
        const e = epochParam(c); await epochExists(c, e);
        const p = paging(c.url, { order: false });
        return (await snapshotStakes(e - 1)).slice(p.offset, p.offset + p.count).map((r) => ({ stake_address: stakeAddressOf(r.cred, c.network), pool_id: poolIdBech32(r.pool), amount: r.stake.toString() }));
    }),
    route("GET", "/epochs/{number}/stakes/{pool_id}", async (c) => {
        const e = epochParam(c); await epochExists(c, e);
        const pool = parsePoolId(c.params.pool_id!);
        if (!pool) throw badRequest(MSG.pool);
        const p = paging(c.url, { order: false });
        return (await snapshotStakes(e - 1)).filter((r) => r.pool === pool).slice(p.offset, p.offset + p.count).map((r) => ({ stake_address: stakeAddressOf(r.cred, c.network), amount: r.stake.toString() }));
    }),
    route("GET", "/epochs/{number}/blocks", async (c) => {
        const e = epochParam(c); await epochExists(c, e);
        const p = paging(c.url);
        const from = Number(firstSlotOfEpoch(e, c.net)), to = from + Number(epochLengthSlots(e, c.net));
        if (p.order === "asc") return (await listBlocksInSlotRange(from, to, p.count, p.offset)).map((r) => r.hash);
        const n = await countBlocksInSlotRange(from, to);
        const lo = Math.max(0, n - p.offset - p.count), cnt = Math.max(0, Math.min(p.count, n - p.offset));
        return cnt ? (await listBlocksInSlotRange(from, to, cnt, lo)).map((r) => r.hash).reverse() : [];
    }),
    route("GET", "/epochs/{number}/blocks/{pool_id}", async (c) => {
        const e = epochParam(c); await epochExists(c, e);
        const pool = parsePoolId(c.params.pool_id!);
        if (!pool) throw badRequest(MSG.pool);
        const p = paging(c.url);
        const r = p.order === "desc"
            ? await mb`SELECT hash FROM mb_block WHERE slot_leader = ${pool} AND epoch = ${e} ORDER BY slot DESC LIMIT ${p.count} OFFSET ${p.offset}`
            : await mb`SELECT hash FROM mb_block WHERE slot_leader = ${pool} AND epoch = ${e} ORDER BY slot ASC LIMIT ${p.count} OFFSET ${p.offset}`;
        return r.map((x) => str(x[0]));
    }),

    route("GET", "/blocks/latest", async (c) => bfBlock(await resolveBlock("latest"), c.net)),
    route("GET", "/blocks/latest/txs", async (c) => blockTxsPage(c, await resolveBlock("latest"))),
    route("GET", "/blocks/latest/txs/cbor", async (c) => blockTxsCbor(c, await resolveBlock("latest"))),
    route("GET", "/blocks/slot/{slot_number}", async (c) => {
        const s = intParam(c.params.slot_number!, MSG.slot);
        const row = await getBlockListRowBySlot(s);
        if (!row) throw notFound();
        return bfBlock(row, c.net);
    }),
    route("GET", "/blocks/epoch/{epoch_number}/slot/{slot_number}", async (c) => {
        const e = intParam(c.params.epoch_number!, MSG.epoch), s = intParam(c.params.slot_number!, MSG.slot);
        if (s >= Number(epochLengthSlots(e, c.net))) throw notFound();
        const row = await getBlockListRowBySlot(Number(firstSlotOfEpoch(e, c.net)) + s);
        if (!row) throw notFound();
        return bfBlock(row, c.net);
    }),
    route("GET", "/blocks/{hash_or_number}", async (c) => bfBlock(await resolveBlock(c.params.hash_or_number!), c.net)),
    route("GET", "/blocks/{hash_or_number}/next", async (c) => {
        const row = await resolveBlock(c.params.hash_or_number!);
        const p = paging(c.url, { order: false });
        return blockList(await blocksAfter(row, p.offset, p.count), c);
    }),
    route("GET", "/blocks/{hash_or_number}/previous", async (c) => {
        const row = await resolveBlock(c.params.hash_or_number!);
        const p = paging(c.url, { order: false });
        // newest first from the store, then oldest first like Blockfrost
        const rows: BlockListRow[] = [];
        let cursor = { slot: row.slot, ebb: row.blockNo == null };
        let skipped = 0;
        while (rows.length < p.count) {
            const batch = await listBlocksDesc({ limit: 100, beforeSlot: cursor.slot, beforeIsEbb: cursor.ebb });
            if (!batch.length) break;
            for (const b of batch) { if (skipped < p.offset) { skipped++; continue; } if (rows.length < p.count) rows.push(b); }
            const lastB = batch[batch.length - 1]!;
            cursor = { slot: lastB.slot, ebb: lastB.blockNo == null };
            if (batch.length < 100) break;
        }
        return blockList(rows.reverse(), c);
    }),
    route("GET", "/blocks/{hash_or_number}/txs", async (c) => blockTxsPage(c, await resolveBlock(c.params.hash_or_number!))),
    route("GET", "/blocks/{hash_or_number}/txs/cbor", async (c) => blockTxsCbor(c, await resolveBlock(c.params.hash_or_number!))),
    route("GET", "/blocks/{hash_or_number}/addresses", async (c) => blockAddresses(c, await resolveBlock(c.params.hash_or_number!))),
];

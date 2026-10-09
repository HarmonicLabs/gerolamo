/** Stake pools: list, details, history, delegators, blocks, certificates, votes. */
import { items } from "../../../db/minibf/cborWalk";
import { certAt, type PoolParamsFact } from "../../../db/minibf/blockFacts";
import { cat, hexKey, SDB, u32 } from "../../../ledger/stakeStore";
import { encodeHead } from "../../../db/minibf/cborWalk";
import { parsePoolId, poolIdBech32, rewardAccountBech32, stakeAddressOf } from "../../../db/minibf/cardanoIds";
import { badRequest, MSG, notFound, pageOf, paging } from "../http";
import { route, type Ctx, type Route } from "../router";
import { mb, mbUnsafe, num, str } from "../chain";
import { ledger, liveIndex, snapshotPool, type LedgerReads } from "../ledger";
import { currentEpoch } from "./core";
import { genesis as genesisFile } from "../../../network/n2c/lsq/queries";

function poolParam(c: Ctx): string {
    const p = parsePoolId(c.params.pool_id!);
    if (!p) throw badRequest(MSG.pool);
    return p;
}

/** The pool's current registration, decoded from the ledger's raw PoolParams CBOR. */
function poolParams(l: LedgerReads, pool: string): PoolParamsFact | null {
    const raw = l.stake.poolCbor(pool);
    if (!raw) return null;
    try {
        // certAt reads `[3, ...params]`: prefix the nine fields with the certificate tag
        const f = items(raw, 0);
        const body = raw.subarray(f[0]!, raw.length);
        const cert = new Uint8Array([...encodeHead(4, f.length + 1), 0x03, ...body]);
        return certAt(cert, 0, 0).pool_params ?? null;
    } catch { return null; }
}

/** The pool's last registration certificate in the projection (for pools the ledger no longer holds). */
async function lastRegistration(pool: string): Promise<Record<string, any> | null> {
    const r = await mb`SELECT data FROM mb_cert WHERE pool = ${pool} AND tag = 3 ORDER BY slot DESC, tx_index DESC, cert_index DESC LIMIT 1`;
    if (!r.length) return null;
    try { return JSON.parse(str(r[0]![0])).pool ?? null; } catch { return null; }
}

const readU64 = (v: Uint8Array | undefined): bigint => (v && v.length >= 8 ? new DataView(v.buffer, v.byteOffset).getBigUint64(0, false) : 0n);
const kv = (l: LedgerReads) => (l.stake as any).s as { get(db: string, k: Uint8Array): Uint8Array | undefined };

function saturationPoint(c: Ctx, l: LedgerReads, nOpt: number): bigint {
    let max = 45_000_000_000_000_000n;
    try { max = BigInt(String(genesisFile(c.network as any, "shelley").maxLovelaceSupply)); } catch { /* default */ }
    const reserves = l.stake.pots()?.reserves ?? 0n;
    return nOpt > 0 ? (max - reserves) / BigInt(nOpt) : 0n;
}

async function blocksMinted(pool: string, epoch?: number): Promise<number> {
    const r = epoch == null ? await mb`SELECT COUNT(*) FROM mb_block WHERE slot_leader = ${pool}` : await mb`SELECT COUNT(*) FROM mb_block WHERE slot_leader = ${pool} AND epoch = ${epoch}`;
    return num(r[0]?.[0]);
}

async function nOptOf(epoch: number): Promise<number> {
    const { getStoredEpochParams } = await import("../../../consensus/epochParams");
    return Number((await getStoredEpochParams(epoch))?.n_opt ?? 500);
}

function poolList(l: LedgerReads): Array<[string, { registeredSlot: number; retiringEpoch: number | null }]> {
    return [...l.stake.pools()].sort((a, b) => a[1].registeredSlot - b[1].registeredSlot || (a[0] < b[0] ? -1 : 1));
}

async function retirements(cur: number): Promise<{ retired: Array<{ pool: string; epoch: number; slot: number }>; retiring: Array<{ pool: string; epoch: number; slot: number }> }> {
    const rows = await mb`SELECT pool, tag, data, slot, tx_index, cert_index FROM mb_cert WHERE tag IN (3, 4) ORDER BY slot, tx_index, cert_index`;
    const last = new Map<string, { tag: number; epoch: number; slot: number }>();
    for (const r of rows) {
        const tag = num(r[1]);
        let epoch = 0;
        if (tag === 4) try { epoch = Number(JSON.parse(str(r[2])).retire_epoch); } catch { /* */ }
        const prev = last.get(str(r[0]));
        // a registration after an announced retirement cancels it only when it comes before the retirement epoch
        if (tag === 3 && prev?.tag === 4 && prev.epoch <= cur) { last.set(str(r[0]), { tag: 3, epoch: 0, slot: num(r[3]) }); continue; }
        last.set(str(r[0]), { tag, epoch, slot: num(r[3]) });
    }
    const l = ledger();
    const retired: Array<{ pool: string; epoch: number; slot: number }> = [], retiring: typeof retired = [];
    for (const [pool, v] of last) {
        if (v.tag !== 4) continue;
        if (v.epoch <= cur) retired.push({ pool, epoch: v.epoch, slot: v.slot });
        else if (!l || l.stake.pool(pool)?.retiringEpoch != null) retiring.push({ pool, epoch: v.epoch, slot: v.slot });
    }
    if (l) for (const [pool, rec] of l.stake.pools()) if (rec.retiringEpoch != null && rec.retiringEpoch > cur && !retiring.some((x) => x.pool === pool)) retiring.push({ pool, epoch: rec.retiringEpoch, slot: rec.registeredSlot });
    const ord = (a: { epoch: number; slot: number }, b: { epoch: number; slot: number }) => a.epoch - b.epoch || a.slot - b.slot;
    return { retired: retired.sort(ord), retiring: retiring.sort(ord) };
}

async function needPool(c: Ctx): Promise<{ pool: string; l: LedgerReads | null }> {
    const pool = poolParam(c);
    const l = ledger();
    if (l?.stake.pool(pool)) return { pool, l };
    if ((await mb`SELECT 1 FROM mb_cert WHERE pool = ${pool} AND tag = 3 LIMIT 1`).length) return { pool, l };
    throw notFound();
}

const metaJson = (url: string | null, hash: string | null) => (url == null && hash == null ? null : { url, hash, ticker: null, name: null, description: null, homepage: null });

export const poolRoutes: Route[] = [
    route("GET", "/pools", async (c) => {
        const l = ledger();
        if (!l) return [];
        return pageOf(poolList(l), paging(c.url)).map(([id]) => poolIdBech32(id));
    }),
    route("GET", "/pools/extended", async (c) => {
        const l = ledger();
        if (!l) return [];
        const cur = await currentEpoch(c.net);
        const live = await liveIndex(l);
        const sat = saturationPoint(c, l, await nOptOf(cur));
        const out: unknown[] = [];
        for (const [id] of pageOf(poolList(l), paging(c.url))) {
            const rec = l.stake.pool(id)!;
            const pp = poolParams(l, id);
            const ls = live.pools.get(id)?.stake ?? 0n;
            out.push({
                pool_id: poolIdBech32(id), hex: id,
                active_stake: (snapshotPool(l.stake, cur - 1, id) ?? 0n).toString(), live_stake: ls.toString(),
                live_saturation: sat > 0n ? Number(ls) / Number(sat) : 0,
                blocks_minted: await blocksMinted(id),
                declared_pledge: rec.params?.pledge ?? pp?.pledge.toString() ?? "0",
                margin_cost: rec.params ? Number(rec.params.marginNum) / Number(rec.params.marginDen || 1) : 0,
                fixed_cost: rec.params?.cost ?? pp?.cost.toString() ?? "0",
                metadata: metaJson(pp?.metadata?.url ?? null, pp?.metadata?.hash ?? null),
            });
        }
        return out;
    }),
    route("GET", "/pools/retired", async (c) => pageOf((await retirements(await currentEpoch(c.net))).retired, paging(c.url)).map((r) => ({ pool_id: poolIdBech32(r.pool), epoch: r.epoch }))),
    route("GET", "/pools/retiring", async (c) => pageOf((await retirements(await currentEpoch(c.net))).retiring, paging(c.url)).map((r) => ({ pool_id: poolIdBech32(r.pool), epoch: r.epoch }))),
    route("GET", "/pools/{pool_id}", async (c) => {
        const { pool, l } = await needPool(c);
        const cur = await currentEpoch(c.net);
        const rec = l?.stake.pool(pool) ?? null;
        const pp = l ? poolParams(l, pool) : null;
        const reg = pp ? null : await lastRegistration(pool);
        const live = l ? await liveIndex(l) : null;
        const ls = live?.pools.get(pool)?.stake ?? 0n;
        const delegators = live?.pools.get(pool)?.delegators ?? [];
        const active = l ? snapshotPool(l.stake, cur - 1, pool) ?? 0n : 0n;
        const activeTotal = l?.stake.snapshotTotals(cur - 1)?.total ?? 0n;
        const sat = l ? saturationPoint(c, l, await nOptOf(cur)) : 0n;
        const owners: string[] = pp?.owners ?? reg?.owners ?? rec?.params?.owners ?? [];
        let livePledge = 0n;
        if (l) for (const o of owners) if (l.stake.delegationOf(o) === pool) livePledge += l.stake.stakeBalance(o) + l.stake.rewardBalance(o);
        const certs = await mb`SELECT tx_hash, tag FROM mb_cert WHERE pool = ${pool} AND tag IN (3, 4) ORDER BY slot, tx_index, cert_index`;
        const margin = pp ? Number(pp.margin.num) / Number(pp.margin.den || 1n) : rec?.params ? Number(rec.params.marginNum) / Number(rec.params.marginDen || 1) : reg ? Number(reg.margin[0]) / Number(reg.margin[1] || 1) : 0;
        return {
            pool_id: poolIdBech32(pool), hex: pool,
            vrf_key: pp?.vrf ?? rec?.vrf ?? reg?.vrf ?? "",
            blocks_minted: await blocksMinted(pool), blocks_epoch: await blocksMinted(pool, cur),
            live_stake: ls.toString(), live_size: live && live.total > 0n ? Number(ls) / Number(live.total) : 0,
            live_saturation: sat > 0n ? Number(ls) / Number(sat) : 0, live_delegators: delegators.length,
            active_stake: active.toString(), active_size: activeTotal > 0n ? Number(active) / Number(activeTotal) : 0,
            declared_pledge: pp?.pledge.toString() ?? rec?.params?.pledge ?? reg?.pledge ?? "0", live_pledge: livePledge.toString(),
            margin_cost: margin, fixed_cost: pp?.cost.toString() ?? rec?.params?.cost ?? reg?.cost ?? "0",
            reward_account: pp ? rewardAccountBech32(pp.rewardAccount) : rec?.params?.rewardAccount ? stakeAddressOf(rec.params.rewardAccount, c.network) : reg ? rewardAccountBech32(Uint8Array.from(Buffer.from(reg.reward_account, "hex"))) : "",
            owners: owners.map((o) => stakeAddressOf(o, c.network)),
            registration: certs.filter((r) => num(r[1]) === 3).map((r) => str(r[0])),
            retirement: certs.filter((r) => num(r[1]) === 4).map((r) => str(r[0])),
            calidus_key: null,
        };
    }),
    route("GET", "/pools/{pool_id}/history", async (c) => {
        const { pool, l } = await needPool(c);
        const p = paging(c.url);
        if (!l) return [];
        const cur = await currentEpoch(c.net);
        const out: unknown[] = [];
        for (const takenAt of [...l.stake.snapshotEpochs()].sort((a, b) => a - b)) {
            const e = takenAt + 1;
            if (e >= cur) continue;
            const st = snapshotPool(l.stake, takenAt, pool);
            if (st == null) continue;
            const total = l.stake.snapshotTotals(takenAt)?.total ?? 0n;
            let meta: { delegators?: number } = {};
            try { const v = kv(l).get(SDB.snapPoolMeta, cat(u32(takenAt), hexKey(pool))); if (v) meta = JSON.parse(new TextDecoder().decode(v)); } catch { /* */ }
            let rw: Record<string, string | number> = {};
            try { const v = kv(l).get(SDB.rewardPoolEpochs, cat(u32(e), hexKey(pool))); if (v) rw = JSON.parse(new TextDecoder().decode(v)); } catch { /* */ }
            out.push({ epoch: e, blocks: await blocksMinted(pool, e), active_stake: st.toString(), active_size: total > 0n ? Number(st) / Number(total) : 0, delegators_count: Number(meta.delegators ?? 0), rewards: String(rw.poolReward ?? "0"), fees: String(rw.operator ?? "0") });
        }
        return pageOf(out, p);
    }),
    route("GET", "/pools/{pool_id}/metadata", async (c) => {
        const { pool, l } = await needPool(c);
        const pp = l ? poolParams(l, pool) : null;
        const reg = pp ? null : await lastRegistration(pool);
        const m = pp?.metadata ?? reg?.metadata ?? null;
        if (!m) return {};
        return { pool_id: poolIdBech32(pool), hex: pool, url: m.url, hash: m.hash, ticker: null, name: null, description: null, homepage: null };
    }),
    route("GET", "/pools/{pool_id}/relays", async (c) => {
        const { pool, l } = await needPool(c);
        const pp = l ? poolParams(l, pool) : null;
        return (pp?.relays ?? (await lastRegistration(pool))?.relays ?? []).map((r: any) => ({ ipv4: r.ipv4, ipv6: r.ipv6, dns: r.dns, dns_srv: r.dns_srv, port: r.port }));
    }),
    route("GET", "/pools/{pool_id}/delegators", async (c) => {
        const { pool, l } = await needPool(c);
        const p = paging(c.url);
        if (!l) return [];
        const ds = [...((await liveIndex(l)).pools.get(pool)?.delegators ?? [])].sort();
        return pageOf(ds, p).map((d) => ({ address: stakeAddressOf(d, c.network), live_stake: (l.stake.stakeBalance(d) + l.stake.rewardBalance(d)).toString() }));
    }),
    route("GET", "/pools/{pool_id}/blocks", async (c) => {
        const { pool } = await needPool(c);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        return (await mbUnsafe(`SELECT hash FROM mb_block WHERE slot_leader = ? ORDER BY slot ${o} LIMIT ? OFFSET ?`, [pool, p.count, p.offset])).map((r) => str(r[0]));
    }),
    route("GET", "/pools/{pool_id}/updates", async (c) => {
        const { pool } = await needPool(c);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        return (await mbUnsafe(`SELECT tx_hash, cert_index, tag FROM mb_cert WHERE pool = ? AND tag IN (3, 4) ORDER BY slot ${o}, tx_index ${o}, cert_index ${o} LIMIT ? OFFSET ?`, [pool, p.count, p.offset]))
            .map((r) => ({ tx_hash: str(r[0]), cert_index: num(r[1]), action: num(r[2]) === 3 ? "registered" : "deregistered" }));
    }),
    route("GET", "/pools/{pool_id}/votes", async (c) => {
        const { pool } = await needPool(c);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        return (await mbUnsafe(`SELECT tx_hash, idx, vote FROM mb_vote WHERE voter_kind = 4 AND voter_hash = ? ORDER BY slot ${o}, tx_index ${o}, idx ${o} LIMIT ? OFFSET ?`, [pool, p.count, p.offset]))
            .map((r) => ({ tx_hash: str(r[0]), cert_index: num(r[1]), vote: ["no", "yes", "abstain"][num(r[2])] ?? "abstain" }));
    }),
];
void readU64;

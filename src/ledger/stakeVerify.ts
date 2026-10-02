/**
 * Dual-run verifier for the stake group (docs/PLAN_LMDB_LEDGER.md §7): after a range commits,
 * every key a block's diff touched in the phase-2 databases is compared with the SQLite row it
 * mirrors. A touched snapshot total triggers a whole-snapshot comparison for that epoch.
 */
import { sql } from "../sql";
import type { LedgerDiff } from "./LedgerDiff";
import { readU64, unhex } from "./LedgerDiff";
import { SDB, keyHex, type StakeReads } from "./stakeStore";

function splitTyped(typedHex: string): { hash: Buffer; type: number } {
    return typedHex.length === 58 && typedHex.startsWith("01") ? { hash: Buffer.from(typedHex.slice(2), "hex"), type: 1 } : { hash: Buffer.from(typedHex, "hex"), type: 0 };
}
const rows = async (q: Promise<unknown>): Promise<unknown[][]> => (await (q as any).values?.() ?? q) as unknown[][];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rdU32 = (b: Uint8Array, o = 0) => new DataView(b.buffer, b.byteOffset).getUint32(o, false);

export async function verifyStakeDiff(r: StakeReads, d: LedgerDiff): Promise<{ checked: number; differences: string[] }> {
    const out = { checked: 0, differences: [] as string[] };
    const diff = (s: string) => out.differences.push(s);
    for (const k of d.touchedKeys(SDB.stake)) {
        out.checked++;
        const { hash, type } = splitTyped(k);
        const inSql = (await sql`SELECT 1 FROM stake WHERE stake_credentials = ${hash} AND (cred_type IS NULL OR cred_type = ${type})`.values()).length > 0;
        if (inSql !== r.isRegistered(k)) diff(`stake ${k.slice(0, 16)}: sqlite ${inSql} lmdb ${r.isRegistered(k)}`);
    }
    for (const k of d.touchedKeys(SDB.deleg)) {
        out.checked++;
        const { hash, type } = splitTyped(k);
        const rs = (await sql`SELECT lower(hex(pool_key_hash)) FROM delegations WHERE stake_credentials = ${hash} AND (cred_type IS NULL OR cred_type = ${type}) ORDER BY id DESC LIMIT 1`.values()) as unknown[][];
        const a = rs.length ? String(rs[0]![0]) : null, b = r.delegationOf(k);
        if (a !== b) diff(`deleg ${k.slice(0, 16)}: sqlite ${a?.slice(0, 12)} lmdb ${b?.slice(0, 12)}`);
    }
    for (const k of d.touchedKeys(SDB.reward)) {
        out.checked++;
        const rs = (await sql`SELECT amount FROM rewards WHERE stake_credentials = ${Buffer.from(k, "hex")}`.values()) as unknown[][];
        const a = rs.length ? BigInt(String(rs[0]![0] ?? 0)) : 0n, b = r.rewardBalance(k);
        if (a !== b) diff(`reward ${k.slice(0, 16)}: sqlite ${a} lmdb ${b}`);
    }
    for (const k of d.touchedKeys(SDB.pointer)) {
        out.checked++;
        const key = unhex(k);
        const slot = Number(readU64(key.subarray(0, 8))), txIx = rdU32(key, 8), certIx = rdU32(key, 12);
        const rs = (await sql`SELECT stake_key FROM stake_pointers WHERE slot = ${slot} AND tx_ix = ${txIx} AND cert_ix = ${certIx}`.values()) as unknown[][];
        const a = rs.length ? String(rs[0]![0]) : null, b = r.pointer(slot, txIx, certIx);
        if (a !== b) diff(`pointer ${slot}/${txIx}/${certIx}: sqlite ${a} lmdb ${b}`);
    }
    for (const k of d.touchedKeys(SDB.pool)) {
        out.checked++;
        const rs = (await sql`SELECT vrf_key_hash, registered_slot, retiring_epoch, params_json FROM pool_params WHERE pool_id = ${k}`.values()) as unknown[][];
        const b = r.pool(k);
        if (!rs.length !== !b) { diff(`pool ${k.slice(0, 12)}: sqlite ${rs.length ? "present" : "absent"} lmdb ${b ? "present" : "absent"}`); continue; }
        if (!rs.length || !b) continue;
        const a = { vrf: String(rs[0]![0]), registeredSlot: Number(rs[0]![1]), retiringEpoch: rs[0]![2] == null ? null : Number(rs[0]![2]), params: rs[0]![3] == null ? null : JSON.parse(String(rs[0]![3])) };
        if (!same(a, b)) diff(`pool ${k.slice(0, 12)}: sqlite ${JSON.stringify(a).slice(0, 160)} lmdb ${JSON.stringify(b).slice(0, 160)}`);
    }
    for (const k of d.touchedKeys(SDB.poolPending)) {
        out.checked++;
        const rs = (await sql`SELECT vrf_key_hash, registered_slot, params_json FROM pool_params_pending WHERE pool_id = ${k}`.values()) as unknown[][];
        const b = r.pendingPools().get(k) ?? null;
        const a = rs.length ? { vrf: String(rs[0]![0]), registeredSlot: Number(rs[0]![1]), params: rs[0]![2] == null ? null : JSON.parse(String(rs[0]![2])) } : null;
        if (!same(a, b)) diff(`pool_pending ${k.slice(0, 12)}: sqlite ${JSON.stringify(a)?.slice(0, 120)} lmdb ${JSON.stringify(b)?.slice(0, 120)}`);
    }
    for (const k of d.touchedKeys(SDB.opcert)) {
        out.checked++;
        const rs = (await sql`SELECT counter, slot FROM opcert_counters WHERE pool_id = ${k}`.values()) as unknown[][];
        const a = rs.length ? { counter: Number(rs[0]![0]), slot: Number(rs[0]![1]) } : null, b = r.opcert(k);
        if (!same(a, b)) diff(`opcert ${k.slice(0, 12)}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`);
    }
    for (const k of d.touchedKeys(SDB.blocksMade)) {
        out.checked++;
        const key = unhex(k), epoch = rdU32(key), pool = keyHex(key.subarray(4));
        const rs = (await sql`SELECT blocks FROM blocks_made_by_epoch WHERE epoch = ${epoch} AND pool_id = ${pool}`.values()) as unknown[][];
        const a = rs.length ? Number(rs[0]![0]) : 0, b = r.blocksMade(epoch).get(pool) ?? 0;
        if (a !== b) diff(`blocks_made ${epoch}/${pool.slice(0, 12)}: sqlite ${a} lmdb ${b}`);
    }
    if (d.touchedKeys(SDB.pots).size) {
        out.checked++;
        const rs = (await sql`SELECT reserves, treasury, fee_pot, donation_pot, initialized_epoch FROM reward_pots WHERE id = 1`.values()) as unknown[][];
        const a = rs.length ? { reserves: String(rs[0]![0]), treasury: String(rs[0]![1]), feePot: String(rs[0]![2]), donationPot: String(rs[0]![3] ?? 0), initializedEpoch: Number(rs[0]![4]) } : null;
        const p = r.pots();
        const b = p ? { reserves: p.reserves.toString(), treasury: p.treasury.toString(), feePot: p.feePot.toString(), donationPot: p.donationPot.toString(), initializedEpoch: p.initializedEpoch } : null;
        if (!same(a, b)) diff(`pots: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`);
    }
    for (const k of d.touchedKeys(SDB.pendingRew)) {
        out.checked++;
        const key = unhex(k), payAt = rdU32(key), cred = keyHex(key.subarray(4));
        const rs = (await sql`SELECT amount FROM pending_rewards WHERE pay_at = ${payAt} AND stake_key = ${cred}`.values()) as unknown[][];
        const a = rs.length ? BigInt(String(rs[0]![0])) : 0n, b = r.pendingRewards(payAt).get(cred) ?? 0n;
        if (a !== b) diff(`pending_rewards ${payAt}/${cred.slice(0, 12)}: sqlite ${a} lmdb ${b}`);
    }
    for (const k of d.touchedKeys(SDB.potSnap)) {
        out.checked++;
        const epoch = rdU32(unhex(k));
        const rs = (await sql`SELECT reserves, treasury, fees_collected FROM pot_snapshots WHERE epoch = ${epoch}`.values()) as unknown[][];
        const a = rs.length ? { reserves: String(rs[0]![0]), treasury: String(rs[0]![1]), feesCollected: String(rs[0]![2]) } : null;
        const p = r.potSnapshot(epoch);
        const b = p ? { reserves: p.reserves.toString(), treasury: p.treasury.toString(), feesCollected: p.feesCollected.toString() } : null;
        if (!same(a, b)) diff(`pot_snapshot ${epoch}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`);
    }
    for (const k of d.touchedKeys(SDB.rewardEpochs)) {
        out.checked++;
        const epoch = rdU32(unhex(k));
        const rs = (await sql`SELECT reward_pot, treasury_delta, paid, unclaimed, pools, accounts FROM reward_epochs WHERE performance_epoch = ${epoch}`.values()) as unknown[][];
        const a = rs.length ? { rewardPot: String(rs[0]![0]), treasuryDelta: String(rs[0]![1]), paid: String(rs[0]![2]), unclaimed: String(rs[0]![3]), pools: Number(rs[0]![4]), accounts: Number(rs[0]![5]) } : null;
        if (!same(a, r.rewardEpoch(epoch))) diff(`reward_epoch ${epoch}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(r.rewardEpoch(epoch))}`);
    }
    // per-epoch payout report: compare the whole epoch once
    const payoutEpochs = new Set<number>(); for (const k of d.touchedKeys(SDB.rewardPayouts)) payoutEpochs.add(rdU32(unhex(k)));
    for (const epoch of payoutEpochs) {
        out.checked++;
        const rs = (await sql`SELECT stake_key, amount FROM reward_payouts WHERE performance_epoch = ${epoch}`.values()) as unknown[][];
        const a = new Map(rs.map((x) => [String(x[0]), BigInt(String(x[1]))])), b = r.rewardPayouts(epoch);
        let bad = 0; for (const [c, v] of a) if (b.get(c) !== v) bad++; for (const c of b.keys()) if (!a.has(c)) bad++;
        if (bad) diff(`reward_payouts ${epoch}: ${bad} account(s) differ (sqlite ${a.size}, lmdb ${b.size})`);
    }
    // a new snapshot: compare it entirely
    for (const k of d.touchedKeys(SDB.snapTotals)) {
        const takenAt = rdU32(unhex(k));
        out.checked++;
        const t = (await sql`SELECT total_active, pools FROM epoch_stake_totals WHERE taken_at = ${takenAt}`.values()) as unknown[][];
        const a = t.length ? { total: String(t[0]![0]), pools: Number(t[0]![1]) } : null;
        const bt = r.snapshotTotals(takenAt);
        const b = bt ? { total: bt.total.toString(), pools: bt.pools } : null;
        if (!same(a, b)) diff(`snapshot ${takenAt} totals: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`);
        const ps = (await sql`SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
        const pa = new Map(ps.map((x) => [String(x[0]), BigInt(String(x[1]))])), pb = r.snapshotPoolStake(takenAt);
        let badPools = 0; for (const [id, v] of pa) if (pb.get(id) !== v) badPools++; for (const id of pb.keys()) if (!pa.has(id)) badPools++;
        if (badPools) diff(`snapshot ${takenAt} pool stake: ${badPools} pool(s) differ (sqlite ${pa.size}, lmdb ${pb.size})`);
        const cs = (await sql`SELECT stake_key, pool_id, stake FROM epoch_stake_cred WHERE taken_at = ${takenAt}`.values()) as unknown[][];
        const cb = r.snapshotCredentials(takenAt);
        let badCreds = 0; const seen = new Set<string>();
        for (const x of cs) { const c = String(x[0]); seen.add(c); const e = cb.get(c); if (!e || e.pool !== String(x[1]) || e.stake !== BigInt(String(x[2]))) badCreds++; }
        for (const c of cb.keys()) if (!seen.has(c)) badCreds++;
        if (badCreds) diff(`snapshot ${takenAt} credentials: ${badCreds} differ (sqlite ${cs.length}, lmdb ${cb.size})`);
        const pp = (await sql`SELECT pool_id, vrf_key_hash, params_json FROM epoch_pool_params WHERE taken_at = ${takenAt}`.values()) as unknown[][];
        const ppb = r.snapshotPoolParams(takenAt);
        let badPP = 0;
        for (const x of pp) { const e = ppb.get(String(x[0])); if (!e || e.vrf !== String(x[1]) || !same(e.params, x[2] == null ? null : JSON.parse(String(x[2])))) badPP++; }
        if (badPP || pp.length !== ppb.size) diff(`snapshot ${takenAt} pool params: ${badPP} differ (sqlite ${pp.length}, lmdb ${ppb.size})`);
    }
    return out;
}

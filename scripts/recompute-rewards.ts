#!/usr/bin/env bun
/**
 * Recompute the reward update applied at the boundary into `--epoch` from the
 * local snapshots (dry run) and compare per pool with Koios `pool_history`.
 *   bun scripts/recompute-rewards.ts --db <ledger.db> --network preprod --epoch 45 [--pools 8]
 */
import { initSql } from "../src/sql";
import { computeEpochRewards } from "../src/consensus/rewards";
import { buildRewardInputs } from "../src/consensus/epochRewards";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const H = { accept: "application/json" };
initSql(args.db!);
const genesis = await Bun.file(`src/config/${net}/shelley-genesis.json`).json();
const shelleyStart = net === "mainnet" ? 208 : net === "preview" ? 0 : 4;
const epoch = Number(args.epoch);
const built = await buildRewardInputs(epoch, genesis, shelleyStart, 432_000n);
if (!built) { console.log("no inputs for that boundary (missing pot snapshot)"); process.exit(1); }
const out = computeEpochRewards(built.input);
const perf = built.perfEpoch;
console.log(`boundary into ${epoch}, performance epoch ${perf}: reserves(e−1) ${built.prevReserves}, fees(e−2) ${built.fees}, blocks ${built.totalBlocks}/${built.expectedBlocks}, pools ${built.pools}`);
console.log(`pot ${out.rewardPot}, treasury +${out.treasuryDelta} (forfeited ${out.forfeited}), paid ${[...out.paid.values()].reduce((s, v) => s + v, 0n)} to ${out.paid.size}, unclaimed ${out.unclaimed}`);
const totals: any[] = await (await fetch(`${base}/totals`, { headers: H })).json();
const t = (e: number) => totals.find((x) => Number(x.epoch_no) === e);
if (t(epoch) && t(epoch - 1)) console.log(`koios Δtreasury into ${epoch}: ${BigInt(t(epoch).treasury) - BigInt(t(epoch - 1).treasury)}`);
const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32(hrp: string, data: Uint8Array): string { const polymod = (v: number[]) => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]!; } return c; }; const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31)); const d: number[] = []; let acc = 0, bits = 0; for (const v of data) { acc = (acc << 8) | v; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } } if (bits) d.push((acc << (5 - bits)) & 31); const pm = polymod(exp.concat(d, [0, 0, 0, 0, 0, 0])) ^ 1; return hrp + "1" + d.map((x) => CH[x]).join("") + [0, 1, 2, 3, 4, 5].map((i) => CH[(pm >> (5 * (5 - i))) & 31]).join(""); }
const top = [...out.pools].sort((a, b) => (b.poolReward > a.poolReward ? 1 : -1)).slice(0, Number(args.pools ?? 8));
console.log("pool          blocks  stake(local)        ourMembers      koiosMembers    ourLeader     koiosLeader    koiosStake");
for (const p of top) {
    const id = bech32("pool", Buffer.from(p.poolId, "hex"));
    const h: any = (await (await fetch(`${base}/pool_history?_pool_bech32=${id}&_epoch_no=${perf}`, { headers: H })).json())?.[0];
    console.log(p.poolId.slice(0, 12), String(p.blocks).padStart(6), String(p.stake).padStart(18), String(p.members).padStart(16), String(h?.deleg_rewards ?? "-").padStart(16), String(p.operator).padStart(13), String(h?.pool_fees ?? "-").padStart(13), String(h?.active_stake ?? "-").padStart(16), `margin ${h?.margin} cost ${h?.fixed_cost} blk ${h?.block_cnt}`);
}

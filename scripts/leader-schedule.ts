/**
 * Our pool's leader slots for an epoch from the node's ledger DB (read-only):
 *   bun scripts/leader-schedule.ts --db <ledger.db> --network preview --pool <pool id hex> --vrf-skey <vrf.skey> [--epoch N] [--json]
 *
 * σ = pool stake / total active stake of the snapshot taken at the start of
 * epoch N − 1 (what the ledger uses for N); η0 from `epoch_nonces`. Defaults to
 * the latest epoch whose nonce and snapshot are both known. Compare with
 * `cardano-cli conway query leadership-schedule --current|--next`.
 */
import { Database } from "bun:sqlite";
import { loadVrfSigningKey, vrfKeyHashOf } from "../src/pool/keystore";
import { expectedLeaderSlots, leaderSlotsForEpoch } from "../src/pool/leaderSchedule";
import { setEpochNetwork, type EpochNetwork } from "../src/utils/epochFromSlotCalculations";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : []).filter((x) => x.length));
for (const k of ["db", "network", "pool", "vrf-skey"]) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
const net = setEpochNetwork(args.network) as EpochNetwork;
const db = new Database(args.db!, { readonly: true });
const genesis = await Bun.file(`src/config/${net}/shelley-genesis.json`).json();
const f = Number(genesis.activeSlotsCoeff);
const vrf = loadVrfSigningKey(args["vrf-skey"]!);
const poolId = String(args.pool).toLowerCase();

const nonceRow = (e: number) => db.query("SELECT nonce_hex FROM epoch_nonces WHERE epoch = ?").get(e) as { nonce_hex: string } | null;
const snapRow = (takenAt: number) => db.query("SELECT total_active FROM epoch_stake_totals WHERE taken_at = ?").get(takenAt) as { total_active: number | bigint } | null;
let epoch = args.epoch ? Number(args.epoch) : (() => {
    const e = db.query("SELECT MAX(epoch) AS e FROM epoch_nonces").get() as { e: number };
    let c = e.e; while (c > 0 && !snapRow(c - 1)) c--; return c;
})();
const nonce = nonceRow(epoch)?.nonce_hex;
const total = snapRow(epoch - 1)?.total_active;
if (!nonce) { console.error(`no η0 for epoch ${epoch} in epoch_nonces`); process.exit(1); }
if (total == null) { console.error(`no stake snapshot taken at epoch ${epoch - 1} (needed for epoch ${epoch})`); process.exit(1); }
const stakeRow = db.query("SELECT stake FROM epoch_pool_stake WHERE taken_at = ? AND pool_id = ?").get(epoch - 1, poolId) as { stake: number | bigint } | null;
const stake = BigInt(stakeRow?.stake ?? 0);
// epoch_pool_params is a rolling window of recent snapshots; fall back to the current registration.
const regVrf = (db.query("SELECT vrf_key_hash FROM epoch_pool_params WHERE taken_at = ? AND pool_id = ?").get(epoch - 1, poolId) as { vrf_key_hash: string } | null)?.vrf_key_hash
    ?? (db.query("SELECT vrf_key_hash FROM pool_params WHERE pool_id = ?").get(poolId) as { vrf_key_hash: string } | null)?.vrf_key_hash;
const ourVrfHash = vrfKeyHashOf(vrf.vkey);
const sigma = { num: stake, den: BigInt(total) };
const t0 = performance.now();
const slots = leaderSlotsForEpoch({ epoch, nonceHex: nonce, sigma, activeSlotsCoeff: f, vrf, network: net, onProgress: args.json ? undefined : (d, t) => { if (d % 20000 === 0) process.stderr.write(`  ${d}/${t} slots\n`); } });
const secs = ((performance.now() - t0) / 1000).toFixed(1);
const report = {
    network: net, epoch, poolId, eta0: nonce, snapshotTakenAt: epoch - 1,
    stake: stake.toString(), totalActive: String(total), sigma: Number(stake) / Number(total),
    vrfKeyHash: ourVrfHash, registeredVrfKeyHash: regVrf ?? null, vrfMatchesRegistration: regVrf ? regVrf === ourVrfHash : null,
    expectedSlots: expectedLeaderSlots(sigma, f, 86400n).toFixed(2), leaderSlots: slots.length, seconds: secs,
    slots: slots.map((s) => ({ slot: s.slot.toString(), slotInEpoch: s.slotInEpoch.toString(), time: s.time })),
};
if (args.json) {
    // a piped report is ~60 KB: wait for the write callback, never exit early (console.log truncated at 64 KB)
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(report, null, 2) + "\n", (err) => (err ? reject(err) : resolve())));
    db.close();
} else {
console.log(`epoch ${epoch} on ${net}: η0 ${nonce.slice(0, 16)}…, σ = ${stake} / ${total} = ${report.sigma.toExponential(3)}, f = ${f}`);
if (!stakeRow) console.log(`  pool ${poolId} has no stake in the snapshot taken at epoch ${epoch - 1}`);
if (regVrf && regVrf !== ourVrfHash) console.log(`  WARNING: vrf.skey hash ${ourVrfHash.slice(0, 16)}… differs from the pool's registered VRF ${regVrf.slice(0, 16)}…`);
console.log(`  expected ≈ ${report.expectedSlots} slots, got ${slots.length} (${secs} s)`);
for (const s of slots) console.log(`  slot ${s.slot} (epoch slot ${s.slotInEpoch}) at ${s.time}`);
}

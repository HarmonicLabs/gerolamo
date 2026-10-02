#!/usr/bin/env bun
/**
 * The balance-dependent rules over the epochs since a node's LMDB store was imported, read-only
 * (bugs 272–274), beyond the volatile window scripts/ledger-rules-shadow.ts covers: reward balances
 * are rebuilt from the chain and the boundary credits the store recorded —
 *   a withdrawal empties its account; a registration starts it at 0; at the boundary into epoch e the
 *   store's payouts of performance epoch e − 2 are added to every account being tracked —
 * so every withdrawal after an account's first one (or its registration) since the import must take
 * exactly the rebuilt balance (`ConwayIncompleteWithdrawals`), every deregistration of a tracked
 * account must find 0 after its transaction's withdrawals (`StakeKeyHasNonZeroAccountBalanceDELEG`),
 * and every `current_treasury_value` must be the treasury the store recorded for its epoch.
 * A difference of a proposal deposit or a pool deposit is a boundary refund (not in the payouts) and
 * is listed separately.
 *
 *   GEROLAMO_DB_PATH=<scratch>.db bun scripts/balance-history-check.ts --node <node dir> [--ledger-dir <dir>] [--from-epoch E]
 *       [--treasury-only] [--network preview]
 * `--treasury-only` checks just the treasury claims (any range whose pot snapshots the store kept).
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { attachReadOnlyLedgerStore, getLedgerStore, ledgerGovReads, ledgerStakeReads } from "../src/ledger/nodeLedgerStore";
import { ChunkStore } from "../src/storage/chunkStore";
import { VolatileStore } from "../src/storage/volatileStore";
import { epochForSlot, firstSlotOfEpoch, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { items, scanBlock, uint } from "./lib/cborWalk";
import { logger, LogLevel } from "../src/utils/logger";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node")!;
const network = opt("network", "preview")!;
if (!node) { console.error("usage: --node <node dir> [--from-epoch E]"); process.exit(2); }
if (!process.env.GEROLAMO_DB_PATH) { console.error("set GEROLAMO_DB_PATH to a scratch file: this tool must not open the node's SQLite"); process.exit(2); }
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);

const treasuryOnly = argv.includes("--treasury-only");
const store = attachReadOnlyLedgerStore({ dbPath: join(node, "preview.db"), ledgerDir: opt("ledger-dir", join(node, "ledger")), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
const sr = ledgerStakeReads(), gr = ledgerGovReads();
if (!store || !sr || !gr) { console.error("no LMDB ledger store"); process.exit(1); }
const imported = sr.pots()!.initializedEpoch;
const fromEpoch = Number(opt("from-epoch", String(imported + 1)));
const cur = Number(epochForSlot(store.anchor()!.slot));
console.log(`store imported at epoch ${imported}; checking from epoch ${fromEpoch}; pot snapshot of ${cur + 1}: ${JSON.stringify(sr.potSnapshot(cur + 1), (_, v) => typeof v === "bigint" ? v.toString() : v)}, live treasury ${sr.pots()!.treasury}`);
const payoutsCache = new Map<number, Map<string, bigint>>();
const payouts = (perf: number) => { let m = payoutsCache.get(perf); if (!m) { m = sr.rewardPayouts(perf); payoutsCache.set(perf, m); } return m; };
const govDeposit = (e: number) => BigInt(String(gr.epochParams(e)?.params?.gov_action_deposit ?? 0));
const poolDeposit = (e: number) => BigInt(String(gr.epochParams(e)?.params?.pool_deposit ?? 500_000_000));

const imm = await ChunkStore.open(join(node, "db", "immutable"), { chunkSlots: network === "preview" ? 4320 : 21600, cacheChunks: 4, readOnly: true, hashIndexPath: false });
const vol = await VolatileStore.open(join(node, "db", "volatile"), { readOnly: true });
const immTip = await imm.tip();
const tipHex = (() => { try { return readFileSync(join(node, "db", "gerolamo", "selected-tip.hex"), "utf8").trim(); } catch { return ""; } })();
const volChain: Array<{ slot: number; bytes: Uint8Array }> = [];
{ let c = tipHex ? vol.get(Uint8Array.from(Buffer.from(tipHex, "hex"))) : undefined; const seen = new Set<string>(); while (c && !seen.has(toHex(c.hash)) && (!immTip || c.slot > immTip.slot)) { seen.add(toHex(c.hash)); volChain.push(c); c = c.prevHash ? vol.get(c.prevHash) : undefined; } volChain.reverse(); }
async function* chain() { for await (const b of imm.iterate(Number(firstSlotOfEpoch(fromEpoch)))) yield b; for (const b of volChain) yield b; }

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
/** Reward account bytes (header ‖ 28-byte credential; header bit 4 = script) → typed key. */
const rewardKey = (b: Uint8Array, p: number): string => { const start = p + ((b[p]! & 0x1f) < 24 ? 1 : 2); const ra = b.subarray(start, start + 29); return (ra[0]! & 0x10 ? "01" : "") + hex(ra.subarray(1)); };
const credKey = (b: Uint8Array, p: number): string => { const e = items(b, p).starts; const t = uint(b, e[0]!); const hp = e[1]!; const hd = b[hp]! & 0x1f; const s = hp + (hd < 24 ? 1 : 2); return (t === 1 ? "01" : "") + hex(b.subarray(s, s + 28)); };
function bodyFields(b: Uint8Array, s: number): Map<number, number> { const m = items(b, s).starts, f = new Map<number, number>(); for (let i = 0; i < m.length; i += 2) f.set(uint(b, m[i]!), m[i + 1]!); return f; }
const coin = (b: Uint8Array, p: number): bigint => { const h = b[p]!; const ai = h & 0x1f; if (ai < 24) return BigInt(ai); const n = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8; let v = 0n; for (let i = 1; i <= n; i++) v = v * 256n + BigInt(b[p + i]!); return v; };

type Acct = { bal: bigint };
const tracked = new Map<string, Acct>(); // accounts whose balance is known since their last withdrawal / registration
const r = { blocks: 0, txs: 0, withdrawals: 0, firstWithdrawals: 0, withdrawalsChecked: 0, withdrawalsOk: 0, withdrawalMismatch: 0, refundExplained: 0, deregs: 0, deregsChecked: 0, deregsOk: 0, deregMismatch: 0, treasuryClaims: 0, treasuryOk: 0, treasuryMismatch: 0, boundaries: 0, examples: [] as string[] };
let lastEpoch = fromEpoch - 1;
for await (const blk of chain()) {
    const e = Number(epochForSlot(blk.slot));
    while (lastEpoch < e) { lastEpoch++; r.boundaries++; const p = payouts(lastEpoch - 2); for (const [k, a] of tracked) { const x = p.get(k); if (x) a.bal += x; } }
    const s = scanBlock(blk.bytes);
    if (!s || s.era < 7) continue;
    r.blocks++;
    const b = blk.bytes;
    for (let i = 0; i < s.bodies.length; i++) {
        if (s.invalid.has(i)) continue;
        r.txs++;
        const f = bodyFields(b, s.bodies[i]![0]);
        const tv = f.get(21);
        if (tv != null) {
            r.treasuryClaims++;
            const claimed = coin(b, tv), t = sr.potSnapshot(e)?.treasury;
            if (t === claimed) r.treasuryOk++; else { r.treasuryMismatch++; if (r.examples.length < 40) r.examples.push(`treasury slot ${blk.slot}: claims ${claimed}, store ${t}`); }
        }
        if (treasuryOnly) continue;
        const wp = f.get(5);
        if (wp != null) {
            const m = items(b, wp).starts;
            for (let j = 0; j < m.length; j += 2) {
                r.withdrawals++;
                const k = rewardKey(b, m[j]!), amt = coin(b, m[j + 1]!);
                const a = tracked.get(k);
                if (!a) r.firstWithdrawals++;
                else {
                    r.withdrawalsChecked++;
                    if (a.bal === amt) r.withdrawalsOk++;
                    else {
                        const d = amt - a.bal, gd = govDeposit(e), pd = poolDeposit(e);
                        if ((gd > 0n && d > 0n && d % gd === 0n) || (d > 0n && d % pd === 0n)) { r.refundExplained++; if (r.examples.length < 40) r.examples.push(`withdrawal slot ${blk.slot} ${k.slice(0, 12)}: ${amt} = rebuilt ${a.bal} + ${d} (a boundary deposit refund)`); }
                        else { r.withdrawalMismatch++; if (r.examples.length < 40) r.examples.push(`WITHDRAWAL slot ${blk.slot} ${k.slice(0, 12)}: ${amt} ≠ rebuilt ${a.bal}`); }
                    }
                }
                tracked.set(k, { bal: 0n });
            }
        }
        const cp = f.get(4);
        if (cp != null) for (const c of items(b, cp).starts) {
            const ce = items(b, c).starts, t = uint(b, ce[0]!);
            if (t === 0 || t === 7 || t === 11 || t === 12 || t === 13) tracked.set(credKey(b, ce[1]!), { bal: 0n });
            if (t === 1 || t === 8) {
                r.deregs++;
                const k = credKey(b, ce[1]!), a = tracked.get(k);
                if (a) { r.deregsChecked++; if (a.bal === 0n) r.deregsOk++; else { r.deregMismatch++; if (r.examples.length < 40) r.examples.push(`DEREG slot ${blk.slot} ${k.slice(0, 12)}: rebuilt balance ${a.bal}`); } }
                tracked.delete(k);
            }
        }
    }
}
console.log(JSON.stringify({ node, fromEpoch, toEpoch: lastEpoch, tracked: tracked.size, ...r }, null, 2));
getLedgerStore()?.close();
process.exit(r.withdrawalMismatch + r.deregMismatch + r.treasuryMismatch ? 1 : 0);

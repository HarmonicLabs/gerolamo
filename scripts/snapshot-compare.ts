/**
 * Compare our three stake snapshots (mark / set / go) with a cardano-node's (`GetStakeSnapshots`
 * for every pool): per-pool stake and the three totals.
 *   bun scripts/snapshot-compare.ts [--ledger <dir>] [--tip-file <selected-tip.hex>] [--socket <node.socket>] [--magic 2]
 */
import { CborArray, CborUInt, CborBytes, CborMap } from "@harmoniclabs/cbor";
import { openLsq } from "./lib/lsq";
import { LedgerStore } from "../src/ledger/LedgerStore";
import { StakeReads } from "../src/ledger/stakeStore";
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const ledgerDir = arg("ledger", "/media/bakon/data/cardano/gerolamo-preview-mithril2/ledger");
const tipFile = arg("tip-file", "/media/bakon/data/cardano/gerolamo-preview-mithril2/db/gerolamo/selected-tip.hex");
const lsq = await openLsq(arg("socket", "/media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket"), Number(arg("magic", "2")));
const res = await lsq.query(new CborArray([new CborUInt(0), new CborArray([new CborUInt(0), new CborArray([new CborUInt(6), new CborArray([new CborUInt(20), new CborArray([])])])])])) as CborArray;
const inner = res.array[0] as CborArray;
const relay = new Map<string, bigint[]>();
for (const e of (inner.array[0] as CborMap).map) relay.set(Buffer.from((e.k as CborBytes).bytes).toString("hex"), (e.v as CborArray).array.map((x) => (x as CborUInt).num));
const totals = inner.array.slice(1).map((x) => (x as CborUInt).num);
const st = LedgerStore.open(ledgerDir, { readOnly: true });
st.selectTip(Uint8Array.from(Buffer.from((await Bun.file(tipFile).text()).trim(), "hex")));
const r = new StakeReads(st);
const E = r.latestSnapshotEpoch()!;
const ours = [E, E - 1, E - 2].map((e) => r.snapshotPoolStake(e));
const ourTotals = [E, E - 1, E - 2].map((e) => r.snapshotTotals(e)?.total ?? 0n);
const names = ["mark", "set", "go"];
for (let i = 0; i < 3; i++) {
    let same = 0; const diffs: string[] = [];
    const ids = new Set([...relay.keys(), ...ours[i]!.keys()]);
    for (const id of ids) { const a = relay.get(id)?.[i] ?? 0n, b = ours[i]!.get(id) ?? 0n; if (a === b) same++; else diffs.push(`${id.slice(0, 12)} node ${a} ours ${b} (${b - a > 0n ? "+" : ""}${b - a})`); }
    console.log(`${names[i]} (taken at ${E - i}): total node ${totals[i]} ours ${ourTotals[i]} ${totals[i] === ourTotals[i] ? "EQUAL" : "DIFFER"}; ${same} of ${ids.size} pools equal`);
    for (const d of diffs.slice(0, 8)) console.log("  ", d);
}
lsq.close(); st.close(); process.exit(0);

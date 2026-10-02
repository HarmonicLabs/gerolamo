/**
 * Per-credential stake check against a cardano-node: for the given pools, list the credentials of our
 * mark snapshot whose delegation or reward balance differs from the node's current state.
 *   bun scripts/stake-compare.ts <poolIdPrefix> [...]   (paths: preview data node 3036 and the local relay)
 */
import { CborArray, CborUInt, CborBytes, CborTag, CborMap } from "@harmoniclabs/cbor";
import { openLsq } from "./lib/lsq";
import { LedgerStore } from "../src/ledger/LedgerStore";
import { StakeReads } from "../src/ledger/stakeStore";
const pools = process.argv.slice(2);
const st = LedgerStore.open("/media/bakon/data/cardano/gerolamo-preview-mithril2/ledger", { readOnly: true });
st.selectTip(Uint8Array.from(Buffer.from((await Bun.file("/media/bakon/data/cardano/gerolamo-preview-mithril2/db/gerolamo/selected-tip.hex").text()).trim(), "hex")));
const r = new StakeReads(st);
const mark = r.snapshotCredentials(1434);
const lsq = await openLsq("/media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket", 2);
for (const pool of pools) {
  const pid = [...r.pools().keys()].find((k) => k.startsWith(pool))!;
  const creds = [...mark].filter(([, v]) => v.pool === pid);
  const credObj = (h: string) => h.length === 58 ? new CborArray([new CborUInt(1), new CborBytes(Buffer.from(h.slice(2), "hex"))]) : new CborArray([new CborUInt(0), new CborBytes(Buffer.from(h, "hex"))]);
  const res = await lsq.query(new CborArray([new CborUInt(0), new CborArray([new CborUInt(0), new CborArray([new CborUInt(6), new CborArray([new CborUInt(10), new CborTag(258, new CborArray(creds.map(([c]) => credObj(c))))])])])])) as CborArray;
  const inner = (res.array[0] as CborArray);
  const deleg = new Map<string, string>(), rew = new Map<string, bigint>();
  const keyOf = (o: any) => { const a = o as CborArray; const t = Number((a.array[0] as CborUInt).num); const h = Buffer.from((a.array[1] as CborBytes).bytes).toString("hex"); return t === 1 ? "01" + h : h; };
  for (const e of (inner.array[0] as CborMap).map) deleg.set(keyOf(e.k), Buffer.from((e.v as CborBytes).bytes).toString("hex"));
  for (const e of (inner.array[1] as CborMap).map) rew.set(keyOf(e.k), (e.v as CborUInt).num);
  let ourSum = 0n; const lines: string[] = [];
  for (const [c, v] of creds) {
    ourSum += v.stake;
    const ourRew = r.rewardBalance(c), relayRew = rew.get(c);
    const relayPool = deleg.get(c);
    if (relayPool !== pid || relayRew !== ourRew) lines.push(`  ${c.slice(0, 16)} mark ${v.stake} | ours: reward ${ourRew} | relay now: reward ${relayRew ?? "unregistered"} pool ${relayPool ? relayPool.slice(0, 12) : "none"}`);
  }
  console.log(`pool ${pid.slice(0, 12)}: ${creds.length} creds in our mark, sum ${ourSum}; ${lines.length} with a different delegation or reward at the relay now`);
  for (const l of lines.slice(0, 8)) console.log(l);
}
lsq.close(); st.close(); process.exit(0);

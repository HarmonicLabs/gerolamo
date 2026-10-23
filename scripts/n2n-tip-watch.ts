/**
 * Does a node push new headers to a ChainSync client waiting at its tip? Connects over N2N, intersects at the
 * server's current tip, sends one RequestNext (expects MsgAwaitReply) and then measures how long each following
 * RollForward takes to arrive relative to its block's slot time. A healthy server delivers within about a second
 * of the block; a server that never delivers is the bug 392 symptom (both server containers, 2026-10-10).
 *
 *   bun scripts/n2n-tip-watch.ts --host 127.0.0.1 --port 3002 [--magic 2] [--blocks 3] [--timeout-sec 120]
 */
import { connect } from "node:net";
import { ChainPoint, ChainSyncAwaitReply, ChainSyncClient, ChainSyncIntersectFound, ChainSyncRollBackwards, ChainSyncRollForward, HandshakeAcceptVersion, HandshakeClient, Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const host = opt("host") ?? "127.0.0.1", port = Number(opt("port") ?? 3001), magic = Number(opt("magic") ?? 2);
const want = Number(opt("blocks") ?? 3), timeoutSec = Number(opt("timeout-sec") ?? 120);
const SYSTEM_START = Number(opt("system-start") ?? 1666656000); // preview; a slot is one second
const slotTime = (slot: bigint) => (SYSTEM_START + Number(slot)) * 1000;

const mux = new Multiplexer({ protocolType: "node-to-node", connect: () => connect({ host, port }) as any });
const accepted = await new HandshakeClient(mux).propose({ networkMagic: magic, query: false });
if (!(accepted instanceof HandshakeAcceptVersion)) { console.log("handshake refused", JSON.stringify(accepted)); process.exit(1); }
const cs = new ChainSyncClient(mux);
// learn the server's tip from an intersect at origin, then intersect at that tip
const probe = await cs.findIntersect([ChainPoint.origin]);
if (!(probe instanceof ChainSyncIntersectFound)) { console.log("origin intersect not found"); process.exit(1); }
const tip = probe.tip.point;
const isect = await cs.findIntersect([tip]);
if (!(isect instanceof ChainSyncIntersectFound)) { console.log("tip intersect not found"); process.exit(1); }
console.log(`intersected at the server tip: slot ${tip.blockHeader?.slotNumber} (block #${probe.tip.blockNo}); now slot ${Math.floor(Date.now() / 1000) - SYSTEM_START}`);
let got = 0; const t0 = Date.now();
let awaiting = false;
while (got < want && Date.now() - t0 < timeoutSec * 1000) {
    const m = await Promise.race([cs.requestNext(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1000, timeoutSec * 1000 - (Date.now() - t0))))]);
    if (m === null) break;
    if (m instanceof ChainSyncAwaitReply) { awaiting = true; console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: AwaitReply (at the tip, waiting for the next block)`); continue; }
    if (m instanceof ChainSyncRollBackwards) { console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: RollBackward to slot ${m.point.blockHeader?.slotNumber ?? "origin"}`); continue; }
    if (m instanceof ChainSyncRollForward) {
        const slot = m.tip.point.blockHeader?.slotNumber ?? 0n; // the tip the server reports; for a tip-follower it is the new block
        const lateMs = Date.now() - slotTime(slot);
        got++;
        console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: RollForward, server tip slot ${slot} #${m.tip.blockNo}, delivered ${(lateMs / 1000).toFixed(1)} s after the slot${awaiting ? " (after AwaitReply)" : ""}`);
        awaiting = false;
        continue;
    }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: ${m?.constructor?.name}`);
}
console.log(got >= want ? `OK: ${got} header(s) delivered while waiting at the tip` : `FAIL: only ${got} header(s) in ${timeoutSec} s while waiting at the tip`);
process.exit(got >= want ? 0 : 2);

/**
 * Smoke test for N2N over WebSocket: runs the browser node client (browser/src/node/browserNode.ts, the code a
 * browser page or extension such as Gerolamino runs) in Bun against a Gerolamo relay's WebSocket bearer, follows the
 * chain for a while and prints what it verified.
 *
 *   bun scripts/n2n-ws-smoke.ts --endpoint ws://192.168.1.173:3004/n2n [--magic 2] [--seconds 120] [--start tip|origin]
 *
 * Passes when the handshake is accepted, at least one header arrives, every header links to its parent, every
 * fetched body matches its header's body hash and no header fails its cryptographic checks.
 */
import { BrowserNode } from "../browser/src/node/browserNode";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const endpoint = arg("endpoint");
if (!endpoint) { console.error("usage: n2n-ws-smoke.ts --endpoint ws://host:port/n2n [--magic 2] [--seconds 120] [--start tip|origin]"); process.exit(2); }
const seconds = Number(arg("seconds", "120"));
const start = (arg("start", "tip") as "tip" | "origin");

const node = new BrowserNode({
    endpoint,
    networkMagic: Number(arg("magic", "2")),
    start,
    log: (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`),
});
const run = node.start().catch((e) => { console.error(`client failed: ${(e as Error).message}`); });
await Promise.race([run, Bun.sleep(seconds * 1000)]);
node.stop();
const s = node.stats;
const summary = {
    version: s.version, lightQuery: s.lightQuery, intersect: s.intersect, serverTip: s.serverTip,
    headers: s.headers, linkOk: s.linkOk, linkBad: s.linkBad, blocksFetched: s.blocksFetched, bodyOk: s.bodyOk, bodyBad: s.bodyBad,
    cryptoOk: s.cryptoOk, cryptoBad: s.cryptoBad, cryptoSkipped: s.cryptoSkipped, leaderOk: s.leaderOk, leaderBad: s.leaderBad,
    rollbacks: s.rollbacks, bytes: s.bytes, error: s.error,
};
console.log(JSON.stringify(summary, null, 2));
const ok = s.version != null && s.headers > 0 && s.linkBad === 0 && s.bodyBad === 0 && s.cryptoBad === 0 && s.leaderBad === 0;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);

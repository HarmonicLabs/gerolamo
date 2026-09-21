/**
 * Run the browser node's client core under Bun against a relay's WebSocket bearer:
 *   GEROLAMO_WS_N2N=ws://127.0.0.1:3003 bun browser/scripts/probe.ts [--magic 2] [--headers 5] [--origin | --mithril]
 */
import { BrowserNode } from "../src/node/browserNode";
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const endpoint = process.env.GEROLAMO_WS_N2N ?? "ws://127.0.0.1:3003";
const want = Number(opt("headers") ?? 5);
let done = false;
const node = new BrowserNode({
    endpoint, networkMagic: Number(opt("magic") ?? 2), start: argv.includes("--mithril") ? "mithril" : argv.includes("--origin") ? "origin" : "tip",
    apiBase: process.env.GEROLAMO_RELAY_API || undefined,
    log: (l) => console.log(l),
    onStats: (s) => {
        if (!done && (s.headers >= want || s.state === "error" || s.state === "stopped")) {
            done = true;
            console.log(JSON.stringify({ ...s, endpoint: undefined }, null, 1));
            node.stop();
            setTimeout(() => process.exit(s.state === "error" || s.linkBad || s.bodyBad || s.cryptoBad || s.leaderBad ? 1 : 0), 100);
        }
    },
});
await node.start();

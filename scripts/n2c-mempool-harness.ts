/**
 * Serve Gerolamo's N2C LocalTxSubmission / LocalTxMonitor on a scratch socket, with the
 * validating mempool reading the reference node's ledger over LocalStateQuery — so cardano-cli can
 * be pointed at both sockets and its output compared (`transaction submit`, `query tx-mempool`).
 * Nothing is forwarded anywhere: accepted transactions stay in this process.
 *
 *   bun scripts/n2c-mempool-harness.ts --ref <node.socket> --socket <scratch.socket> [--magic 2] [--seconds 600]
 *       [--demo-tx]   also admit one valid transaction against an in-memory UTxO (a generated key's output),
 *                     so LocalTxMonitor has something to show (NextTx / HasTx / GetSizes / GetMeasures)
 */
import { encodeSignedTx, encodeTxBody, generateKeyPair, keyHash, baseAddressBytes, addressBech32, signTxBody } from "../src/pool/operator";
import { openN2c } from "./lib/n2c";
import { lsqLedgerView } from "./lib/lsqLedgerView";
import { ValidatingMempool, type MempoolLedgerView } from "../src/mempool/ValidatingMempool";
import { setMempool } from "../src/mempool";
import { startN2CServer } from "../src/network/n2c";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const magic = Number(arg("magic", "2"));
const c = await openN2c(arg("ref", "/media/bakon/data/cardano/cardano-node/preview-relay/socket/node.socket")!, magic);
const base = await lsqLedgerView(c, magic === 764824073 ? "mainnet" : "testnet", magic === 2 ? "preview" : magic === 1 ? "preprod" : "mainnet");
// one request at a time on the shared LocalStateQuery connection; a fresh ledger state per tip read
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };
const view: MempoolLedgerView = {
    tip: () => serial(async () => { await base.reacquire(); return base.tip(); }),
    state: (s) => serial(() => base.state(s)),
    resolve: (r) => serial(() => base.resolve(r)),
    pools: base.pools, rewardBalances: base.rewardBalances, stake: base.stake, epochNetwork: base.epochNetwork,
};
let mempoolView = view;
let demo: Uint8Array | null = null;
if (process.argv.includes("--demo-tx")) {
    const key = generateKeyPair(new Uint8Array(32).fill(42));
    const addrBytes = baseAddressBytes(0, keyHash(key.vkey), keyHash(key.vkey));
    const src = `${"42".repeat(32)}:0`;
    const fake = { ref: src, address: addressBech32(addrBytes), value: new Map([["lovelace", 10_000_000n]]), referenceScriptHash: null, hasDatum: false };
    mempoolView = { ...view, resolve: async (refs) => { const m = await view.resolve(refs.filter((r) => r !== src)); if (refs.includes(src)) m.set(src, fake); return m; } };
    const body = encodeTxBody({ inputs: [{ txHash: Uint8Array.from(Buffer.from("42".repeat(32), "hex")), index: 0 }], outputs: [{ address: addrBytes, lovelace: 9_800_000n }], fee: 200_000n, certificates: [] });
    demo = encodeSignedTx(body, signTxBody(body, [key]));
}
const mp = new ValidatingMempool({ view: mempoolView });
setMempool(mp);
if (demo) { const r = await mp.addTx(demo, "demo"); console.log(`demo tx ${r.txId} ${r.ok ? "admitted" : "rejected: " + (r as any).reasons.join("; ")} (${demo.length} bytes)`); }
const h = await startN2CServer({ socketPath: arg("socket")!, networkMagic: magic });
console.log(`harness listening on ${h.socketPath}`);
setTimeout(async () => { await h.stop(); c.close(); process.exit(0); }, Number(arg("seconds", "600")) * 1000);

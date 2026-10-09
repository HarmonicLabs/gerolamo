#!/usr/bin/env bun
/**
 * UTxO RPC smoke test against a running node, with the official @utxorpc/sdk clients (gRPC h2c)
 * plus one Connect (HTTP/1.1) call. Read-only unless --submit is given.
 *
 *   bun scripts/utxorpc-smoke.ts [--uri http://127.0.0.1:50051] [--address addr_test1…] [--follow 3] [--wait 60] [--submit tx.cbor.hex]
 *
 * Enable the server on the node with `utxorpc: { enabled: true, port: 50051 }` in its config (or
 * GEROLAMO_UTXORPC=127.0.0.1:50051). Exit code 1 when a call fails.
 */
import { readFileSync } from "node:fs";
import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { CardanoQueryClient, CardanoSubmitClient, CardanoSyncClient, CardanoWatchClient } from "@utxorpc/sdk";
import { syncConnect } from "@utxorpc/spec";
import { shelleyAddressBytes } from "../src/ledger/utxoIndex";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const uri = arg("uri", "http://127.0.0.1:50051")!;
const address = arg("address");
const follow = Number(arg("follow", "2"));
const submitFile = arg("submit");
const waitMs = Number(arg("wait", "60")) * 1000; // stream steps wait this long for the chain to move
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? hex(v) : v);
let failed = 0;

async function step<T>(name: string, fn: () => Promise<T>, show: (x: T) => unknown = (x) => x): Promise<T | undefined> {
    const t0 = performance.now();
    try {
        const r = await fn();
        console.log(`ok   ${name} (${(performance.now() - t0).toFixed(0)} ms): ${JSON.stringify(show(r), big)?.slice(0, 300)}`);
        return r;
    } catch (e) {
        failed++;
        console.log(`FAIL ${name} (${(performance.now() - t0).toFixed(0)} ms): ${(e as Error).message}`);
        return undefined;
    }
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms))]);

const sync = new CardanoSyncClient({ uri });
const query = new CardanoQueryClient({ uri });
const submit = new CardanoSubmitClient({ uri });
const watch = new CardanoWatchClient({ uri });

console.log(`UTxO RPC smoke test against ${uri}`);
const tip = await step("Sync.ReadTip", () => sync.readTip());
await step("Query.ReadParams", () => query.readParams(), (p) => ({ maxTxSize: p.maxTxSize, protocol: p.protocolVersion, costModels: Object.keys(p.costModels ?? {}) }));
await step("Query.ReadGenesis", () => query.inner.readGenesis({}), (g) => ({ caip2: g.caip2, hash: hex(g.genesis) }));
await step("Query.ReadEraSummary", () => query.readErasummary(), (s) => s.map((e) => `${e.name}@${e.start?.epoch}`));
if (tip) {
    await step("Sync.FetchBlock(tip)", () => sync.fetchBlock(tip), (b) => ({ slot: b.parsedBlock.header?.slot, txs: b.parsedBlock.body?.tx.length, bytes: b.nativeBytes.length }));
    await step("Sync.DumpHistory(tip, 1)", () => sync.inner.dumpHistory({ startToken: { slot: BigInt(tip.slot), hash: Buffer.from(tip.hash, "hex") }, maxItems: 1 }), (r) => ({ blocks: r.block.length, next: r.nextToken?.slot }));
    await step(`Sync.FollowTip (${follow} events)`, async () => {
        const out: string[] = [];
        const ac = new AbortController();
        const it = sync.inner.followTip({ intersect: [{ slot: BigInt(tip.slot), hash: Buffer.from(tip.hash, "hex") }] }, { signal: ac.signal });
        await withTimeout((async () => { for await (const e of it) { out.push(`${e.action.case}@${(e.action.value as any)?.chain?.value?.header?.slot ?? (e.action.value as any)?.slot}`); if (out.length >= follow) break; } })(), waitMs).finally(() => ac.abort());
        return out;
    });
    await step("Watch.WatchTx (first event after the tip; needs a moving chain)", async () => {
        const ac = new AbortController();
        const it = watch.inner.watchTx({ intersect: [{ slot: BigInt(tip.slot), hash: Buffer.from(tip.hash, "hex") }] }, { signal: ac.signal });
        let first = "";
        await withTimeout((async () => { for await (const e of it) { first = e.action.case ?? ""; break; } })(), waitMs).finally(() => ac.abort());
        return first;
    });
}
if (address) {
    const raw = shelleyAddressBytes(address);
    if (!raw) console.log("skip Query.SearchUtxos: --address must be a Shelley bech32 address");
    else {
        const found = await step("Query.SearchUtxos(address)", () => query.searchUtxosByAddress(raw as Uint8Array<ArrayBuffer>), (us) => ({ count: us.length, first: us[0] ? `${hex(us[0].txoRef.hash)}#${us[0].txoRef.index}` : null }));
        await step("Query.SearchUtxos(payment part)", () => query.searchUtxosByPaymentPart(raw.subarray(1, 29) as Uint8Array<ArrayBuffer>), (us) => us.length);
        if (found?.length) await step("Query.ReadUtxos", () => query.readUtxosByOutputRef([{ txHash: found[0]!.txoRef.hash, outputIndex: found[0]!.txoRef.index }]), (us) => us.length);
    }
}
await step("Submit.ReadMempool", () => submit.inner.readMempool({}), (m) => m.items.length);
await step("Connect/HTTP1.1 Sync.ReadTip", () => createPromiseClient(syncConnect.SyncService, createConnectTransport({ baseUrl: uri, httpVersion: "1.1" })).readTip({}), (r) => r.tip?.slot);
if (submitFile) {
    const tx = Buffer.from(readFileSync(submitFile, "utf8").trim(), "hex");
    const ref = await step("Submit.EvalTx", () => submit.evalTx(tx), (r) => r.report?.chain.value);
    void ref;
    const id = await step("Submit.SubmitTx", () => submit.submitTx(tx), (r) => hex(r));
    if (id) await step("Submit.WaitForTx (first stage)", async () => { for await (const s of submit.waitForTx(id)) return s; return null; });
}
console.log(failed ? `${failed} call(s) failed` : "all calls answered");
process.exit(failed ? 1 : 0);

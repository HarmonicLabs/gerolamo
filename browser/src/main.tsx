/* @refresh reload */
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer; // the Mithril verifier (shared with the node) uses Buffer for hex/utf8
import { render } from "solid-js/web";
import { createSignal, For, Show } from "solid-js";
import { BrowserNode, type NodeStats } from "./node/browserNode";
import { OpfsSink } from "./node/opfsSink";

const env = (import.meta as any).env ?? {};
const defaultEndpoint: string = env.GEROLAMO_WS_N2N || env.VITE_GEROLAMO_WS_N2N || "ws://127.0.0.1:3003";
const defaultMagic: number = Number(env.GEROLAMO_NETWORK_MAGIC || env.VITE_GEROLAMO_NETWORK_MAGIC || 2);
const defaultApi: string = env.GEROLAMO_RELAY_API || env.VITE_GEROLAMO_RELAY_API || ""; // optional HTTP fallback; everything comes over the WebSocket

function App() {
    const [endpoint, setEndpoint] = createSignal(defaultEndpoint);
    const [magic, setMagic] = createSignal(defaultMagic);
    const [api, setApi] = createSignal(defaultApi);
    const [start, setStart] = createSignal<"tip" | "origin" | "mithril">("tip");
    const [persist, setPersist] = createSignal(OpfsSink.available());
    const [stats, setStats] = createSignal<NodeStats | null>(null);
    const [lines, setLines] = createSignal<string[]>([]);
    const [recent, setRecent] = createSignal<Array<{ slot: number; blockNo: number; hash: string; txs: number; size: number }>>([]);
    const [txCbor, setTxCbor] = createSignal("");
    const [txs, setTxs] = createSignal<Array<{ id: string; size: number; state: string }>>([]);
    let node: BrowserNode | null = null;

    const log = (l: string) => setLines((xs) => [...xs.slice(-199), `${new Date().toISOString().slice(11, 19)} ${l}`]);
    const connect = async () => {
        node?.stop();
        node = new BrowserNode({
            endpoint: endpoint(), networkMagic: magic(), start: start(), log, apiBase: api() || undefined,
            storeSink: persist() && OpfsSink.available() ? new OpfsSink() : undefined, chunkSlots: magic() === 764824073 ? 21600 : 4320,
            onStats: (s) => { setStats(s); setTxs(node!.pendingTxs()); setRecent(node!.recent.slice(-12).reverse().map((b) => ({ slot: b.slot, blockNo: b.blockNo, hash: b.hash, txs: b.txs, size: b.bytes.length }))); },
        });
        log(`connecting to ${endpoint()} (magic ${magic()})`);
        await node.start();
    };
    const stop = () => node?.stop();
    const submit = () => {
        const h = txCbor().replace(/\s+/g, "");
        try {
            if (!/^([0-9a-f]{2})+$/i.test(h)) throw new Error("paste the signed transaction as hex CBOR");
            if (!node) throw new Error("connect first");
            const id = node.submitTx(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))));
            log(`submitted ${id}`); setTxCbor(""); setTxs(node.pendingTxs());
        } catch (e) { log(`submit failed: ${(e as Error).message}`); }
    };
    const fmt = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString("en-US"));
    const s = () => stats();

    return (
        <>
            <h1>Gerolamo Browser Node <span class="muted">· verifying light client over N2N-over-WebSocket</span></h1>
            <div class="row">
                <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} placeholder="ws://relay:3003" />
                <input style="max-width:260px" value={api()} onInput={(e) => setApi(e.currentTarget.value)} placeholder="optional HTTP fallback for the nonce" />
                <input style="max-width:110px" value={String(magic())} onInput={(e) => setMagic(Number(e.currentTarget.value))} placeholder="magic" />
                <select onChange={(e) => setStart(e.currentTarget.value as "tip" | "origin" | "mithril")}>
                    <option value="tip">follow from the relay's tip</option>
                    <option value="mithril">start from a Mithril-certified point (verified here)</option>
                    <option value="origin">sync from origin</option>
                </select>
                <label class="muted"><input type="checkbox" checked={persist()} disabled={!OpfsSink.available()} onChange={(e) => setPersist(e.currentTarget.checked)} /> store chunks in the browser (OPFS)</label>
                <button onClick={connect}>Connect</button>
                <button onClick={async () => { await new OpfsSink().wipe(); log("OPFS store wiped"); }}>Wipe store</button>
                <button onClick={stop}>Stop</button>
            </div>
            <div class="grid">
                <div class="card"><b>State</b><span class={s()?.state === "error" ? "bad" : s()?.state === "at-tip" ? "ok" : ""}>{s()?.state ?? "idle"}</span><div class="muted">{s()?.error ?? (s()?.version != null ? `N2N v${s()!.version}` : "")}</div></div>
                <div class="card"><b>Relay tip</b><span>{fmt(s()?.serverTip?.slot)}</span><div class="muted">height {fmt(s()?.serverTip?.blockNo)}</div></div>
                <div class="card"><b>Our tip</b><span>{fmt(s()?.lastSlot)}</span><div class="muted">height {fmt(s()?.lastBlockNo)} · {s()?.lastHash?.slice(0, 16) ?? ""}</div></div>
                <div class="card"><b>Headers</b><span>{fmt(s()?.headers)}</span><div class="muted"><span class="ok">{fmt(s()?.linkOk)} linked</span>{s()?.linkBad ? <span class="bad"> · {fmt(s()!.linkBad)} broken</span> : ""}</div></div>
                <div class="card"><b>Blocks</b><span>{fmt(s()?.blocksFetched)}</span><div class="muted"><span class="ok">{fmt(s()?.bodyOk)} body hashes ok</span>{s()?.bodyBad ? <span class="bad"> · {fmt(s()!.bodyBad)} bad</span> : ""}</div></div>
                <div class="card"><b>Header crypto</b><span class={s()?.cryptoBad ? "bad" : s()?.cryptoOk ? "ok" : ""}>{fmt(s()?.cryptoOk)} ok</span><div class="muted">{s()?.cryptoBad ? `${fmt(s()!.cryptoBad)} FAILED · ` : ""}{fmt(s()?.cryptoSkipped)} skipped · opcert + KES + VRF{s()?.nonceEpoch != null ? ` · η0 epoch ${s()!.nonceEpoch}` : ""}</div></div>
                <div class="card"><b>Leader check</b><span class={s()?.leaderBad ? "bad" : s()?.leaderOk ? "ok" : ""}>{fmt(s()?.leaderOk)} ok</span><div class="muted">{s()?.leaderBad ? `${fmt(s()!.leaderBad)} FAILED · ` : ""}{fmt(s()?.leaderSkipped)} skipped · stake over WebSocket{s()?.lightQuery === false ? " · relay lacks light query" : ""}</div></div>
                <div class="card"><b>Stored (OPFS, node chunk format)</b><span>{fmt(s()?.storedBlocks)} blocks</span><div class="muted">{((s()?.storedBytes ?? 0) / 1e6).toFixed(2)} MB in {fmt(s()?.storedChunks)} chunk file(s){s()?.resumedFrom != null ? ` · resumed from slot ${fmt(s()!.resumedFrom)}` : ""}</div></div>
                <Show when={s()?.anchor}>{(a) => <div class="card"><b>Mithril anchor</b><span class="ok">slot {fmt(a().slot)}</span><div class="muted">snapshot {a().snapshotHash.slice(0, 12)}… epoch {a().epoch} · chunk {a().chunkNo} ({a().blocksInChunk} blocks) · {a().certificatesWalked}</div></div>}</Show>
                <div class="card"><b>Transferred</b><span>{((s()?.bytes ?? 0) / 1e6).toFixed(2)} MB</span><div class="muted">{fmt(s()?.rollbacks)} rollbacks · intersect {s()?.intersect ?? ""}</div></div>
            </div>
            <div class="card" style="margin-bottom:12px">
                <b>Submit a transaction</b>
                <div class="muted">Signed transaction CBOR (hex, as in a cardano-cli <code>.signed</code> file's cborHex). The relay pulls it over tx-submission on this WebSocket and validates it into its mempool.</div>
                <div class="row"><textarea style="flex:1;min-height:56px;font-family:monospace;font-size:11px" value={txCbor()} onInput={(e) => setTxCbor(e.currentTarget.value)} placeholder="84a4…" /><button onClick={submit} disabled={s()?.state !== "syncing" && s()?.state !== "at-tip"}>Submit</button></div>
                <For each={txs()}>{(t) => <div class="muted" style="font-size:12px">{t.id.slice(0, 24)}… · {t.size} B · {t.state === "fetched" ? "sent to the relay" : t.state === "announced" ? "announced, waiting for the relay" : "queued"}</div>}</For>
            </div>
            <Show when={recent().length}>
                <div class="card" style="margin-bottom:12px">
                    <b>Recent blocks (verified)</b>
                    <table style="width:100%;font-size:12px;font-variant-numeric:tabular-nums"><tbody>
                        <For each={recent()}>{(b) => <tr><td>{fmt(b.slot)}</td><td>{fmt(b.blockNo)}</td><td class="muted">{b.hash.slice(0, 24)}…</td><td>{b.txs} tx</td><td>{(b.size / 1024).toFixed(1)} KB</td></tr>}</For>
                    </tbody></table>
                </div>
            </Show>
            <pre>{lines().join("\n")}</pre>
        </>
    );
}

render(() => <App />, document.getElementById("root")!);

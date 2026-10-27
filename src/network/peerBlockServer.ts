import { settings } from "../config/settings";
import { plutusPhase2Totals } from "../consensus/BlockBodyValidator";
import { equivocationStats } from "../consensus/equivocation";
import { statsHtmlPage } from "./statsPage";
import { govRuleSummary } from "../consensus/governance/govValidate";
import { mempoolMetrics } from "../mempool";
import { ledgerStoreSummary } from "../ledger/nodeLedgerStore";
import { getBlockProducer } from "../pool/startBlockProducer";
import { resolveMithrilServeConfig } from "../mithril/cdb/serveConfig";
import { createMithrilArtifactHandler } from "../mithril/cdb/server";
import { ArtifactStore } from "../mithril/cdb/store";
import { mithrilReplayStatus, readMithrilProgressCached } from "../mithril/progress";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { getBasePath } from "../utils/paths";
import {
    getUtxosByTxHash,
    getUtxoByRef,
    getBlockBySlot,
    getBlockByHash,
    getMaxSlot,
    getUtxoCountCached,
    getEpochNonce,
    getGenesisUtxoStatsCached,
    spentRowsStats,
} from "../db";
import { isReadOnlyContext, sql, withReadOnlyConnection } from "../sql";
import { bfBlockByHash, handleMiniBlockfrost, mempoolSnapshot } from "../api/miniBlockfrost";
import { handleOpenApiRoutes } from "../api/openApi";
import { calculatePreProdCardanoEpoch, epochForSlot, epochLengthSlots, firstSlotOfEpoch, getEpochNetwork } from "../utils/epochFromSlotCalculations";

/** The network the node runs on (preprod / preview / mainnet), not the config's generic "testnet". */
function networkName(config: { network?: string } | undefined): string {
    const n = settings().network;
    if (n === "preprod" || n === "preview" || n === "mainnet") return n;
    return getEpochNetwork() ?? config?.network ?? "unknown";
}
import { eraName } from "../utils/eraNames";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../utils/logger";
import { resolve as resolvePath } from "node:path";

import { createResourceSampler } from "../utils/processStats";
import { resolveNodeRole } from "./nodeRole";
import { resolveValidationPolicy } from "../consensus/validationPolicy";
import { getBuildInfo } from "../utils/buildInfo";

import type { GerolamoConfig } from "./peerManager";
import {
    attachWsServer,
    nextClientId,
    defaultTopics,
    allTopics,
    isWsTopic,
    wsPublish,
    wsSubscriberCount,
    type WsClientData,
    type WsTopic,
} from "./wsHub";
import {
    setMempoolListener,
    setTipListener,
    setPeersListener,
} from "./liveEvents";
import { blockStoreMode, getNodeBlockStore, primaryBlockStore, relayChainStoreOverride } from "../storage/nodeBlockStore";
import { recentOnSelectedChain } from "../storage/blockReads";
import { blockNoOf } from "../storage/volatileStore";

/** The newest stored blocks for the stats page (index walk on `blocks(slot)`, cached 2 s). */
let recentBlocksCache: { at: number; value: Array<{ slot: number; hash: string; blockNo: number | null; bytes: number }> } | null = null;
async function recentBlocksCached(): Promise<Array<{ slot: number; hash: string; blockNo: number | null; bytes: number }>> {
    if (recentBlocksCache && Date.now() - recentBlocksCache.at < 2000) return recentBlocksCache.value;
    const bs = primaryBlockStore();
    const value = bs
        ? (await recentOnSelectedChain(bs, 12)).map((b) => ({ slot: b.slot, hash: Buffer.from(b.hash).toString("hex"), blockNo: blockNoOf(b.bytes), bytes: b.bytes.length }))
        : ((await sql`SELECT slot, hash, block_no, length(block_data) FROM blocks ORDER BY slot DESC LIMIT 12`.values()) as unknown[][])
            .map((r) => ({ slot: Number(r[0]), hash: String(r[1]), blockNo: r[2] == null ? null : Number(r[2]), bytes: Number(r[3] ?? 0) }));
    recentBlocksCache = { at: Date.now(), value };
    return value;
}

/** cardano-node-format block store status for the stats page (docs/PLAN_CHUNK_STORE.md). */
async function blockStoreSummary(): Promise<{ mode: string; dir: string; chunks: number; immutableSlot: number | null; volatileBlocks: number; relayStore: string } | null> {
    const store = getNodeBlockStore();
    if (!store) return null;
    const tip = await store.immutableTip().catch(() => null);
    return { mode: blockStoreMode(), dir: store.dir, chunks: store.chunks.chunks().length, immutableSlot: tip?.slot ?? null, volatileBlocks: store.volatile.size, relayStore: relayChainStoreOverride() ? "chunks" : "sqlite" };
}

/** Shared-mempool summary for the stats page (cached 2 s). */
let mempoolCache: { at: number; value: { count: number; bytes: number; txs: Array<{ hash: string; size: number }> } } | null = null;
async function mempoolSummaryCached(): Promise<{ count: number; bytes: number; txs: Array<{ hash: string; size: number }> }> {
    if (mempoolCache && Date.now() - mempoolCache.at < 2000) return mempoolCache.value;
    let value = { count: 0, bytes: 0, txs: [] as Array<{ hash: string; size: number }> };
    try {
        const snap = await mempoolSnapshot();
        value = { count: snap.count, bytes: snap.txs.reduce((a, t) => a + t.size, 0), txs: snap.txs.slice(0, 12).map((t) => ({ hash: t.tx_hash, size: t.size })) };
    } catch { /* mempool not initialised yet */ }
    mempoolCache = { at: Date.now(), value };
    return value;
}

/**
 * Ledger era of the block at `tipSlot`, decoded from the stored BlockFetch
 * message (`[4, #6.24([era, block])]`) or a bare `[era, block]` payload.
 * null when the DB is empty or the row cannot be decoded.
 */
async function tipEra(tipSlot: bigint): Promise<number | null> {
    if (tipSlot <= 0n) return null;
    try {
        const row = await getBlockBySlot(tipSlot);
        if (!row) return null;
        // getBlockBySlot uses .values(): positional row; 6 = block_data (`[era, block]` as received)
        const raw: unknown = Array.isArray(row) ? row[6] : row.block_data;
        if (!(raw instanceof Uint8Array) || raw.length === 0) return null;
        let obj = Cbor.parse(raw);
        if (
            obj instanceof CborArray && obj.array.length >= 2 &&
            obj.array[0] instanceof CborUInt && Number(obj.array[0].num) === 4 &&
            obj.array[1] instanceof CborTag && obj.array[1].data instanceof CborBytes
        ) {
            obj = Cbor.parse(obj.array[1].data.bytes);
        }
        if (obj instanceof CborArray && obj.array[0] instanceof CborUInt) {
            const era = Number(obj.array[0].num);
            return era >= 0 && era <= 32 ? era : null;
        }
        return null;
    } catch {
        return null;
    }
}

/** BigInt-free view of the orchestrator's multi-peer sync state. */
function serializeSync(snap: unknown): Record<string, unknown> | null {
    if (!snap || typeof snap !== "object") return null;
    return JSON.parse(
        JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ) as Record<string, unknown>;
}

/** Process/host CPU % are deltas between /metrics builds; one sampler per process. */
const sampleResources = createResourceSampler();

/** Shared metrics blob for /metrics JSON and /stats HTML. */
async function buildMetricsPayload(
    config: GerolamoConfig,
    manager: any,
): Promise<Record<string, unknown>> {
    const tipSlot = await getMaxSlot();
    const utxoCount = await getUtxoCountCached();
    const epoch = Number(calculatePreProdCardanoEpoch(Number(tipSlot)));
    const era = await tipEra(tipSlot);
    // Progress through the tip's epoch (network geometry: Byron vs Shelley epoch length).
    const epochProgress = Number.isFinite(epoch) && epoch >= 0
        ? (() => {
            const first = firstSlotOfEpoch(epoch), len = epochLengthSlots(epoch);
            const inEpoch = BigInt(tipSlot) - first;
            return { firstSlot: first.toString(), epochLength: Number(len), slotInEpoch: Number(inEpoch), percent: Math.min(100, Math.max(0, Number(inEpoch * 10000n / len) / 100)) };
        })()
        : null;
    const epochNonce =
        Number.isFinite(epoch) && epoch >= 0
            ? await getEpochNonce(epoch)
            : null;
    // A Mithril bootstrap's progress file (--mithril-progress-file): the certified-chain import,
    // then "replaying certified chain: N %" until the tip passes the snapshot's last slot.
    const mithrilFile = settings().mithrilProgressFile?.trim();
    const mithrilProgress = mithrilFile ? readMithrilProgressCached(mithrilFile) : null;
    const mithril = mithrilProgress ? { ...mithrilProgress, replay: mithrilReplayStatus(mithrilProgress, tipSlot) } : null;
    // The epoch the network is in (best peer tip): "epoch 1255 / 1411" while syncing.
    let targetEpoch: number | null = null;
    try {
        const raw = typeof manager?.getBestPeerTipSlot === "function" ? manager.getBestPeerTipSlot() : null; // string | null
        const bestPeerTip = raw != null ? BigInt(String(raw)) : 0n;
        if (bestPeerTip > 0n) targetEpoch = Number(epochForSlot(bestPeerTip));
    } catch { /* no usable peer tip yet */ }
    const gov =
        typeof manager?.getGovernorSnapshot === "function"
            ? manager.getGovernorSnapshot()
            : null;
    const resources = sampleResources();
    const validation = resolveValidationPolicy(config);
    const genesisUtxos = await getGenesisUtxoStatsCached().catch(() => ({ total: 0, unspent: 0, avvm: 0 }));
    return {
        network: networkName(config),
        tipSlot: tipSlot.toString(),
        utxoCount,
        /** Genesis outputs seeded from the Byron genesis file: how many exist and how many are still unspent (included in utxoCount). */
        genesisUtxos,
        epoch: Number.isFinite(epoch) ? epoch : null,
        /** Epoch of the best peer's tip, null until a peer reported one. */
        targetEpoch,
        mithril,
        /** Where transaction inputs were served from since start (rules pre-read, recent-output cache, database). */
        spentRows: { ...spentRowsStats },
        era,
        eraName: eraName(era),
        epochProgress,
        epochNonce,
        bodyValidation: validation.body,
        scriptValidation: validation.script,
        /** Plutus phase 2: mode (enforce | report | off) and totals since start (rules/phase2.ts). */
        plutus: plutusPhase2Totals(),
        /** False on tip sync: no ledger state behind the tip, tx rules are report-only. */
        ledgerComplete: validation.ledgerComplete,
        validationNote: validation.note,
        /** Validating mempool: size/capacity, verdict counters, admission and revalidation latency (ms). */
        mempoolValidation: mempoolMetrics(),
        uptimeSec: Math.round(process.uptime()),
        node: "gerolamo",
        /** Node build: package version + git commit (+ -dirty when the checkout has local edits). */
        version: getBuildInfo().label,
        /** "data" (outbound only) or "relay" (accepts inbound N2N). */
        role: resolveNodeRole(config),
        producer: getBlockProducer()?.stats() ?? null,
        /** Two different valid headers from one pool for one slot (consensus/equivocation.ts): totals and the newest pairs. */
        equivocations: equivocationStats(),
        recentBlocks: await recentBlocksCached(),
        blockStore: await blockStoreSummary(),
        ledgerStore: ledgerStoreSummary(),
        /** Conway GOV / GOVCERT / DELEG / POOL checks: mode, transactions checked, failures by rule. */
        governanceRules: govRuleSummary(),
        mempool: await mempoolSummaryCached(),
        /** Inbound node-to-node listener state. */
        inbound:
            typeof manager?.getInboundStatus === "function"
                ? manager.getInboundStatus()
                : { listening: false, host: null, port: null, clients: 0 },
        /** This node process: rss/heap bytes, cpuPercent (100 = one core). */
        process: resources.process,
        /** Host: cpus, cpuPercent (0–100), mem bytes, loadAvg. */
        system: resources.system,
        peers: gov
            ? {
                cold: gov.cold,
                warm: gov.warm,
                hot: gov.hot,
                total: gov.total,
                hotKeys: gov.hotKeys,
            }
            : null,
        governor: gov ?? null,
        peerTipSlot:
            typeof manager?.getBestPeerTipSlot === "function"
                ? manager.getBestPeerTipSlot()
                : null,
        sync:
            typeof manager?.getSyncSnapshot === "function"
                ? serializeSync(manager.getSyncSnapshot())
                : null,
        syncFromTip: !!config.syncFromTip,
        syncFromGenesis: !!config.syncFromGenesis,
        syncFromPoint: !!config.syncFromPoint,
    };
}


export async function startPeerBlockServer(
    config: GerolamoConfig,
    manager: any,
) {
    const BASE_PATH = getBasePath();
    const port = config.port || 3030;
    const network = networkName(config);

    interface BlockRow {
        block_data?: Uint8Array;
    }

    // Mithril artifact routes (/mithril/*), only when configured (off by default).
    const mithrilServe = resolveMithrilServeConfig(config.mithril);
    const mithrilHandler = mithrilServe
        ? createMithrilArtifactHandler({ store: new ArtifactStore(mithrilServe.artifactsDir), publicBaseUrl: mithrilServe.publicBaseUrl, listUncertified: mithrilServe.listUncertified })
        : null;

    const handleHttp = async (req: Request, srv: import("bun").Server<WsClientData>): Promise<Response | undefined> => {
        const url = new URL(req.url);

        if (mithrilHandler) {
            const r = await mithrilHandler(req, url);
            if (r) return r;
        }

        // Bun WebSocket upgrade — ops stream (tip/peers/metrics)
        if (url.pathname === "/ws/stats" || url.pathname === "/ws") {
            const ok = srv.upgrade(req, {
                data: {
                    id: nextClientId(),
                    topics: defaultTopics(),
                } satisfies WsClientData,
            });
            if (!ok) {
                return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return undefined;
        }

        // OpenAPI 3 + Swagger docs (/docs, /openapi.json); old /dashboard/ai → 302 /docs
        const oaResp = await handleOpenApiRoutes(req, url, {
            network: networkName(config),
            port,
        });
        if (oaResp) return oaResp;

        // Mini-Blockfrost core (/api/v0/*) — before generic fallback
        const bfResp = await handleMiniBlockfrost(req, url, {
            network: networkName(config),
            submitTx: manager
                ? (txCbor: Uint8Array) => manager.submitTx({ txCbor })
                : undefined,
        });
        if (bfResp) return bfResp;

        if (url.pathname === "/health" || url.pathname === "/healthz") {
            return new Response(
                JSON.stringify({
                    healthy: true,
                    network,
                    port,
                    uptimeSec: Math.round(process.uptime()),
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
        // Landing page = live stats dashboard (not the endpoints text dump)
        if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(null, {
                status: 302,
                headers: {
                    Location: "/stats",
                    "Cache-Control": "no-store",
                },
            });
        }
        if (
            url.pathname === "/stats" ||
            url.pathname === "/dashboard"
        ) {
            return new Response(statsHtmlPage(port, String(network), Number(epochLengthSlots(1_000_000n))), {
                status: 200,
                headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            });
        }
        if (
            url.pathname === "/governor" ||
            url.pathname === "/api/v0/governor"
        ) {
            const snap =
                typeof manager?.getGovernorSnapshot === "function"
                    ? manager.getGovernorSnapshot()
                    : null;
            return new Response(
                JSON.stringify(
                    snap ?? {
                        note: "governor unavailable (legacy path or not started)",
                    },
                ),
                {
                    status: snap ? 200 : 503,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
        if (url.pathname === "/resources") {
            // 2 s resource samples for the Resources panel: process + host + apply rate + DB size.
            try {
                const r = sampleResources();
                const snap = typeof manager?.getSyncSnapshot === "function" ? serializeSync(manager.getSyncSnapshot()) : null;
                let dbBytes: number | null = null;
                try {
                    const { statSync } = await import("node:fs");
                    dbBytes = 0;
                    for (const suf of ["", "-wal", "-shm"]) { try { dbBytes += statSync(String(config.dbPath) + suf).size; } catch { /* absent */ } }
                } catch { /* no fs */ }
                const body = {
                    ts: Date.now(),
                    process: r.process,
                    system: r.system,
                    blocksPerSec: snap ? Number((snap as any).blocksPerSec ?? 0) : null,
                    pendingHeaders: snap ? Number((snap as any).pendingHeaders ?? 0) : null,
                    tipSlot: (await getMaxSlot()).toString(),
                    dbBytes,
                };
                return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e?.message ?? String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
            }
        }
        if (url.pathname === "/metrics") {
            try {
                const body = await buildMetricsPayload(config, manager);
                return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            } catch (e: any) {
                logger.error("/metrics error:", e?.message || e);
                return new Response(
                    JSON.stringify({ error: "metrics unavailable" }),
                    {
                        status: 500,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            }
        }
        if (req.method === "POST" && url.pathname === "/txsubmit") {
            if (!manager) {
                return new Response("Peer manager not available", {
                    status: 500,
                });
            }
            try {
                const txCbor = new Uint8Array(await req.arrayBuffer());
                if (txCbor.length === 0) {
                    return new Response("Empty tx body", { status: 400 });
                }
                logger.info(
                    `HTTP txsubmit: ${txCbor.length} bytes from ${
                        req.headers.get("user-agent") || "unknown"
                    }`,
                );
                let verdict: { status: string; nTxs: number; availableSpace: number };
                try {
                    verdict = await manager.submitTx({ txCbor });
                } catch (e: any) {
                    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
                        status: 503,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                // shared-cardano-mempool-ts MempoolAppendStatus: 0 Ok, 1 AlreadyPresent, 2 InsufficientSpace, 3 MaxTxsReached
                const accepted = verdict.status === "success" || verdict.status === "0" || verdict.status === "1";
                const why = verdict.status === "2" ? "insufficient space" : verdict.status === "3" ? "max transactions reached" : verdict.status.replace(/^rejected: /, "");
                return new Response(
                    JSON.stringify({ status: accepted ? "accepted into local mempool; hot peers pull it via tx-submission" : `rejected: ${why}`, mempool: verdict }),
                    {
                        status: accepted ? 202 : 400,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            } catch (e: any) {
                logger.error("txsubmit error:", e.message || e);
                return new Response("Invalid request", { status: 400 });
            }
        }
        if (url.pathname.startsWith("/utxo/")) {
            const ref = decodeURIComponent(url.pathname.slice(6));
            logger.info(`UTXO query for ref: ${ref}`);

            // Validate format: txhash (64 hex) or txhash:index (digits)
            if (!/^[0-9a-f]{64}(:\d+)?$/i.test(ref)) {
                return new Response(
                    "Invalid format: /utxo/{64hex-txhash} or /utxo/{64hex-txhash}:{index}",
                    { status: 400 },
                );
            }

            const parts = ref.split(":");
            let responseBody: string;
            let status = 200;

            if (parts.length === 1) {
                // txhash only: all outputs
                const txHash = parts[0];
                const utxos = await getUtxosByTxHash(txHash);
                if (utxos.length === 0) {
                    return new Response("No UTXOs found for tx hash", {
                        status: 404,
                    });
                }
                logger.info(
                    `Found ${utxos.length} UTXOs for tx ${
                        txHash.slice(0, 8)
                    }...`,
                );
                responseBody = JSON.stringify(
                    utxos.map((u: any) => u.tx_out),
                );
            } else {
                // specific utxo_ref
                const idx = parseInt(parts[1], 10);
                if (isNaN(idx) || idx < 0) {
                    return new Response("Invalid output index", {
                        status: 400,
                    });
                }
                const utxo = await getUtxoByRef(ref);
                if (!utxo) {
                    return new Response("UTXO not found", { status: 404 });
                }
                responseBody = utxo.tx_out;
            }

            return new Response(responseBody, {
                status,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (
            !url.pathname.startsWith("/block/") &&
            !url.pathname.startsWith("/utxo/")
        ) {
            return new Response(
                "Endpoints: GET /health GET /metrics GET /governor GET /stats GET /ws/stats GET /docs GET /openapi.json GET /api/v0/* GET /block/{slot|hash} GET /utxo/{txhash:index} POST /txsubmit (CBOR tx body)",
                { status: 200 },
            );
        }
        const id = decodeURIComponent(url.pathname.slice(7));
        let row: any;

        if (/^\d+n?$/.test(id)) {
            const slot = BigInt(id.replace("n", ""));
            row = (await getBlockBySlot(slot)) ?? null;
        } else {
            row = (await getBlockByHash(id)) ?? null;
        }

        const blockData: unknown = Array.isArray(row) ? row[6] : row?.block_data;
        if (!(blockData instanceof Uint8Array) || blockData.length === 0) {
            return new Response("Block not found", { status: 404 });
        }
        // Same payload as before: the BlockFetch message `[4, #6.24([era, block])]`, built on read.
        return new Response(toHex(new BlockFetchBlock({ blockData }).toCborBytes()), {
            headers: { "Content-Type": "application/cbor" },
        });
    };

    const server = Bun.serve({
        ...(config.unixSocket
            ? { unix: "./src/gerolamo.socket" }
            : { port }),
        async fetch(req: Request, srv: import("bun").Server<WsClientData>): Promise<Response | undefined> {
            // GET handlers only read: answer from the read-only connection so the explorer,
            // dashboards and mini-Blockfrost do not wait behind the applier's write transactions.
            if (req.method === "GET" && !isReadOnlyContext()) return withReadOnlyConnection(() => handleHttp(req, srv));
            return handleHttp(req, srv);
        },
        websocket: {
            data: {} as WsClientData,
            open(ws) {
                for (const t of ws.data.topics) {
                    try { ws.subscribe(t); } catch { /* */ }
                }
                try {
                    ws.send(JSON.stringify({
                        v: 1,
                        type: "hello",
                        network: String(network),
                        port,
                        topics: [...allTopics()],
                    }));
                } catch { /* */ }
                void (async () => {
                    try {
                        const body = await buildMetricsPayload(config, manager);
                        if (ws.getBufferedAmount() < 256_000) {
                            ws.send(JSON.stringify({
                                v: 1, type: "metrics", data: body,
                                ts: new Date().toISOString(),
                            }));
                        }
                        const snap = typeof manager?.getGovernorSnapshot === "function"
                            ? manager.getGovernorSnapshot()
                            : null;
                        if (snap && ws.getBufferedAmount() < 256_000) {
                            ws.send(JSON.stringify({
                                v: 1, type: "peers", data: snap,
                                ts: new Date().toISOString(),
                            }));
                        }
                    } catch { /* */ }
                })();
            },
            message(ws, message) {
                try {
                    const msg = JSON.parse(String(message));
                    if (msg?.op === "ping") {
                        ws.send(JSON.stringify({ v: 1, type: "pong", t: msg.t }));
                        return;
                    }
                    if (msg?.op === "subscribe" && Array.isArray(msg.topics)) {
                        for (const t of msg.topics) {
                            if (isWsTopic(t)) {
                                ws.data.topics.add(t);
                                try { ws.subscribe(t); } catch { /* */ }
                            }
                        }
                        return;
                    }
                    if (msg?.op === "unsubscribe" && Array.isArray(msg.topics)) {
                        for (const t of msg.topics) {
                            if (isWsTopic(t)) {
                                ws.data.topics.delete(t);
                                try { ws.unsubscribe(t); } catch { /* */ }
                            }
                        }
                    }
                } catch { /* ignore */ }
            },
            close(_ws) { /* */ },
        },
    });
    attachWsServer(server);

    let lastMetricsPush = 0;
    let lastMempoolCount = -1;
    const publishMempool = async (): Promise<void> => {
        if (wsSubscriberCount("mempool") === 0) return;
        try {
            const snap = await mempoolSnapshot();
            lastMempoolCount = snap.count;
            wsPublish("mempool", snap);
        } catch {
            /* mempool not up yet */
        }
    };
    setTipListener((tip) => {
        wsPublish("tip", tip);
        // The explorer's live list wants the block document, not just the point.
        // Built only when someone listens: three SQLite reads per coalesced tip.
        if (tip.hash && wsSubscriberCount("block") > 0) {
            void bfBlockByHash(tip.hash, config.network ?? settings().network)
                .then((doc) => { if (doc) wsPublish("block", doc); })
                .catch(() => {});
        }
        // Txs leave the mempool without an event of their own (peers pull them, blocks
        // apply them); a block landing is the moment to notice the count changed.
        if (wsSubscriberCount("mempool") > 0) {
            void mempoolSnapshot()
                .then((snap) => { if (snap.count !== lastMempoolCount) { lastMempoolCount = snap.count; wsPublish("mempool", snap); } })
                .catch(() => {});
        }
        const now = Date.now();
        if (now - lastMetricsPush < 1000) return;
        lastMetricsPush = now;
        void buildMetricsPayload(config, manager)
            .then((body) => wsPublish("metrics", body))
            .catch(() => {});
    });
    setMempoolListener(() => void publishMempool());
    setPeersListener((snap) => {
        wsPublish("peers", snap);
        wsPublish("governor", snap);
    });

    logger.info(
        `Serving blocks, stats, WS /ws/stats, OpenAPI /docs, and txsubmit on http://localhost:${port}`,
    );
}

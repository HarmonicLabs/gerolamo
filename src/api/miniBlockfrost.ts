/**
 * Mini-Blockfrost core — Blockfrost-compatible subset for dApps/wallets.
 *
 * Mounted at /api/v0/* on the peer block HTTP server.
 * Not full Blockfrost; honest subset:
 *   GET /api/v0/
 *   GET /api/v0/health
 *   GET /api/v0/network
 *   GET /api/v0/epochs/latest
 *   GET /api/v0/epochs/latest/parameters
 *   GET /api/v0/blocks/latest
 *   GET /api/v0/blocks/{slot|hash}
 *   GET /api/v0/blocks/{slot|hash}/txs
 *   GET /api/v0/addresses/{address}
 *   GET /api/v0/addresses/{address}/utxos
 *   GET /api/v0/addresses/{address}/transactions
 *   GET /api/v0/txs/{hash}
 *   GET /api/v0/txs/{hash}/utxos
 *   GET /api/v0/mempool
 *   GET /api/v0/mempool/{hash}
 *   POST /api/v0/tx/submit  (raw CBOR body)
 *
 * Forward index writes mb_* projections (+ legacy tx_index/address_tx/block_tx).
 * History still needs backfill on .live only (Phase 3).
 */

import {
    getUtxosByAddress,
    getUtxosByTxHash,
    getUtxoByRef,
    getBlockBySlot,
    getBlockByHash,
    getMaxSlot,
    getUtxoCount,
    getEpochNonce,
    getTxByHash,
    getAddressTxs,
    getBlockTxHashes,
    getAddressSummary,
    getNetworkSnapshot,
    getMbTxUtxos,
    getReferenceScriptCborByHash,
    listBlocksDesc,
    listBlocksInSlotRange,
    countBlocksInSlotRange,
    getBlockListRowByHash,
    getBlockListRowBySlot,
    getBlockListRowByHeight,
    getMaxBlockNo,
    countBlockTxs,
    type BlockListRow,
} from "../db";
import {
    epochForSlot,
    epochLengthSlots,
    firstSlotOfEpoch,
    normalizeEpochNetwork,
    slotInEpoch,
    slotToUnixTime,
    type EpochNetwork,
} from "../utils/epochFromSlotCalculations";
import { slotLeaderOfBlock } from "./blockLeader";
import { getStoredEpochParams } from "../consensus/epochParams";
import { ensureLiveProtocolParams } from "./liveProtocolParams";
import {
    parseStoredTxOut,
    storedTxOutContainsAsset,
} from "../db/minibf/txOutMetadata";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { Tx } from "@harmoniclabs/cardano-ledger-ts";
import { logger } from "../utils/logger";
import { GlobalSharedMempool } from "../network/SharedMempool";
import { mempoolTxHashToString } from "@harmoniclabs/shared-cardano-mempool-ts";

/** CORS for Swagger try-it-out + external BF clients. */
const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, project_id, X-Requested-With",
    "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "X-Gerolamo-Api": "mini-blockfrost",
            ...CORS_HEADERS,
        },
    });
}

function bfError(
    status: number,
    error: string,
    message: string,
): Response {
    return json({ status_code: status, error, message }, status);
}

/** BF amount array: [{unit:"lovelace",quantity}, ...assets] */
function toBfAmount(
    lovelace: string,
    assets: Record<string, Record<string, string>>,
): Array<{ unit: string; quantity: string }> {
    const out: Array<{ unit: string; quantity: string }> = [
        { unit: "lovelace", quantity: String(lovelace || "0") },
    ];
    for (const [policy, names] of Object.entries(assets || {})) {
        if (!policy) continue; // skip empty-policy lovelace mirrors
        if (!names || typeof names !== "object") continue;
        for (const [name, qty] of Object.entries(names)) {
            out.push({
                unit: name ? `${policy}${name}` : policy,
                quantity: String(qty),
            });
        }
    }
    return out;
}

function parseUtxoRef(ref: string): { tx_hash: string; output_index: number } {
    const s = String(ref ?? "");
    const i = s.lastIndexOf(":");
    if (i <= 0) return { tx_hash: s, output_index: 0 };
    const idx = parseInt(s.slice(i + 1), 10);
    return {
        tx_hash: s.slice(0, i),
        output_index: Number.isFinite(idx) ? idx : 0,
    };
}

function rowHashToHex(hash: unknown): string {
    if (hash == null) return "";
    if (typeof hash === "string") {
        // already hex or text
        if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
        return hash;
    }
    if (hash instanceof Uint8Array || Buffer.isBuffer(hash)) {
        return toHex(hash as Uint8Array);
    }
    try {
        return toHex(new Uint8Array(hash as ArrayBuffer));
    } catch {
        return String(hash);
    }
}

/** Blockfrost `BlockContent` for a stored block (explorer M1). */
async function bfBlock(row: BlockListRow, tipHeight: number, tipSlot: number, network: EpochNetwork) {
    const epoch = Number(epochForSlot(row.slot, network));
    const isEbb = row.blockNo == null;
    let nextBlock: string | null = null;
    if (isEbb) {
        // the epoch's first main block shares the EBB's slot
        const main = await getBlockListRowBySlot(row.slot);
        nextBlock = main && main.blockNo != null ? main.hash : null;
    } else {
        const n = await getBlockListRowByHeight(row.blockNo! + 1);
        nextBlock = n?.hash ?? null;
    }
    return {
        time: slotToUnixTime(row.slot, network),
        height: row.blockNo,
        hash: row.hash,
        slot: row.slot,
        epoch,
        epoch_slot: Number(slotInEpoch(row.slot, network)),
        slot_leader: row.blockData ? slotLeaderOfBlock(row.blockData) : null,
        size: row.size,
        tx_count: await countBlockTxs(row.hash),
        output: null as string | null,
        fees: null as string | null,
        block_vrf: null as string | null,
        op_cert: null as string | null,
        op_cert_counter: null as string | null,
        previous_block: row.prevHash,
        next_block: nextBlock,
        confirmations: row.blockNo != null ? Math.max(0, tipHeight - row.blockNo) : Math.max(0, tipSlot - row.slot),
        // Gerolamo extension: a Byron epoch-boundary block shares its slot with the epoch's first block
        ebb: isEbb || undefined,
    };
}

/** `latest`, a slot number, or a 64-hex hash → stored block row. */
async function resolveBlockRow(id: string): Promise<{ row: BlockListRow | null; error?: Response }> {
    if (id === "latest") {
        const tipSlot = await getMaxSlot();
        if (tipSlot === 0n) return { row: null, error: bfError(404, "Not Found", "No blocks in local DB") };
        return { row: await getBlockListRowBySlot(Number(tipSlot)) };
    }
    // 64 hex chars is always a hash (a slot never has 64 digits), so test it first.
    if (/^[0-9a-f]{64}$/i.test(id)) return { row: await getBlockListRowByHash(id.toLowerCase()) };
    if (/^\d+n?$/.test(id)) return { row: await getBlockListRowBySlot(Number(id.replace("n", ""))) };
    return { row: null, error: bfError(400, "Bad Request", "Block id must be `latest`, a slot number or a 64-hex hash") };
}

async function bfEpoch(epoch: number, network: EpochNetwork, tipSlot: number) {
    const from = Number(firstSlotOfEpoch(epoch, network));
    const len = Number(epochLengthSlots(epoch, network));
    const to = from + len;
    const blockCount = await countBlocksInSlotRange(from, to);
    let first: BlockListRow | null = null;
    let last: BlockListRow | null = null;
    if (blockCount > 0) {
        first = (await listBlocksInSlotRange(from, to, 1))[0] ?? null;
        last = (await listBlocksInSlotRange(from, to, 1, blockCount - 1))[0] ?? null;
    }
    return {
        epoch,
        start_time: slotToUnixTime(from, network),
        end_time: slotToUnixTime(to, network),
        first_block_time: first ? slotToUnixTime(first.slot, network) : null,
        last_block_time: last ? slotToUnixTime(last.slot, network) : null,
        block_count: blockCount,
        tx_count: null as number | null,
        output: null as string | null,
        fees: null as string | null,
        active_stake: null as string | null,
        // extensions
        first_block: first?.hash ?? null,
        last_block: last?.hash ?? null,
        first_slot: from,
        last_slot: to - 1,
        synced: tipSlot >= to - 1 ? "complete" : tipSlot >= from ? "partial" : "none",
    };
}

/** Result of handing a transaction to the local mempool (from which hot peers pull it). */
export interface MiniBfSubmitResult {
    /** Mempool verdict from the shared mempool: e.g. "success", "duplicate", "full". */
    status: string;
    nTxs: number;
    availableSpace: number;
}
export type MiniBfSubmitTx = (txCbor: Uint8Array, txId: Uint8Array) => Promise<MiniBfSubmitResult>;

export interface MiniBfContext {
    network?: string;
    submitTx?: MiniBfSubmitTx;
}

/**
 * Handle a request already known to be under /api/v0 (or /api/v0/...).
 * Returns null if path is not a mini-BF route (caller continues).
 */
export async function handleMiniBlockfrost(
    req: Request,
    url: URL,
    ctx: MiniBfContext = {},
): Promise<Response | null> {
    const path = url.pathname;
    // Accept both /api/v0 and /api/v0/
    if (path !== "/api/v0" && !path.startsWith("/api/v0/")) {
        return null;
    }

    // OPTIONS preflight (Swagger try-it-out / external clients)
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                ...CORS_HEADERS,
                "X-Gerolamo-Api": "mini-blockfrost",
            },
        });
    }

    const sub = path === "/api/v0" || path === "/api/v0/"
        ? "/"
        : path.slice("/api/v0".length) || "/";
    const net: EpochNetwork = normalizeEpochNetwork(ctx.network ?? process.env.NETWORK);

    try {
        // GET /api/v0/
        if (req.method === "GET" && (sub === "/" || sub === "")) {
            return json({
                url: "/api/v0",
                version: "0.5.0",
                node: "gerolamo",
                network: ctx.network ?? process.env.NETWORK ?? "unknown",
                endpoints: [
                    "GET /api/v0/health",
                    "GET /api/v0/network",
                    "GET /api/v0/epochs/latest",
                    "GET /api/v0/epochs/latest/parameters",
                    "GET /api/v0/blocks?limit=&before=<slot|hash>",
                    "GET /api/v0/blocks/latest",
                    "GET /api/v0/blocks/{slot|hash}",
                    "GET /api/v0/blocks/height/{n}",
                    "GET /api/v0/blocks/{slot|hash}/previous?count=",
                    "GET /api/v0/blocks/{slot|hash}/next?count=",
                    "GET /api/v0/blocks/{slot|hash}/txs",
                    "GET /api/v0/epochs/{n}",
                    "GET /api/v0/epochs/{n}/blocks?page=&count=",
                    "GET /api/v0/epochs/{n}/parameters",
                    "GET /api/v0/epochs/{n}/next|previous?count=",
                    "GET /api/v0/search?q=",
                    "GET /api/v0/addresses/{address}",
                    "GET /api/v0/addresses/{address}/utxos",
                    "GET /api/v0/addresses/{address}/utxos/{asset}",
                    "GET /api/v0/addresses/{address}/transactions",
                    "GET /api/v0/scripts/{hash}/cbor",
                    "GET /api/v0/txs/{hash}",
                    "GET /api/v0/txs/{hash}/utxos",
                    "GET /api/v0/mempool",
                    "POST /api/v0/tx/submit",
                ],
                note: "Mini-Blockfrost subset (not full BF). Live apply writes mb_* projections (+ legacy indexes). History needs Phase-3 backfill on .live only. Consensus never reads mb_*.",
            });
        }

        // GET /api/v0/health
        if (req.method === "GET" && sub === "/health") {
            return json({ is_healthy: true });
        }

        // GET /api/v0/network — tip + supply-ish subset (Dolos MiniBF comfort)
        if (req.method === "GET" && sub === "/network") {
            const snap = await getNetworkSnapshot();
            const tipN = Number(snap.tipSlot);
            const epoch = Number.isFinite(tipN) && tipN > 0
                ? Number(calculatePreProdCardanoEpoch(tipN))
                : null;
            const nonce = epoch != null && Number.isFinite(epoch)
                ? await getEpochNonce(epoch)
                : null;
            return json({
                supply: {
                    max: null,
                    total: null,
                    circulating: null,
                    locked: null,
                    treasury: null,
                    reserves: null,
                },
                stake: {
                    live: null,
                    active: null,
                },
                // Gerolamo / Dolos-adjacent extensions
                tip: {
                    slot: snap.tipSlot,
                    hash: snap.tipHash,
                    epoch,
                    epoch_nonce: nonce,
                },
                utxo_count: snap.utxoCount,
                index: {
                    tx_index: snap.txIndexCount,
                    address_tx: snap.addressTxCount,
                    mb_tx: snap.mbTxCount,
                    mb_cursor_slot: snap.mbCursorSlot,
                    lag_slots: snap.lagSlots,
                },
                note: "Subset — supply/stake not tracked; tip+utxo+mb_* lag only",
            });
        }

        // GET /api/v0/epochs/latest
        if (req.method === "GET" && sub === "/epochs/latest") {
            const tipSlot = await getMaxSlot();
            const epoch = Number(
                calculatePreProdCardanoEpoch(Number(tipSlot)),
            );
            const nonce = Number.isFinite(epoch) && epoch >= 0
                ? await getEpochNonce(epoch)
                : null;
            const utxoCount = await getUtxoCount();
            return json({
                epoch: Number.isFinite(epoch) ? epoch : null,
                start_time: null,
                end_time: null,
                first_block_time: null,
                last_block_time: null,
                block_count: null,
                tx_count: null,
                output: null,
                fees: null,
                active_stake: null,
                // Gerolamo extensions (honest extras)
                tip_slot: tipSlot.toString(),
                utxo_count: utxoCount,
                epoch_nonce: nonce,
            });
        }

        // GET /api/v0/epochs/latest/parameters
        if (
            req.method === "GET" &&
            sub === "/epochs/latest/parameters"
        ) {
            try {
                const params = await ensureLiveProtocolParams(
                    ctx.network ?? process.env.NETWORK ?? "preprod",
                );
                return json(params);
            } catch (err: any) {
                return bfError(
                    503,
                    "Service Unavailable",
                    err?.message ?? "protocol params unavailable",
                );
            }
        }

        // GET /api/v0/blocks/latest
        // GET /api/v0/blocks?limit=&before=<slot|hash>  — newest first (Gerolamo extension; BF has no list)
        if (req.method === "GET" && sub === "/blocks") {
            const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20));
            const before = url.searchParams.get("before");
            let beforeSlot: number | undefined;
            let beforeIsEbb: boolean | undefined;
            if (before) {
                if (/^[0-9a-f]{64}$/i.test(before)) {
                    const cur = await getBlockListRowByHash(before.toLowerCase());
                    if (!cur) return bfError(404, "Not Found", "Cursor block not found");
                    beforeSlot = cur.slot;
                    beforeIsEbb = cur.blockNo == null;
                } else if (/^\d+$/.test(before)) {
                    beforeSlot = Number(before);
                    beforeIsEbb = url.searchParams.get("before_ebb") === "1";
                } else {
                    return bfError(400, "Bad Request", "`before` must be a slot number or a 64-hex block hash");
                }
            }
            const tipSlot = Number(await getMaxSlot());
            const tipHeight = await getMaxBlockNo();
            const rows = await listBlocksDesc({ limit, beforeSlot, beforeIsEbb });
            return json(await Promise.all(rows.map((r) => bfBlock(r, tipHeight, tipSlot, net))));
        }

        // GET /api/v0/blocks/height/{n} — by chain height (Gerolamo extension; BF overloads {hash_or_number})
        {
            const m = sub.match(/^\/blocks\/height\/(\d+)$/);
            if (req.method === "GET" && m) {
                const row = await getBlockListRowByHeight(Number(m[1]));
                if (!row) return bfError(404, "Not Found", "No block at that height");
                return json(await bfBlock(row, await getMaxBlockNo(), Number(await getMaxSlot()), net));
            }
        }

        // GET /api/v0/blocks/{id}/previous?count= and /next?count=
        {
            const m = sub.match(/^\/blocks\/([^/]+)\/(previous|next)$/);
            if (req.method === "GET" && m) {
                const { row, error } = await resolveBlockRow(decodeURIComponent(m[1]));
                if (error) return error;
                if (!row) return bfError(404, "Not Found", "Block not found");
                const count = Math.max(1, Math.min(100, Number(url.searchParams.get("count") ?? 1) || 1));
                const tipSlot = Number(await getMaxSlot());
                const tipHeight = await getMaxBlockNo();
                let rows: BlockListRow[];
                if (m[2] === "previous") {
                    rows = await listBlocksDesc({ limit: count, beforeSlot: row.slot, beforeIsEbb: row.blockNo == null });
                } else {
                    rows = [];
                    let h = row.blockNo;
                    if (h == null) {
                        const main = await getBlockListRowBySlot(row.slot);
                        if (main && main.blockNo != null) {
                            rows.push(main);
                            h = main.blockNo;
                        }
                    }
                    while (h != null && rows.length < count) {
                        const n = await getBlockListRowByHeight(h + 1);
                        if (!n) break;
                        rows.push(n);
                        h = n.blockNo;
                    }
                }
                return json(await Promise.all(rows.map((r) => bfBlock(r, tipHeight, tipSlot, net))));
            }
        }

        // GET /api/v0/blocks/latest and /blocks/{slot|hash}
        {
            const m = sub === "/blocks/latest" ? ["", "latest"] : sub.match(/^\/blocks\/([^/]+)$/);
            if (req.method === "GET" && m) {
                const { row, error } = await resolveBlockRow(decodeURIComponent(m[1]!));
                if (error) return error;
                if (!row) return bfError(404, "Not Found", "Block not found (not yet synced?)");
                return json(await bfBlock(row, await getMaxBlockNo(), Number(await getMaxSlot()), net));
            }
        }

        // GET /api/v0/epochs/{n}, /epochs/{n}/blocks, /epochs/{n}/parameters, /epochs/{n}/next|previous
        {
            const m = sub.match(/^\/epochs\/(\d+)(?:\/(blocks|parameters|next|previous))?$/);
            if (req.method === "GET" && m) {
                const epoch = Number(m[1]);
                const tipSlot = Number(await getMaxSlot());
                const what = m[2];
                if (!what) return json(await bfEpoch(epoch, net, tipSlot));
                if (what === "parameters") {
                    const p = await getStoredEpochParams(epoch);
                    if (!p) return bfError(404, "Not Found", "No protocol parameters stored for that epoch");
                    return json({ epoch, ...p });
                }
                if (what === "blocks") {
                    const count = Math.max(1, Math.min(100, Number(url.searchParams.get("count") ?? 100) || 100));
                    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
                    const from = Number(firstSlotOfEpoch(epoch, net));
                    const to = from + Number(epochLengthSlots(epoch, net));
                    const rows = await listBlocksInSlotRange(from, to, count, (page - 1) * count);
                    return json(rows.map((r) => r.hash)); // BF shape: array of hashes
                }
                const count = Math.max(1, Math.min(20, Number(url.searchParams.get("count") ?? 1) || 1));
                const out: Array<Awaited<ReturnType<typeof bfEpoch>>> = [];
                for (let i = 1; i <= count; i++) {
                    const e = what === "next" ? epoch + i : epoch - i;
                    if (e < 0) break;
                    out.push(await bfEpoch(e, net, tipSlot));
                }
                return json(out);
            }
        }

        // GET /api/v0/search?q= — one box for the explorer; the server decides what the query is
        if (req.method === "GET" && sub === "/search") {
            const q = (url.searchParams.get("q") ?? "").trim();
            if (!q) return bfError(400, "Bad Request", "q required");
            if (/^[0-9a-f]{64}$/i.test(q)) {
                const hex = q.toLowerCase();
                if (await getTxByHash(hex)) return json({ kind: "tx", id: hex });
                if (await getBlockListRowByHash(hex)) return json({ kind: "block", id: hex });
                return json({ kind: "unknown", id: hex, message: "no block or transaction with that hash" });
            }
            if (/^\d+$/.test(q)) {
                const n = Number(q);
                const byHeight = await getBlockListRowByHeight(n);
                if (byHeight) return json({ kind: "block", id: byHeight.hash, height: n });
                const bySlot = await getBlockListRowBySlot(n);
                if (bySlot) return json({ kind: "block", id: bySlot.hash, slot: n });
                return json({ kind: "unknown", id: q, message: "no block at that height or slot" });
            }
            if (/^(addr|addr_test|Ae2|DdzFF)/.test(q)) return json({ kind: "address", id: q });
            if (/^(stake|stake_test)1/.test(q)) return json({ kind: "stake", id: q });
            if (/^pool1/.test(q)) return json({ kind: "pool", id: q });
            return json({ kind: "unknown", id: q });
        }

        // GET /api/v0/addresses/{address} — summary (UTxO set + address_tx count)
        {
            const m = sub.match(/^\/addresses\/([^/]+)$/);
            if (req.method === "GET" && m) {
                const address = decodeURIComponent(m[1]);
                if (!address || address.length < 10) {
                    return bfError(400, "Bad Request", "Invalid address");
                }
                const summary = await getAddressSummary(address);
                // BF returns 404 when address never seen; we treat empty UTxO + 0 txs as empty shelley addr
                if (summary.utxo_count === 0 && summary.tx_count === 0) {
                    return bfError(
                        404,
                        "Not Found",
                        "Address not found (no UTxOs and no address_tx rows)",
                    );
                }
                return json({
                    address: summary.address,
                    amount: summary.amount,
                    stake_address: summary.stake_address,
                    type: summary.type,
                    script: summary.script,
                    // extras (honest)
                    utxo_count: summary.utxo_count,
                    tx_count: summary.tx_count,
                    received_sum: null,
                    sent_sum: null,
                    note: "received/sent/stake_address null until full history index",
                });
            }
        }

        // GET /api/v0/addresses/{address}/utxos[/{asset}]
        {
            const m = sub.match(/^\/addresses\/([^/]+)\/utxos(?:\/([0-9a-fA-F]+))?$/);
            if (req.method === "GET" && m) {
                const address = decodeURIComponent(m[1]);
                const assetUnit = m[2]?.toLowerCase() ?? null;
                if (!address || address.length < 10) {
                    return bfError(400, "Bad Request", "Invalid address");
                }
                if (assetUnit != null && (assetUnit.length < 56 || assetUnit.length % 2 !== 0)) {
                    return bfError(400, "Bad Request", "Invalid asset unit");
                }
                const count = Math.min(
                    100,
                    Math.max(
                        1,
                        parseInt(url.searchParams.get("count") || "100", 10) ||
                            100,
                    ),
                );
                const page = Math.max(
                    1,
                    parseInt(url.searchParams.get("page") || "1", 10) || 1,
                );
                const all = await getUtxosByAddress(address);
                const parsed = all.map((u) => ({ u, output: parseStoredTxOut(u.tx_out) }));
                const filtered = assetUnit == null
                    ? parsed
                    : parsed.filter(({ output }) => storedTxOutContainsAsset(output, assetUnit));
                const slice = filtered.slice((page - 1) * count, page * count);
                const mapped = slice.map(({ u, output }) => {
                    const { tx_hash, output_index } = parseUtxoRef(u.utxo_ref);
                    return {
                        address: output.address || address,
                        tx_hash: tx_hash || u.tx_hash,
                        tx_index: output_index,
                        output_index,
                        amount: toBfAmount(output.amount, output.assets),
                        block: null as string | null,
                        data_hash: output.datumHash,
                        inline_datum: output.inlineDatumCbor,
                        reference_script_hash: output.scriptRefHash,
                    };
                });
                return json(mapped);
            }
        }

        // GET /api/v0/scripts/{hash}/cbor — current UTxO reference scripts
        {
            const m = sub.match(/^\/scripts\/([0-9a-fA-F]{56})\/cbor$/);
            if (req.method === "GET" && m) {
                const cbor = await getReferenceScriptCborByHash(m[1]);
                if (!cbor) {
                    return bfError(404, "Not Found", "Reference script not found in current UTxO set");
                }
                return json({ cbor });
            }
        }

        // GET /api/v0/txs/{hash}/utxos — prefer mb_* full IO; fall back to unspent set
        {
            const m = sub.match(/^\/txs\/([0-9a-fA-F]{64})\/utxos$/);
            if (req.method === "GET" && m) {
                const txHash = m[1].toLowerCase();
                const mbIo = await getMbTxUtxos(txHash);
                if (mbIo.inputs.length > 0 || mbIo.outputs.length > 0) {
                    return json({
                        hash: txHash,
                        inputs: mbIo.inputs.map((i) => ({
                            address: i.address,
                            amount: i.amount,
                            tx_hash: i.tx_hash,
                            output_index: i.output_index,
                            data_hash: null,
                            collateral: false,
                            reference_script_hash: null,
                        })),
                        outputs: mbIo.outputs.map((o) => ({
                            address: o.address,
                            amount: o.amount,
                            output_index: o.output_index,
                            data_hash: o.data_hash,
                            inline_datum: o.inline_datum,
                            collateral: o.collateral,
                            reference_script_hash: o.reference_script_hash,
                        })),
                        note: "Full IO from mb_tx_in/mb_tx_out (indexed)",
                    });
                }
                // Legacy fallback: unspent outputs still in live UTxO set
                const utxos = await getUtxosByTxHash(txHash);
                if (utxos.length === 0) {
                    return json({
                        hash: txHash,
                        inputs: [],
                        outputs: [],
                        note: "Not in mb_* and no unspent outs — run backfill or wait for forward index",
                    });
                }
                const outputs = utxos.map((u: any) => {
                    const ref = String(
                        Array.isArray(u) ? u[0] : u.utxo_ref ?? "",
                    );
                    const raw = Array.isArray(u)
                        ? (typeof u[1] === "string"
                            ? u[1]
                            : JSON.stringify(u[1] ?? {}))
                        : String(u.tx_out ?? "");
                    const { output_index } = parseUtxoRef(ref);
                    const parsed = parseStoredTxOut(raw);
                    return {
                        address: parsed.address,
                        amount: toBfAmount(parsed.amount, parsed.assets),
                        output_index,
                        data_hash: parsed.datumHash,
                        inline_datum: parsed.inlineDatumCbor,
                        collateral: false,
                        reference_script_hash: parsed.scriptRefHash,
                    };
                });
                return json({
                    hash: txHash,
                    inputs: [],
                    outputs,
                    note: "Only unspent outputs in local UTxO set (mb_* empty for this tx)",
                });
            }
        }

        // GET /api/v0/txs/{hash}/utxos/{index} — single output if unspent
        {
            const m = sub.match(
                /^\/txs\/([0-9a-fA-F]{64})\/utxos\/(\d+)$/,
            );
            if (req.method === "GET" && m) {
                const ref = `${m[1].toLowerCase()}:${m[2]}`;
                const utxo = await getUtxoByRef(ref);
                if (!utxo) {
                    return bfError(404, "Not Found", "UTxO not found");
                }
                const raw = Array.isArray(utxo)
                    ? (typeof utxo[1] === "string"
                        ? utxo[1]
                        : JSON.stringify(utxo[1] ?? {}))
                    : String((utxo as any).tx_out ?? "");
                const parsed = parseStoredTxOut(raw);
                const { tx_hash, output_index } = parseUtxoRef(ref);
                return json({
                    address: parsed.address,
                    tx_hash,
                    output_index,
                    amount: toBfAmount(parsed.amount, parsed.assets),
                });
            }
        }

        // GET /api/v0/txs/{hash} — P0 (needs tx_index; 404 until backfill)
        {
            const m = sub.match(/^\/txs\/([0-9a-fA-F]{64})$/);
            if (req.method === "GET" && m) {
                const txHash = m[1].toLowerCase();
                const row = await getTxByHash(txHash);
                if (!row) {
                    return bfError(
                        404,
                        "Not Found",
                        "Transaction not in mb_tx/tx_index (run backfill or wait for forward index)",
                    );
                }
                const blockRow = row.block_hash ? await getBlockListRowByHash(String(row.block_hash)) : null;
                let outputAmount: Array<{ unit: string; quantity: string }> | null = null;
                let utxoCount: number | null = null;
                try {
                    const io = await getMbTxUtxos(txHash);
                    utxoCount = io.inputs.length + io.outputs.length;
                    const totals = new Map<string, bigint>();
                    for (const o of io.outputs) {
                        if (o.collateral) continue;
                        for (const a of o.amount) totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.quantity));
                    }
                    outputAmount = [...totals].map(([unit, q]) => ({ unit, quantity: q.toString() }));
                } catch {
                    /* IO tables absent on a thin index */
                }
                return json({
                    hash: row.tx_hash,
                    block: row.block_hash,
                    block_height: blockRow?.blockNo ?? null,
                    block_time: blockRow ? slotToUnixTime(blockRow.slot, net) : null,
                    slot: row.slot,
                    index: (row as any).tx_index ?? null,
                    output_amount: outputAmount,
                    fees: row.fee,
                    deposit: null,
                    size: row.size,
                    invalid_before: row.invalid_before,
                    invalid_hereafter: row.invalid_hereafter,
                    utxo_count: utxoCount,
                    withdrawal_count: null,
                    mir_cert_count: null,
                    delegation_count: null,
                    stake_cert_count: null,
                    pool_update_count: null,
                    pool_retire_count: null,
                    asset_mint_or_burn_count: null,
                    redeemer_count: null,
                    valid_contract: null,
                    note: "Subset from mb_tx/tx_index — many BF fields null",
                });
            }
        }

        // GET /api/v0/addresses/{address}/transactions — P0
        {
            const m = sub.match(/^\/addresses\/([^/]+)\/transactions$/);
            if (req.method === "GET" && m) {
                const address = decodeURIComponent(m[1]);
                if (!address || address.length < 10) {
                    return bfError(400, "Bad Request", "Invalid address");
                }
                const count = Math.min(
                    100,
                    Math.max(
                        1,
                        parseInt(url.searchParams.get("count") || "20", 10) || 20,
                    ),
                );
                const page = Math.max(
                    1,
                    parseInt(url.searchParams.get("page") || "1", 10) || 1,
                );
                const rows = await getAddressTxs(address, { count, page });
                // BF shape: array of { tx_hash, tx_index, block_height, block_time }
                return json(
                    rows.map((r) => ({
                        tx_hash: r.tx_hash,
                        tx_index: 0,
                        block_height: null,
                        block_time: null,
                        slot: r.slot,
                        direction: r.direction,
                    })),
                );
            }
        }

        // GET /api/v0/blocks/{slot|hash}/txs — P1
        {
            const m = sub.match(/^\/blocks\/([^/]+)\/txs$/);
            if (req.method === "GET" && m) {
                let id = decodeURIComponent(m[1]);
                let row: any;
                if (id === "latest") id = (await getMaxSlot()).toString();
                if (/^\d+n?$/.test(id)) {
                    row = await getBlockBySlot(BigInt(id.replace("n", "")));
                } else if (/^[0-9a-f]{64}$/i.test(id)) {
                    row = await getBlockByHash(id.toLowerCase());
                } else {
                    return bfError(
                        400,
                        "Bad Request",
                        "Block id must be slot number or 64-hex hash",
                    );
                }
                if (!row) {
                    return bfError(404, "Not Found", "Block not found");
                }
                // extract block hash blob/hex for block_tx lookup (getter normalizes to hex)
                let blockHash: unknown = null;
                if (Array.isArray(row)) {
                    blockHash = row[3];
                } else {
                    blockHash = row.block_hash ?? row.hash ?? null;
                }
                if (blockHash == null) {
                    return json([]);
                }
                const txs = await getBlockTxHashes(
                    blockHash as string | Uint8Array,
                );
                // BF returns array of tx hash strings
                return json(txs.map((t) => t.tx_hash));
            }
        }

        // GET /api/v0/mempool/{hash} — is this tx still in the local mempool?
        {
            const m = sub.match(/^\/mempool\/([0-9a-fA-F]{64})$/);
            if (req.method === "GET" && m) {
                const want = m[1].toLowerCase();
                try {
                    const entries = await GlobalSharedMempool.getTxHashesAndSizes();
                    for (const e of entries) {
                        let hex = "";
                        try {
                            hex = mempoolTxHashToString(e.hash).toLowerCase();
                        } catch {
                            hex = "";
                        }
                        if (hex === want) return json({ tx_hash: want, in_mempool: true, size: e.size });
                    }
                    return bfError(404, "Not Found", "Transaction is not in the local mempool (relayed, applied, or never seen)");
                } catch (e: any) {
                    return bfError(503, "Service Unavailable", e?.message || "mempool unavailable");
                }
            }
        }

        // GET /api/v0/mempool — P1 Gerolamo extension (local SharedMempool)
        if (req.method === "GET" && (sub === "/mempool" || sub === "/mempool/txs")) {
            try {
                const entries = await GlobalSharedMempool.getTxHashesAndSizes();
                const mapped = entries.map((e) => {
                    let hashHex = "";
                    try {
                        hashHex = mempoolTxHashToString(e.hash);
                    } catch {
                        try {
                            hashHex = toHex(new Uint8Array(e.hash.buffer));
                        } catch {
                            hashHex = "";
                        }
                    }
                    return { tx_hash: hashHex, size: e.size };
                });
                return json({
                    count: mapped.length,
                    txs: mapped,
                    note: "Local SharedMempool snapshot — not full BF mempool shape",
                });
            } catch (e: any) {
                return bfError(
                    503,
                    "Service Unavailable",
                    e?.message || "mempool unavailable",
                );
            }
        }

        // POST /api/v0/tx/submit
        if (req.method === "POST" && sub === "/tx/submit") {
            if (!ctx.submitTx) {
                return bfError(
                    503,
                    "Service Unavailable",
                    "Tx submit not available (no peer manager)",
                );
            }
            const ct = (req.headers.get("content-type") || "").toLowerCase();
            let txCbor: Uint8Array;
            if (ct.includes("application/cbor") || ct.includes("octet-stream")) {
                txCbor = new Uint8Array(await req.arrayBuffer());
            } else {
                // BF often sends hex text
                const text = (await req.text()).trim();
                if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
                    txCbor = new Uint8Array(text.length / 2);
                    for (let i = 0; i < txCbor.length; i++) {
                        txCbor[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
                    }
                } else {
                    txCbor = new Uint8Array(Buffer.from(text, "utf8"));
                }
            }
            if (txCbor.length === 0) {
                return bfError(400, "Bad Request", "Empty transaction body");
            }
            // The tx id is the hash of the transaction *body*, not of the whole
            // envelope; decode first so an undecodable submission is a 400, not a
            // fire-and-forget "relayed".
            let txId: Uint8Array;
            try {
                const tx = Tx.fromCbor(txCbor);
                txId = tx.body.hash.toBuffer();
            } catch (e: any) {
                return bfError(400, "Bad Request", `Transaction CBOR could not be decoded: ${e?.message ?? String(e)}`);
            }
            let result: MiniBfSubmitResult;
            try {
                result = await ctx.submitTx(txCbor, txId);
            } catch (e: any) {
                return bfError(503, "Service Unavailable", e?.message ?? "submit failed");
            }
            if (result.status !== "success") {
                return bfError(400, "Bad Request", `Mempool rejected the transaction: ${result.status}`);
            }
            return json(
                {
                    hash: toHex(txId),
                    status: "accepted",
                    message: "Transaction is in the local mempool; hot peers pull it via TxSubmission",
                    mempool: { status: result.status, nTxs: result.nTxs, availableSpace: result.availableSpace },
                },
                202,
            );
        }

        return bfError(
            404,
            "Not Found",
            `Unknown mini-Blockfrost path: ${sub}`,
        );
    } catch (e: any) {
        logger.error("mini-blockfrost error:", e?.message || e);
        return bfError(
            500,
            "Internal Server Error",
            e?.message || "mini-blockfrost failure",
        );
    }
}

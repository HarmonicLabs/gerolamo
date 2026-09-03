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
} from "../db";
import { ensureLiveProtocolParams } from "./liveProtocolParams";
import {
    parseStoredTxOut,
    storedTxOutContainsAsset,
} from "../db/minibf/txOutMetadata";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
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

function blockRowToBf(row: any, tipSlot?: bigint) {
    if (!row) return null;
    // dual-shape: object or array from .values()
    let slot: bigint | number | string | null = null;
    let blockHash: unknown = null;
    if (Array.isArray(row)) {
        // getBlockBy* SELECT order: id, chunk_id, slot, block_hash, ...
        slot = row[2];
        blockHash = row[3];
    } else {
        slot = row.slot ?? row.Slot ?? null;
        blockHash = row.block_hash ?? row.hash ?? null;
    }
    const slotNum = slot == null ? 0 : Number(slot);
    const epoch = Number(calculatePreProdCardanoEpoch(slotNum));
    const hashHex = rowHashToHex(blockHash);
    return {
        time: 0, // no wall-clock in DB yet
        height: null as number | null,
        hash: hashHex,
        slot: slotNum,
        epoch,
        epoch_slot: null as number | null,
        slot_leader: null as string | null,
        size: null as number | null,
        tx_count: null as number | null,
        output: null as string | null,
        fees: null as string | null,
        block_vrf: null as string | null,
        op_cert: null as string | null,
        op_cert_counter: null as string | null,
        previous_block: null as string | null,
        next_block: null as string | null,
        confirmations: tipSlot != null
            ? Math.max(0, Number(tipSlot) - slotNum)
            : null,
    };
}

export type MiniBfSubmitTx = (txCbor: Uint8Array) => void | Promise<void>;

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
                    "GET /api/v0/blocks/latest",
                    "GET /api/v0/blocks/{slot|hash}",
                    "GET /api/v0/blocks/{slot|hash}/txs",
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
        if (req.method === "GET" && sub === "/blocks/latest") {
            const tipSlot = await getMaxSlot();
            if (tipSlot === 0n) {
                return bfError(404, "Not Found", "No blocks in local DB");
            }
            const row = await getBlockBySlot(tipSlot);
            const body = blockRowToBf(row, tipSlot);
            if (!body?.hash) {
                return bfError(404, "Not Found", "Tip block not found");
            }
            return json(body);
        }

        // GET /api/v0/blocks/{slot|hash}
        {
            const m = sub.match(/^\/blocks\/([^/]+)$/);
            if (req.method === "GET" && m) {
                const id = decodeURIComponent(m[1]);
                const tipSlot = await getMaxSlot();
                let row: any;
                if (/^\d+n?$/.test(id)) {
                    const slot = BigInt(id.replace("n", ""));
                    row = await getBlockBySlot(slot);
                } else if (/^[0-9a-f]{64}$/i.test(id)) {
                    row = await getBlockByHash(id.toLowerCase());
                } else {
                    return bfError(
                        400,
                        "Bad Request",
                        "Block id must be slot number or 64-hex hash",
                    );
                }
                const body = blockRowToBf(row, tipSlot);
                if (!body?.hash) {
                    return bfError(404, "Not Found", "Block not found");
                }
                return json(body);
            }
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
                return json({
                    hash: row.tx_hash,
                    block: row.block_hash,
                    block_height: null,
                    block_time: null,
                    slot: row.slot,
                    index: null,
                    output_amount: null,
                    fees: row.fee,
                    deposit: null,
                    size: row.size,
                    invalid_before: row.invalid_before,
                    invalid_hereafter: row.invalid_hereafter,
                    utxo_count: null,
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
                const id = decodeURIComponent(m[1]);
                let row: any;
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
            // Best-effort body hash (not always equal to ledger tx id for multi-era wrappers)
            const txHashHex = toHex(blake2b_256(txCbor));
            await ctx.submitTx(txCbor);
            return json(
                {
                    hash: txHashHex,
                    status: "relayed",
                    message: "Transaction relayed to hot peers",
                    note: "hash is blake2b_256(raw body); may differ from ledger tx id for some encodings",
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

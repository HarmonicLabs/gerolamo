/**
 * Mini-Blockfrost core — Blockfrost-compatible subset for dApps/wallets.
 *
 * Mounted at /api/v0/* on the peer block HTTP server.
 * Not full Blockfrost; honest subset:
 *   GET /api/v0/
 *   GET /api/v0/health
 *   GET /api/v0/epochs/latest
 *   GET /api/v0/epochs/latest/parameters
 *   GET /api/v0/blocks/latest
 *   GET /api/v0/blocks/{slot|hash}
 *   GET /api/v0/addresses/{address}/utxos
 *   GET /api/v0/txs/{hash}/utxos
 *   POST /api/v0/tx/submit  (raw CBOR body)
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
    getLatestProtocolParams,
} from "../db";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../utils/logger";

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "X-Gerolamo-Api": "mini-blockfrost",
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

function parseTxOut(raw: string): {
    address: string;
    amount: string;
    assets: Record<string, Record<string, string>>;
} {
    try {
        const j = typeof raw === "string" ? JSON.parse(raw) : raw;
        return {
            address: String(j?.address ?? ""),
            amount: String(j?.amount ?? "0"),
            assets: (j?.assets && typeof j.assets === "object")
                ? j.assets
                : {},
        };
    } catch {
        return { address: "", amount: "0", assets: {} };
    }
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

    const sub = path === "/api/v0" || path === "/api/v0/"
        ? "/"
        : path.slice("/api/v0".length) || "/";

    try {
        // GET /api/v0/
        if (req.method === "GET" && (sub === "/" || sub === "")) {
            return json({
                url: "/api/v0",
                version: "0.1.0",
                node: "gerolamo",
                network: ctx.network ?? process.env.NETWORK ?? "unknown",
                endpoints: [
                    "GET /api/v0/health",
                    "GET /api/v0/epochs/latest",
                    "GET /api/v0/epochs/latest/parameters",
                    "GET /api/v0/blocks/latest",
                    "GET /api/v0/blocks/{slot|hash}",
                    "GET /api/v0/addresses/{address}/utxos",
                    "GET /api/v0/txs/{hash}/utxos",
                    "POST /api/v0/tx/submit",
                ],
                note: "Mini-Blockfrost core — subset, not full Blockfrost parity",
            });
        }

        // GET /api/v0/health
        if (req.method === "GET" && sub === "/health") {
            return json({ is_healthy: true });
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
            const params = await getLatestProtocolParams();
            if (params == null) {
                // Honest empty: we may not have populated protocol_params yet
                return json({
                    epoch: null,
                    min_fee_a: null,
                    min_fee_b: null,
                    note: "protocol_params not populated in local DB",
                });
            }
            // If already BF-shaped, pass through; else wrap
            if (typeof params === "object" && params !== null) {
                return json(params);
            }
            return json({ params });
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

        // GET /api/v0/addresses/{address}/utxos
        {
            const m = sub.match(/^\/addresses\/([^/]+)\/utxos$/);
            if (req.method === "GET" && m) {
                const address = decodeURIComponent(m[1]);
                if (!address || address.length < 10) {
                    return bfError(400, "Bad Request", "Invalid address");
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
                const slice = all.slice((page - 1) * count, page * count);
                const mapped = slice.map((u) => {
                    const { tx_hash, output_index } = parseUtxoRef(u.utxo_ref);
                    const parsed = parseTxOut(u.tx_out);
                    return {
                        address: parsed.address || address,
                        tx_hash: tx_hash || u.tx_hash,
                        tx_index: output_index,
                        output_index,
                        amount: toBfAmount(parsed.amount, parsed.assets),
                        block: null as string | null,
                        data_hash: null as string | null,
                        inline_datum: null as string | null,
                        reference_script_hash: null as string | null,
                    };
                });
                return json(mapped);
            }
        }

        // GET /api/v0/txs/{hash}/utxos  (unspent outputs still in set for this tx)
        {
            const m = sub.match(/^\/txs\/([0-9a-fA-F]{64})\/utxos$/);
            if (req.method === "GET" && m) {
                const txHash = m[1].toLowerCase();
                const utxos = await getUtxosByTxHash(txHash);
                if (utxos.length === 0) {
                    // BF returns inputs+outputs for full tx; we only have unspent set
                    return json({
                        hash: txHash,
                        inputs: [],
                        outputs: [],
                        note: "Only unspent outputs in local UTxO set (not full tx IO)",
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
                    const parsed = parseTxOut(raw);
                    return {
                        address: parsed.address,
                        amount: toBfAmount(parsed.amount, parsed.assets),
                        output_index,
                        data_hash: null,
                        inline_datum: null,
                        collateral: false,
                        reference_script_hash: null,
                    };
                });
                return json({
                    hash: txHash,
                    inputs: [],
                    outputs,
                    note: "Only unspent outputs in local UTxO set (not full tx IO)",
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
                const parsed = parseTxOut(raw);
                const { tx_hash, output_index } = parseUtxoRef(ref);
                return json({
                    address: parsed.address,
                    tx_hash,
                    output_index,
                    amount: toBfAmount(parsed.amount, parsed.assets),
                });
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
            await ctx.submitTx(txCbor);
            // BF returns tx hash on success; we don't compute hash yet — 202 + note
            return json(
                {
                    status: "relayed",
                    message: "Transaction relayed to hot peers",
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

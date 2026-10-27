/**
 * Mini-Blockfrost: Blockfrost-compatible HTTP API (OpenAPI 0.1.92 paths and response shapes)
 * mounted at /api/v0/* on the node's HTTP server. Routes live in src/api/blockfrost/routes:
 *   core        /, /health, /health/clock, /genesis, /network, /network/eras, /epochs/*, /blocks/*
 *   txs         /txs/*, /tx/submit, /mempool/*, /utils/txs/evaluate(/utxos)
 *   addresses   /addresses/*, /accounts/*
 *   assets      /assets/*, /metadata/txs/labels/*, /scripts/*
 *   pools       /pools/*
 *   governance  /governance/*
 *   extensions  Gerolamo additions (/blocks list, /blocks/height/{n}, /search, /gerolamo/status)
 * Current state comes from the LMDB ledger store; history from the explorer projection
 * (mb_* tables, src/db/minibf). Errors use Blockfrost's `{status_code, error, message}` bodies.
 * docs/parity/blockfrost.md has the endpoint coverage matrix.
 */
import { settings } from "../config/settings";
import { getMaxBlockNo, getMaxSlot, getBlockListRowByHash } from "../db";
import { normalizeEpochNetwork } from "../utils/epochFromSlotCalculations";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../utils/logger";
import { GlobalSharedMempool } from "../network/SharedMempool";
import { mempoolTxHashToString } from "@harmoniclabs/shared-cardano-mempool-ts";
import { bfError, CORS_HEADERS, HttpError, json, MSG } from "./blockfrost/http";
import { Router, type Ctx, type MiniBfSubmitResult, type MiniBfSubmitTx } from "./blockfrost/router";
import { bfBlock } from "./blockfrost/chain";
import { coreRoutes } from "./blockfrost/routes/core";
import { txRoutes } from "./blockfrost/routes/txs";
import { addressRoutes } from "./blockfrost/routes/addresses";
import { assetRoutes } from "./blockfrost/routes/assets";
import { poolRoutes } from "./blockfrost/routes/pools";
import { governanceRoutes } from "./blockfrost/routes/governance";
import { extensionRoutes } from "./blockfrost/routes/extensions";

export type { MiniBfSubmitResult, MiniBfSubmitTx };

export interface MiniBfContext {
    network?: string;
    submitTx?: MiniBfSubmitTx;
}

export const blockfrostRouter = new Router().add(...coreRoutes, ...txRoutes, ...addressRoutes, ...assetRoutes, ...poolRoutes, ...governanceRoutes, ...extensionRoutes);

/** Blockfrost `/blocks/{id}` document for one stored block, or null when the hash is unknown. Used by the WS `block` topic. */
export async function bfBlockByHash(hashHex: string, network: string | undefined): Promise<Record<string, unknown> | null> {
    const row = await getBlockListRowByHash(hashHex.toLowerCase());
    if (!row) return null;
    const [tipHeight, tipSlot] = await Promise.all([getMaxBlockNo(), getMaxSlot()]);
    return bfBlock(row, normalizeEpochNetwork(network ?? settings().network), { height: tipHeight, slot: Number(tipSlot) });
}

/** Local SharedMempool snapshot (Gerolamo extension shape, also the WS `mempool` payload). */
export async function mempoolSnapshot(): Promise<{ count: number; txs: Array<{ tx_hash: string; size: number }>; note: string }> {
    const entries = await GlobalSharedMempool.getTxHashesAndSizes();
    const txs = entries.map((e) => {
        let hashHex = "";
        try { hashHex = mempoolTxHashToString(e.hash); } catch { try { hashHex = toHex(new Uint8Array(e.hash.buffer)); } catch { hashHex = ""; } }
        return { tx_hash: hashHex, size: e.size };
    });
    return { count: txs.length, txs, note: "Local SharedMempool snapshot — not full BF mempool shape" };
}

/**
 * Handle a request already known to be under /api/v0 (or /api/v0/...).
 * Returns null if path is not a mini-BF route (caller continues).
 */
export async function handleMiniBlockfrost(req: Request, url: URL, ctx: MiniBfContext = {}): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/v0" && !path.startsWith("/api/v0/")) return null;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "X-Gerolamo-Api": "mini-blockfrost" } });
    const sub = (path.slice("/api/v0".length) || "/").replace(/\/+$/, "") || "/";
    const network = String(ctx.network ?? settings().network).toLowerCase();
    const m = blockfrostRouter.match(req.method === "HEAD" ? "GET" : req.method, sub);
    if (!m) return sub === "/governor" ? null : bfError(404, "Not Found", MSG.notFound); // the peer server answers /api/v0/governor
    if ("methodNotAllowed" in m) return new Response(JSON.stringify({ status_code: 405, error: "Method Not Allowed", message: `Use ${m.methodNotAllowed.join(", ")}` }), { status: 405, headers: { "Content-Type": "application/json", Allow: m.methodNotAllowed.join(", "), ...CORS_HEADERS } });
    const c: Ctx = { req, url, params: m.params, network, net: normalizeEpochNetwork(network), submitTx: ctx.submitTx };
    try {
        const out = await m.route.handler(c);
        return out instanceof Response ? out : json(out);
    } catch (e: any) {
        if (e instanceof HttpError) return bfError(e.status, e.error, e.message);
        logger.error(`mini-blockfrost ${req.method} ${sub}: ${e?.stack ?? e?.message ?? e}`);
        return bfError(500, "Internal Server Error", MSG.internal);
    }
}

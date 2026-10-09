/**
 * Path-template router for the Blockfrost-compatible API (`/blocks/{hash_or_number}/txs` style).
 * Literal segments win over parameters, so `/blocks/latest` and `/blocks/slot/{n}` are matched
 * before `/blocks/{hash_or_number}`. Handlers return plain data (sent as JSON 200) or a Response.
 */
import type { EpochNetwork } from "../../utils/epochFromSlotCalculations";

export interface MiniBfSubmitResult { status: string; nTxs: number; availableSpace: number }
export type MiniBfSubmitTx = (txCbor: Uint8Array, txId: Uint8Array) => Promise<MiniBfSubmitResult>;

export interface Ctx {
    req: Request;
    url: URL;
    params: Record<string, string>;
    /** Network name as configured ("preview", "preprod", "mainnet", …). */
    network: string;
    net: EpochNetwork;
    submitTx?: MiniBfSubmitTx;
}
export type Handler = (c: Ctx) => Promise<unknown>;
export interface Route { method: "GET" | "POST"; path: string; segs: string[]; handler: Handler }

export function route(method: "GET" | "POST", path: string, handler: Handler): Route {
    return { method, path, segs: path.split("/").filter(Boolean), handler };
}

export class Router {
    private readonly routes: Route[] = [];
    add(...rs: Route[]): this { this.routes.push(...rs); return this; }
    list(): Route[] { return [...this.routes]; }

    match(method: string, path: string): { route: Route; params: Record<string, string> } | { methodNotAllowed: string[] } | null {
        const segs = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
        let best: { route: Route; params: Record<string, string>; score: number } | null = null;
        const allowed = new Set<string>();
        for (const r of this.routes) {
            if (r.segs.length !== segs.length) continue;
            const params: Record<string, string> = {};
            let score = 0, ok = true;
            for (let i = 0; i < segs.length; i++) {
                const t = r.segs[i]!;
                if (t.startsWith("{")) params[t.slice(1, -1)] = segs[i]!;
                else if (t === segs[i]) score += 1 << (segs.length - i);
                else { ok = false; break; }
            }
            if (!ok) continue;
            if (r.method !== method) { allowed.add(r.method); continue; }
            if (!best || score > best.score) best = { route: r, params, score };
        }
        if (best) return { route: best.route, params: best.params };
        return allowed.size ? { methodNotAllowed: [...allowed] } : null;
    }
}

/**
 * HTTP plumbing of the Blockfrost-compatible API: JSON bodies (bigint written as a JSON number),
 * Blockfrost error bodies `{status_code, error, message}` with blockfrost-backend-ryo's messages,
 * and the count / page / order query parameters with the same limits and 400 texts.
 */

export const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, project_id, X-Requested-With",
    "Access-Control-Max-Age": "86400",
};

/** JSON text where bigint values are written as numbers (metadata and datums carry 64-bit and larger integers). */
export function toJson(v: unknown): string {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `\u0000BIG${x.toString()}\u0000` : x)).replace(/"\\u0000BIG(-?\d+)\\u0000"/g, "$1");
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(toJson(data), {
        status,
        headers: { "Content-Type": "application/json", "X-Gerolamo-Api": "mini-blockfrost", ...CORS_HEADERS, ...headers },
    });
}

export function bfError(status: number, error: string, message: string): Response {
    return json({ status_code: status, error, message }, status);
}

export const MSG = {
    notFound: "The requested component has not been found.",
    address: "Invalid address for this network or malformed address format.",
    asset: "Invalid or malformed asset format.",
    policy: "Invalid or malformed policy format.",
    stake: "Invalid or malformed stake address format.",
    pool: "Invalid or malformed pool id format.",
    epoch: "Missing, out of range or malformed epoch_number.",
    blockNumber: "Missing, out of range or malformed block number.",
    blockHash: "Missing or malformed block hash.",
    slot: "Missing, out of range or malformed slot_number.",
    label: "Missing, out of range or malformed label.",
    drep: "Invalid or malformed drep id.",
    govAction: "Invalid or malformed gov action id.",
    fromTo: "Invalid (malformed or out of range) from/to parameter(s).",
    internal: "An unexpected response was received from the backend.",
};

export class HttpError extends Error {
    constructor(readonly status: number, readonly error: string, message: string) { super(message); }
}
export const notFound = (message = MSG.notFound): HttpError => new HttpError(404, "Not Found", message);
export const badRequest = (message: string): HttpError => new HttpError(400, "Bad Request", message);

export interface Paging { count: number; page: number; order: "asc" | "desc"; offset: number }

const MAX_PAGE = 21474836;

/** Parse count / page / order like Blockfrost (fastify + ajv): integers, 1 ≤ count ≤ 100, 1 ≤ page ≤ 21474836, order asc|desc. */
export function paging(url: URL, opts: { order?: boolean; defaultCount?: number } = {}): Paging {
    const int = (name: string, def: number, min: number, max: number): number => {
        const raw = url.searchParams.get(name);
        if (raw == null || raw === "") return def;
        if (!/^-?\d+$/.test(raw.trim())) throw badRequest(`querystring/${name} must be integer`);
        const n = Number(raw);
        if (n < min) throw badRequest(`querystring/${name} must be >= ${min}`);
        if (n > max) throw badRequest(`querystring/${name} must be <= ${max}`);
        return n;
    };
    const count = int("count", opts.defaultCount ?? 100, 1, 100);
    const page = int("page", 1, 1, MAX_PAGE);
    let order: "asc" | "desc" = "asc";
    if (opts.order !== false) {
        const o = url.searchParams.get("order");
        if (o != null && o !== "") {
            if (o !== "asc" && o !== "desc") throw badRequest("querystring/order must be equal to one of the allowed values");
            order = o;
        }
    }
    return { count, page, order, offset: (page - 1) * count };
}

/** Page of an in-memory list (already in ascending order). */
export function pageOf<T>(all: T[], p: Paging): T[] {
    const list = p.order === "desc" ? [...all].reverse() : all;
    return list.slice(p.offset, p.offset + p.count);
}

/** `from` / `to` of the transaction lists: "<height>" or "<height>:<index>", both inclusive. */
export interface BlockRange { fromHeight: number | null; fromIndex: number | null; toHeight: number | null; toIndex: number | null }
export function fromTo(url: URL): BlockRange {
    const one = (name: string): [number | null, number | null] => {
        const v = url.searchParams.get(name);
        if (v == null || v === "") return [null, null];
        const m = /^(\d+)(?::(\d+))?$/.exec(v);
        if (!m) throw badRequest(MSG.fromTo);
        const h = Number(m[1]), i = m[2] != null ? Number(m[2]) : null;
        if (h > 2147483647 || (i != null && i > 2147483647)) throw badRequest(MSG.fromTo);
        return [h, i];
    };
    const [fromHeight, fromIndex] = one("from");
    const [toHeight, toIndex] = one("to");
    if (fromHeight != null && toHeight != null && (fromHeight > toHeight || (fromHeight === toHeight && fromIndex != null && toIndex != null && fromIndex > toIndex))) throw badRequest(MSG.fromTo);
    return { fromHeight, fromIndex, toHeight, toIndex };
}

/** Non-negative 31-bit integer path segment (epochs, heights, slots), else 400 with `message`. */
export function intParam(v: string, message: string): number {
    if (!/^\d+$/.test(v)) throw badRequest(message);
    const n = Number(v);
    if (n > 2147483647) throw badRequest(message);
    return n;
}

export const isHex64 = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s);
export const isHex56 = (s: string): boolean => /^[0-9a-fA-F]{56}$/.test(s);

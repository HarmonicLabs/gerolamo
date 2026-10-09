/**
 * Serve a Gerolamo artifact store over HTTP with the aggregator's cardano-database v2 routes, so
 * `mithril-bootstrap --aggregator http://<node>/mithril` (and other aggregator clients) can
 * restore from a Gerolamo node:
 *
 *   GET  {prefix}/                                       aggregator features
 *   GET  {prefix}/artifact/cardano-database              certified snapshots, newest first (max 20)
 *   GET  {prefix}/artifact/cardano-database/epoch/{e}    the same, for one epoch
 *   GET  {prefix}/artifact/cardano-database/digests      digests list of the newest snapshot
 *   GET  {prefix}/artifact/cardano-database/{hash}       snapshot detail with download locations
 *   GET  {prefix}/certificates                           stored certificates, newest first (max 20)
 *   GET  {prefix}/certificate/{hash}                     one certificate, exactly as Mithril published it
 *   GET  {prefix}/cardano-database-download/immutable/NNNNN.tar.zst
 *   GET  {prefix}/cardano-database-download/digests/<file>.tar.zst
 *   POST {prefix}/statistics/...                         accepted and ignored
 *
 * Certificates are self-verifying (the client walks them to the genesis key), so serving them
 * from the node's store is safe; so are the archives (the client checks every file against the
 * certified digests).
 */

import { decompress } from "fzstd";

import { parseJsonLossless } from "../verify/json";
import { ArtifactStore, DOWNLOAD_DIR, type StoredSnapshot } from "./store";
import { readTar } from "./tar";

export const MITHRIL_API_VERSION = "0.1.71";
const LIST_MAX_ITEMS = 20;

export type MithrilArtifactServerOptions = {
    store: ArtifactStore;
    /** URL prefix the routes live under (default "/mithril"). */
    prefix?: string;
    /** Absolute base URL clients should download from (default: derived from the request). */
    publicBaseUrl?: string;
    /** Also list snapshots no Mithril certificate signs (default false: a client could not verify them). */
    listUncertified?: boolean;
};

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "mithril-api-version": MITHRIL_API_VERSION } });

function listItem(s: StoredSnapshot) {
    return {
        hash: s.hash,
        merkle_root: s.merkle_root,
        beacon: s.beacon,
        certificate_hash: s.certificate_hash,
        total_db_size_uncompressed: s.total_db_size_uncompressed,
        cardano_node_version: s.cardano_node_version,
        created_at: s.created_at,
    };
}

/** CardanoDatabaseSnapshotMessage with locations under `base` (the prefix URL). */
export function snapshotMessage(s: StoredSnapshot, base: string) {
    return {
        hash: s.hash,
        merkle_root: s.merkle_root,
        network: s.network,
        beacon: s.beacon,
        certificate_hash: s.certificate_hash,
        total_db_size_uncompressed: s.total_db_size_uncompressed,
        digests: {
            size_uncompressed: s.digests.size_uncompressed,
            locations: [
                { type: "cloud_storage", uri: `${base}/${DOWNLOAD_DIR}/digests/${s.digests.file}`, compression_algorithm: "zstandard" },
                { type: "aggregator", uri: `${base}/artifact/cardano-database/digests` },
            ],
        },
        immutables: {
            average_size_uncompressed: s.immutables.average_size_uncompressed,
            locations: [{ type: "cloud_storage", uri: { Template: `${base}/${DOWNLOAD_DIR}/immutable/{immutable_file_number}.tar.zst` }, compression_algorithm: "zstandard" }],
        },
        ancillary: { size_uncompressed: s.ancillary.size_uncompressed, locations: [] },
        cardano_node_version: s.cardano_node_version,
        created_at: s.created_at,
    };
}

export function createMithrilArtifactHandler(opts: MithrilArtifactServerOptions): (req: Request, url: URL) => Promise<Response | null> {
    const prefix = (opts.prefix ?? "/mithril").replace(/\/$/, "");
    const store = opts.store;
    const listed = async (): Promise<StoredSnapshot[]> => (await store.listSnapshots()).filter((s) => opts.listUncertified || s.certificate_hash);
    const baseOf = (url: URL): string => (opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/$/, "") : `${url.protocol}//${url.host}${prefix}`);

    return async (req: Request, url: URL): Promise<Response | null> => {
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
        const path = url.pathname.slice(prefix.length).replace(/\/$/, "") || "/";

        if (req.method === "POST" && path.startsWith("/statistics/")) return new Response(null, { status: 201 });
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });

        if (path === "/") {
            return json({ open_api_version: MITHRIL_API_VERSION, documentation_url: "https://mithril.network/doc", capabilities: { signed_entity_types: ["CardanoDatabase"], aggregate_signature_type: "Concatenation" } });
        }
        if (path === "/artifact/cardano-database") {
            return json((await listed()).slice(0, LIST_MAX_ITEMS).map(listItem));
        }
        let m = /^\/artifact\/cardano-database\/epoch\/(\d+)$/.exec(path);
        if (m) {
            const e = Number(m[1]);
            return json((await listed()).filter((s) => s.beacon.epoch === e).slice(0, LIST_MAX_ITEMS).map(listItem));
        }
        if (path === "/artifact/cardano-database/digests") {
            const newest = (await listed())[0];
            if (!newest) return json([]);
            const f = Bun.file(store.digestsArchive(newest.digests.file));
            if (!(await f.exists())) return new Response(null, { status: 404 });
            const entry = readTar(decompress(await f.bytes())).find((e) => e.name.endsWith(".json"));
            return new Response(entry ? new TextDecoder().decode(entry.data) : "[]", { headers: { "Content-Type": "application/json", "mithril-api-version": MITHRIL_API_VERSION } });
        }
        m = /^\/artifact\/cardano-database\/([0-9a-f]{64})$/.exec(path);
        if (m) {
            const s = await store.readSnapshot(m[1]!);
            if (!s || (!s.certificate_hash && !opts.listUncertified)) return new Response(null, { status: 404 });
            return json(snapshotMessage(s, baseOf(url)));
        }
        if (path === "/certificates") {
            const certs = await store.listCertificates();
            certs.sort((a, b) => Number(b.epoch) - Number(a.epoch) || String(b.metadata && (b.metadata as Record<string, unknown>).sealed_at).localeCompare(String(a.metadata && (a.metadata as Record<string, unknown>).sealed_at)));
            const body = certs.slice(0, LIST_MAX_ITEMS);
            return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(v.toString()) : v)), { headers: { "Content-Type": "application/json", "mithril-api-version": MITHRIL_API_VERSION } });
        }
        m = /^\/certificate\/([0-9a-f]{64})$/.exec(path);
        if (m) {
            const text = await store.readCertificateText(m[1]!);
            if (text == null) return new Response(null, { status: 404 });
            parseJsonLossless(text); // refuse to serve a corrupt file
            return new Response(text, { headers: { "Content-Type": "application/json", "mithril-api-version": MITHRIL_API_VERSION } });
        }
        m = new RegExp(`^/${DOWNLOAD_DIR}/(immutable/\\d{5,}\\.tar\\.zst|digests/[A-Za-z0-9._-]+\\.tar\\.zst)$`).exec(path);
        if (m) {
            const [kind, name] = m[1]!.split("/") as [string, string];
            const file = Bun.file(kind === "immutable" ? store.immutableArchive(Number(name.slice(0, -8))) : store.digestsArchive(name));
            if (!(await file.exists())) return new Response(null, { status: 404 });
            return new Response(req.method === "HEAD" ? null : file, { headers: { "Content-Type": "application/zstd", "Content-Length": String(file.size) } });
        }
        return new Response(null, { status: 404 });
    };
}

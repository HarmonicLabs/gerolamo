/**
 * A Mithril-certified starting point for the browser node (docs/PLAN_BROWSER_NODE.md):
 *   1. the aggregator's newest cardano-database snapshot (JSON, CORS-enabled);
 *   2. its certificate chain verified in the browser with the same pure-TS verifier the node
 *      uses (`src/mithril/dualRun.ts` → `pureTs/*`, hashing via `@noble/hashes`), back to the
 *      genesis certificate signed with the network's published genesis key;
 *   3. the certificate's signed message must bind the snapshot's merkle root;
 *   4. the digests list (aggregator JSON) must produce that merkle root (`mkTree`);
 *   5. the last certified immutable chunk is fetched from the relay over the WebSocket (light
 *      query GetChunk) and its three files must hash to the certified digests;
 *   6. that chunk's last block (slot, header hash) is the certified point the client intersects at.
 * The relay cannot forge any of this: it only supplies bytes that must match Mithril's digests.
 */
import { sha256 } from "@noble/hashes/sha2";
import { pureTsFullChainStagesOk, pureTsVerifyCertificateChain } from "../../../src/mithril/dualRun";
import { fetchGenesisVkey, networkConfig } from "../../../src/mithril/client";
import { createAggregatorCertificateFetcher, verifyCardanoDatabaseMessageMatch } from "../../../src/mithril/pureTs/chain";
import { verifyCardanoDatabaseMerkleRootFromDigests } from "../../../src/mithril/pureTs/mkTree";
import { SECONDARY_ENTRY_SIZE, decodePrimary, decodeSecondaryEntry, filledRelativeSlots } from "../../../src/storage/chunkFormat";
import type { LightQueryClient } from "./lightQuery";

export interface MithrilAnchor {
    network: string;
    snapshotHash: string;
    certificateHash: string;
    epoch: number;
    immutableFileNumber: number;
    merkleRoot: string;
    chunkNo: number;
    slot: number;
    hash: string;
    blocksInChunk: number;
    certificatesWalked: string;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function mithrilAnchor(opts: { network: "preview" | "preprod" | "mainnet"; lq: LightQueryClient; log?: (l: string) => void; aggregator?: string }): Promise<MithrilAnchor> {
    const log = opts.log ?? (() => {});
    const cfg = networkConfig(opts.network);
    const agg = (opts.aggregator ?? cfg.aggregator).replace(/\/$/, "");
    const getJson = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} → ${r.status}`); return r.json(); };

    log(`Mithril: listing snapshots at ${agg}`);
    const list = (await getJson(`${agg}/artifact/cardano-database`)) as Array<{ hash: string }>;
    if (!Array.isArray(list) || !list.length) throw new Error("no snapshots listed");
    const detail = await getJson(`${agg}/artifact/cardano-database/${list[0]!.hash}`) as { hash: string; merkle_root: string; certificate_hash: string; beacon: { epoch: number; immutable_file_number: number }; network: string };
    log(`Mithril: snapshot ${detail.hash.slice(0, 16)}… epoch ${detail.beacon.epoch}, immutable file ${detail.beacon.immutable_file_number}`);

    const genesisVkey = await fetchGenesisVkey(cfg.genesisVkeyUrl);
    const cache = certCache(opts.network);
    const fetcher = cache.wrap(createAggregatorCertificateFetcher(agg));
    const cert = await fetcher(detail.certificate_hash);
    if (!cert) throw new Error("certificate not found");
    log(`Mithril: verifying the certificate chain from ${detail.certificate_hash.slice(0, 16)}… (this walks to genesis)`);
    const res = await pureTsVerifyCertificateChain(detail.certificate_hash, cert as any, { fetcher: fetcher as any, genesisVkey });
    if (!pureTsFullChainStagesOk(res) || !(res as any).chainOk) throw new Error(`certificate chain rejected: ${(res as any).reason ?? "unknown"}`);
    log(`Mithril: certificate chain OK (${(res as any).reason ?? ""}; ${cache.hits} of ${cache.hits + cache.misses} certificates from the browser cache)`);
    await cache.persist();

    const mm = verifyCardanoDatabaseMessageMatch(cert as any, detail.merkle_root);
    if (!mm.ok) throw new Error(`certificate does not bind the snapshot's merkle root: ${mm.reason ?? ""}`);

    const digests = (await getJson(`${agg}/artifact/cardano-database/digests`)) as Array<{ immutable_file_name: string; digest: string }>;
    const mk = verifyCardanoDatabaseMerkleRootFromDigests(digests as any, detail.beacon.immutable_file_number, detail.merkle_root);
    if (!mk.ok) throw new Error(`digests do not produce the certified merkle root (${mk.computedRoot ?? "?"} ≠ ${detail.merkle_root})`);
    log(`Mithril: ${digests.length} file digests match the certified merkle root`);

    // The beacon file is the last complete immutable file the certificate covers.
    const n = detail.beacon.immutable_file_number;
    const name = n.toString().padStart(5, "0");
    const want = new Map(digests.filter((d) => d.immutable_file_name.startsWith(name + ".")).map((d) => [d.immutable_file_name, d.digest.toLowerCase()]));
    if (want.size !== 3) throw new Error(`digests for ${name}.* not in the certified list`);
    log(`Mithril: fetching chunk ${n} from the relay over the WebSocket`);
    const files = await opts.lq.chunk(n);
    if (!files) throw new Error(`relay does not have complete chunk ${n} (ask it later, or pick a relay further along)`);
    for (const [ext, bytes] of [["chunk", files.chunk], ["primary", files.primary], ["secondary", files.secondary]] as const) {
        const got = hex(sha256(bytes));
        if (got !== want.get(`${name}.${ext}`)) throw new Error(`${name}.${ext} from the relay does not match its certified digest`);
    }
    const offsets = decodePrimary(files.primary);
    const filled = filledRelativeSlots(offsets);
    const entries = files.secondary.length / SECONDARY_ENTRY_SIZE;
    if (!entries || filled.length !== entries) throw new Error(`chunk ${n}: index inconsistent`);
    const last = decodeSecondaryEntry(files.secondary, entries - 1, filled[entries - 1] === 0);
    log(`Mithril: certified point = slot ${last.slotOrEbb} hash ${hex(last.headerHash).slice(0, 16)}… (last block of chunk ${n})`);
    return { network: detail.network, snapshotHash: detail.hash, certificateHash: detail.certificate_hash, epoch: detail.beacon.epoch, immutableFileNumber: n, merkleRoot: detail.merkle_root, chunkNo: n, slot: last.slotOrEbb, hash: hex(last.headerHash), blocksInChunk: entries, certificatesWalked: String((res as any).reason ?? "") };
}

/**
 * Mithril certificates kept in OPFS (`gerolamo/mithril-certs/<network>/<hash>.json`), so a restart
 * does not download the whole chain back to genesis again. Every certificate is still verified on
 * every walk; the cache only saves the downloads, and a certificate is stored only after the chain it
 * came in verified, so a bad download is never kept.
 */
function certCache(network: string) {
    type Fetch = ReturnType<typeof createAggregatorCertificateFetcher>;
    const fresh = new Map<string, unknown>();
    let dir: Promise<FileSystemDirectoryHandle | null> | null = null;
    const root = () => dir ??= (async () => {
        try {
            if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
            let d = await navigator.storage.getDirectory();
            for (const part of ["gerolamo", "mithril-certs", network]) d = await d.getDirectoryHandle(part, { create: true });
            return d;
        } catch { return null; }
    })();
    const self = {
        hits: 0, misses: 0,
        wrap(inner: Fetch): Fetch {
            return (async (hash: string) => {
                const d = await root();
                if (d) {
                    try { const f = await (await d.getFileHandle(`${hash}.json`)).getFile(); const c = JSON.parse(await f.text()); self.hits++; return c; } catch { /* not cached */ }
                }
                self.misses++;
                const c = await inner(hash);
                if (c) fresh.set(hash, c);
                return c;
            }) as Fetch;
        },
        async persist(): Promise<void> {
            const d = await root();
            if (!d) return;
            const { OpfsSink } = await import("./opfsSink");
            const sink = new OpfsSink(`gerolamo/mithril-certs/${network}`);
            for (const [hash, c] of fresh) { try { await sink.write(`${hash}.json`, new TextEncoder().encode(JSON.stringify(c))); } catch { /* cache only */ } }
            fresh.clear();
        },
    };
    return self;
}

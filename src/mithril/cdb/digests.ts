/**
 * Cardano database v2 digests and Merkle root, as mithril-common computes them.
 *
 * - Every immutable file (`NNNNN.chunk`, `.primary`, `.secondary`) gets a digest:
 *   hex(SHA-256(file bytes)) (`ImmutableFile::compute_raw_hash::<Sha256>`).
 * - The signed Merkle root is the MKTree (Merkle mountain range, Blake2s-256) over the digests of
 *   every file numbered 0..=beacon, in file order, each leaf being the UTF-8 bytes of the hex
 *   digest (`CardanoImmutableDigester::compute_merkle_tree`).
 * - The certified message is the certificate's protocol message with `cardano_database_merkle_root`
 *   set to that root; its hash must equal the certificate's `signed_message`.
 * - The snapshot id is hex(SHA-256(epoch u64 BE || merkle_root hex)) (`CardanoDatabaseSnapshot::compute_hash`).
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { MkTreeMmr } from "../pureTs/mkTree";
import { protocolMessageHash, type Certificate } from "../verify/certificate";

export type DigestEntry = { immutable_file_name: string; digest: string };

const IMMUTABLE_FILE = /^(\d{5,})\.(chunk|primary|secondary)$/;
const EXT_ORDER = { chunk: 0, primary: 1, secondary: 2 } as const;

export type ImmutableFileInfo = { number: number; name: string; path: string; size: number; mtimeMs: number };

/** Immutable files of a directory, ordered by number then name (mithril `ImmutableFile` order). */
export function listImmutableFiles(immutableDir: string): ImmutableFileInfo[] {
    const out: ImmutableFileInfo[] = [];
    for (const name of readdirSync(immutableDir)) {
        const m = IMMUTABLE_FILE.exec(name);
        if (!m) continue;
        const path = join(immutableDir, name);
        const st = statSync(path);
        if (!st.isFile()) continue;
        out.push({ number: Number(m[1]), name, path, size: st.size, mtimeMs: st.mtimeMs });
    }
    out.sort((a, b) => a.number - b.number || EXT_ORDER[a.name.split(".")[1] as keyof typeof EXT_ORDER] - EXT_ORDER[b.name.split(".")[1] as keyof typeof EXT_ORDER]);
    return out;
}

/**
 * The newest immutable file number whose trio is complete: every number below the highest one on
 * disk (the highest chunk is still being written by the node), when 0..n all have their three files.
 */
export function lastCompletedImmutable(files: ImmutableFileInfo[]): number | null {
    if (files.length === 0) return null;
    const max = files[files.length - 1]!.number;
    const counts = new Map<number, number>();
    for (const f of files) counts.set(f.number, (counts.get(f.number) ?? 0) + 1);
    let n = -1;
    while (n + 1 < max && counts.get(n + 1) === 3) n++;
    return n >= 0 ? n : null;
}

/** File-name keyed digest cache, invalidated by size or mtime change (immutable files never change). */
export class DigestCache {
    private entries = new Map<string, { size: number; mtimeMs: number; digest: string }>();
    private dirty = false;
    constructor(readonly path: string | null) {}

    static async load(path: string | null): Promise<DigestCache> {
        const c = new DigestCache(path);
        if (path) {
            try {
                const doc = (await Bun.file(path).json()) as Record<string, { size: number; mtimeMs: number; digest: string }>;
                for (const [k, v] of Object.entries(doc)) c.entries.set(k, v);
            } catch {
                /* absent or unreadable: start empty */
            }
        }
        return c;
    }
    get(f: ImmutableFileInfo): string | null {
        const e = this.entries.get(f.name);
        return e && e.size === f.size && e.mtimeMs === f.mtimeMs ? e.digest : null;
    }
    set(f: ImmutableFileInfo, digest: string): void {
        this.entries.set(f.name, { size: f.size, mtimeMs: f.mtimeMs, digest });
        this.dirty = true;
    }
    async save(): Promise<void> {
        if (!this.path || !this.dirty) return;
        const tmp = `${this.path}.tmp`;
        await Bun.write(tmp, JSON.stringify(Object.fromEntries(this.entries)));
        const { rename } = await import("node:fs/promises");
        await rename(tmp, this.path);
        this.dirty = false;
    }
}

export async function sha256File(path: string): Promise<string> {
    return createHash("sha256").update(await Bun.file(path).bytes()).digest("hex");
}

/**
 * Digests of every immutable file numbered `from..=to` (all three files of each number must
 * exist). Files are read only.
 */
export async function computeImmutableDigests(
    immutableDir: string,
    range: { from: number; to: number },
    opts: { cache?: DigestCache; onProgress?: (done: number, total: number) => void; files?: ImmutableFileInfo[] } = {},
): Promise<DigestEntry[]> {
    const files = (opts.files ?? listImmutableFiles(immutableDir)).filter((f) => f.number >= range.from && f.number <= range.to);
    const expected = (range.to - range.from + 1) * 3;
    if (files.length !== expected) {
        const have = new Set(files.map((f) => f.name));
        const missing: string[] = [];
        for (let n = range.from; n <= range.to && missing.length < 5; n++) {
            for (const ext of ["chunk", "primary", "secondary"]) {
                const name = `${String(n).padStart(5, "0")}.${ext}`;
                if (!have.has(name)) missing.push(name);
            }
        }
        throw new Error(`immutable files ${range.from}..${range.to}: ${files.length} of ${expected} present (missing e.g. ${missing.join(", ")})`);
    }
    const out: DigestEntry[] = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        let d = opts.cache?.get(f) ?? null;
        if (d == null) {
            d = await sha256File(f.path);
            opts.cache?.set(f, d);
        }
        out.push({ immutable_file_name: f.name, digest: d });
        if (opts.onProgress && (i % 3000 === 0 || i === files.length - 1)) opts.onProgress(i + 1, files.length);
    }
    return out;
}

/** MKTree root (hex) over the digests, in the order given. */
export function cardanoDbMerkleRoot(digests: readonly DigestEntry[]): string {
    if (digests.length === 0) throw new Error("no digests");
    const mmr = new MkTreeMmr();
    const enc = new TextEncoder();
    for (const d of digests) {
        if (!/^[0-9a-f]{64}$/.test(d.digest)) throw new Error(`bad digest for ${d.immutable_file_name}`);
        mmr.push(enc.encode(d.digest));
    }
    return mmr.getRootHex();
}

/**
 * Digests from a published digests list, keeping files numbered <= beacon, ordered by file name
 * (mithril-client `download_and_verify_digests`).
 */
export function filterDigestsForBeacon(list: readonly DigestEntry[], beacon: number): DigestEntry[] {
    const byName = new Map<string, string>();
    for (const d of list) {
        const m = IMMUTABLE_FILE.exec(d.immutable_file_name);
        if (!m || Number(m[1]) > beacon) continue;
        byName.set(d.immutable_file_name, String(d.digest).toLowerCase());
    }
    return [...byName.keys()].sort().map((name) => ({ immutable_file_name: name, digest: byName.get(name)! }));
}

/** True when `merkleRoot` is what the certificate signed (`Certificate::match_message`). */
export function certificateSignsCardanoDbRoot(cert: Certificate, merkleRoot: string): boolean {
    if (cert.signature.kind !== "multi" || cert.signature.signedEntityType.type !== "CardanoDatabase") return false;
    const pm = new Map(cert.protocolMessage);
    pm.set("cardano_database_merkle_root", merkleRoot);
    return protocolMessageHash(pm) === cert.signedMessage;
}

/** CardanoDatabaseSnapshot::compute_hash. */
export function cardanoDbSnapshotHash(epoch: number | bigint, merkleRoot: string): string {
    const e = Buffer.alloc(8);
    e.writeBigUInt64BE(BigInt(epoch));
    return createHash("sha256").update(e).update(merkleRoot).digest("hex");
}

/** `{network}-e{epoch}-i{immutable}.digests` (aggregator digests file name, without extension). */
export function digestsFileStem(network: string, epoch: number | bigint, immutable: number): string {
    return `${network}-e${epoch}-i${immutable}.digests`;
}

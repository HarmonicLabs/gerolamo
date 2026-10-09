/**
 * Client side of a cardano-database v2 restore, as mithril-client does it
 * (`InternalArtifactProver::download_and_verify_digests` and `verify_cardano_database`):
 *
 * 1. Download the snapshot's digests list, keep the files numbered <= the certified beacon,
 *    build the MKTree root and check that the (already chain-verified) certificate signed it.
 * 2. Hash the downloaded immutable files and compare each one with its certified digest.
 *
 * Gerolamo is stricter on one point: every immutable file found in the download directory is
 * checked, not only the requested range, because the whole directory may become the node's
 * block store. A file the digests do not cover is reported as non-verifiable.
 */

import { decompress } from "fzstd";

import type { Certificate } from "../verify/certificate";
import type { MithrilCdbSnapshot, MithrilLocation } from "../types";
import { cardanoDbMerkleRoot, certificateSignsCardanoDbRoot, filterDigestsForBeacon, listImmutableFiles, sha256File, type DigestEntry } from "./digests";
import { readTar } from "./tar";

export type VerifiedDigests = { digests: Map<string, string>; merkleRoot: string; beacon: number; source: string };

function parseDigestList(doc: unknown): DigestEntry[] {
    if (!Array.isArray(doc)) throw new Error("digests: not a list");
    return doc.map((d, i) => {
        if (!d || typeof d.immutable_file_name !== "string" || typeof d.digest !== "string") throw new Error(`digests[${i}]: bad entry`);
        return { immutable_file_name: d.immutable_file_name, digest: d.digest };
    });
}

async function fetchDigestList(loc: MithrilLocation, fetchImpl: typeof fetch): Promise<DigestEntry[]> {
    const uri = typeof loc.uri === "string" ? loc.uri : (loc.uri?.Template ?? loc.uri?.template);
    if (typeof uri !== "string") throw new Error("digests location without uri");
    const res = await fetchImpl(uri);
    if (!res.ok) throw new Error(`GET ${uri}: HTTP ${res.status}`);
    if (loc.type === "aggregator") return parseDigestList(await res.json());
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tar = loc.compression_algorithm === "zstandard" || uri.endsWith(".zst") ? decompress(bytes) : bytes;
    const json = readTar(tar).find((e) => e.name.endsWith(".json"));
    if (!json) throw new Error(`${uri}: no .json digests file in the archive`);
    return parseDigestList(JSON.parse(new TextDecoder().decode(json.data)));
}

/** Step 1: digests whose Merkle root the certificate signed. Throws when none of the locations gives one. */
export async function fetchVerifiedDigests(snapshot: MithrilCdbSnapshot, certificate: Certificate, opts: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<VerifiedDigests> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const set = certificate.signature.kind === "multi" ? certificate.signature.signedEntityType : null;
    if (!set || set.type !== "CardanoDatabase") throw new Error(`certificate ${certificate.hash} does not sign a cardano database snapshot`);
    const beacon = Number(set.immutableFileNumber);
    if (snapshot.beacon?.immutable_file_number !== beacon) throw new Error(`snapshot beacon ${snapshot.beacon?.immutable_file_number} differs from the certified beacon ${beacon}`);
    const errors: string[] = [];
    for (const loc of snapshot.digests?.locations ?? []) {
        try {
            const list = filterDigestsForBeacon(await fetchDigestList(loc, fetchImpl), beacon);
            const merkleRoot = cardanoDbMerkleRoot(list);
            if (!certificateSignsCardanoDbRoot(certificate, merkleRoot)) {
                throw new Error(`digests root ${merkleRoot} is not signed by certificate ${certificate.hash}`);
            }
            opts.log?.(`digests verified: ${list.length} files, merkle root ${merkleRoot} signed by ${certificate.hash}`);
            return { digests: new Map(list.map((d) => [d.immutable_file_name, d.digest])), merkleRoot, beacon, source: loc.type };
        } catch (e) {
            errors.push(`${loc.type}: ${(e as Error).message}`);
        }
    }
    throw new Error(`no certified digests list: ${errors.join("; ") || "snapshot lists no digests location"}`);
}

export type ImmutableVerification = { checked: number; missing: string[]; tampered: string[]; nonVerifiable: string[] };

/**
 * Step 2: every immutable file of the directory against the certified digests; range [from, to]
 * must be complete. `extraDigests` covers files verified another way (the ancillary archive's last
 * immutable trio, checked against its signed manifest).
 */
export async function verifyImmutableFiles(immutableDir: string, range: { from: number; to: number }, verified: VerifiedDigests, extraDigests: Map<string, string> = new Map()): Promise<ImmutableVerification> {
    const files = listImmutableFiles(immutableDir);
    const present = new Set(files.map((f) => f.name));
    const missing: string[] = [];
    for (let n = range.from; n <= range.to; n++) {
        for (const ext of ["chunk", "primary", "secondary"]) {
            const name = `${String(n).padStart(5, "0")}.${ext}`;
            if (!present.has(name)) missing.push(name);
        }
    }
    const tampered: string[] = [];
    const nonVerifiable: string[] = [];
    for (const f of files) {
        const want = verified.digests.get(f.name) ?? extraDigests.get(f.name);
        if (want === undefined) {
            nonVerifiable.push(f.name);
            continue;
        }
        if ((await sha256File(f.path)) !== want) tampered.push(f.name);
    }
    return { checked: files.length, missing, tampered, nonVerifiable };
}

export function describeVerification(v: ImmutableVerification): string | null {
    const parts: string[] = [];
    if (v.missing.length) parts.push(`${v.missing.length} missing (${v.missing.slice(0, 5).join(", ")})`);
    if (v.tampered.length) parts.push(`${v.tampered.length} tampered (${v.tampered.slice(0, 5).join(", ")})`);
    if (v.nonVerifiable.length) parts.push(`${v.nonVerifiable.length} not covered by the certified digests (${v.nonVerifiable.slice(0, 5).join(", ")})`);
    return parts.length ? parts.join("; ") : null;
}

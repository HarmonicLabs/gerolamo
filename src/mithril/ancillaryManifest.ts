/**
 * Verification of a Mithril ancillary archive (`ancillary_manifest.json`): the ledger state files
 * and the last immutable file are not covered by the STM multi-signature; the aggregator signs
 * their SHA-256 manifest with an Ed25519 key published per network (`ancillary.vkey`, same
 * hex-of-JSON-byte-array format as the genesis key).
 *
 * Mirrors mithril-client `AncillaryVerifier`: every listed file's SHA-256 must equal the manifest
 * entry, and the signature must verify over `compute_hash` = SHA-256 of the concatenation, in
 * path order (BTreeMap), of each path's bytes followed by its hex hash's bytes.
 */
import { verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { decodeGenesisVkey } from "./pureTs/chain";

export interface AncillaryManifest { data: Record<string, string>; signature: string | null }

/** Published ancillary verification keys (mithril-infra/configuration/<network>/ancillary.vkey, 2026-09). */
export const ANCILLARY_VKEYS: Record<string, string> = {
    mainnet: "5b32332c37312c39362c3133332c34372c3235332c3232362c3133362c3233352c35372c3136342c3130362c3138362c322c32312c32392c3132302c3136332c38392c3132312c3137372c3133382c3230382c3133382c3231342c39392c35382c32322c302c35382c332c36395d",
    preprod: "5b3138392c3139322c3231362c3135302c3131342c3231362c3233372c3231302c34352c31382c32312c3139362c3230382c3234362c3134362c322c3235322c3234332c3235312c3139372c32382c3135372c3230342c3134352c33302c31342c3232382c3136382c3132392c38332c3133362c33365d",
    preview: "5b3138392c3139322c3231362c3135302c3131342c3231362c3233372c3231302c34352c31382c32312c3139362c3230382c3234362c3134362c322c3235322c3234332c3235312c3139372c32382c3135372c3230342c3134352c33302c31342c3232382c3136382c3132392c38332c3133362c33365d",
};

export function parseAncillaryManifest(json: string): AncillaryManifest {
    const o = JSON.parse(json);
    if (!o || typeof o !== "object" || !o.data || typeof o.data !== "object") throw new Error("ancillary manifest: no data map");
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.data)) { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error(`ancillary manifest: bad hash for ${k}`); data[k] = v; }
    return { data, signature: typeof o.signature === "string" ? o.signature : null };
}

/** mithril `AncillaryFilesManifest::compute_hash`: paths in byte order (Rust BTreeMap of PathBuf). */
export function manifestHash(m: AncillaryManifest): Uint8Array {
    const h = new Bun.CryptoHasher("sha256");
    for (const k of Object.keys(m.data).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) { h.update(Buffer.from(k, "utf8")); h.update(Buffer.from(m.data[k]!, "utf8")); }
    return new Uint8Array(h.digest());
}

export function verifyManifestSignature(m: AncillaryManifest, vkeyRaw: string): boolean {
    if (!m.signature || !/^[0-9a-f]{128}$/i.test(m.signature)) return false;
    // plain Uint8Array: the verifier rejects Node Buffers
    return verifyEd25519Signature_sync(new Uint8Array(Buffer.from(m.signature, "hex")), manifestHash(m), decodeGenesisVkey(vkeyRaw));
}

export async function sha256File(path: string): Promise<string> {
    const h = new Bun.CryptoHasher("sha256");
    const stream = Bun.file(path).stream();
    for await (const chunk of stream) h.update(chunk);
    return h.digest("hex");
}

export interface AncillaryVerification { ok: boolean; files: number; signatureOk: boolean; errors: string[] }

/** Verify every listed file under `baseDir` and the manifest signature against the network key. */
export async function verifyAncillary(baseDir: string, vkeyRaw: string, log?: (m: string) => void): Promise<AncillaryVerification> {
    const path = `${baseDir}/ancillary_manifest.json`;
    const errors: string[] = [];
    const file = Bun.file(path);
    if (!(await file.exists())) return { ok: false, files: 0, signatureOk: false, errors: [`no ${path}`] };
    const m = parseAncillaryManifest(await file.text());
    let files = 0;
    for (const [rel, expected] of Object.entries(m.data)) {
        const p = `${baseDir}/${rel}`;
        if (!(await Bun.file(p).exists())) { errors.push(`missing ${rel}`); continue; }
        const actual = await sha256File(p);
        if (actual !== expected) errors.push(`${rel}: sha256 ${actual} ≠ manifest ${expected}`);
        files++;
    }
    const signatureOk = verifyManifestSignature(m, vkeyRaw);
    if (!signatureOk) errors.push("manifest signature does not verify against the ancillary verification key");
    log?.(`ancillary: ${files} file(s) hashed, signature ${signatureOk ? "OK" : "FAILED"}${errors.length ? `, ${errors.length} error(s)` : ""}`);
    return { ok: errors.length === 0, files, signatureOk, errors };
}

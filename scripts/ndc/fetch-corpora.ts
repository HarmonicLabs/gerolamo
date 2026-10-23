#!/usr/bin/env bun
/**
 * Fetch everything the node-diversity-conformance harnesses read, into one directory:
 *
 *   bun scripts/ndc/fetch-corpora.ts --dir <corpora dir>
 *
 *   <dir>/ndc                        pragma-org/node-diversity-conformance (schemas, ledger-rules fixtures, build.py)
 *   <dir>/cbor-dataset               etorreborre/cardano-cbor-dataset, branch etorreborre/feat/normalization (corpus conway-123-100)
 *   <dir>/turbo.tar.zst              pragma's uplc-turbo corpus (the scenario README's link), sha256 checked
 *   <dir>/uplc-turbo/<epoch>/*.flat  the archive unpacked: 3 997 scripts
 *   <dir>/uplc-conformance.tar.zst   pragma's uplc-conformance corpus, sha256 checked
 *   <dir>/uplc-conformance/          the archive unpacked: protocol-version-N/vM/… vectors and cost-models/
 *   <dir>/corpora.json               what is there, with the digests and commits (report-all.ts --corpora reads it)
 *
 * Everything downloaded is data: nothing from these directories is executed. Re-running updates the clones and skips
 * an archive whose digest already matches and whose unpacked directory is recorded. Needs git, curl and tar on PATH;
 * the .zst archives are decompressed in-process (Bun.zstdDecompressSync), so no zstd binary is needed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = flag("dir"); if (!dir) { console.error("usage: fetch-corpora.ts --dir <dir> [--ndc-rev <commit or branch>]"); process.exit(2); }
mkdirSync(dir, { recursive: true });
/** The site revision the harnesses, schemas and expectations are pinned to (`--ndc-rev main` for the newest). */
const NDC_REV = flag("ndc-rev", "8974561cb6b48807e2a578028d4f5d85430007a6")!;

/** The pinned corpora (the scenario READMEs' links); a new corpus means a new digest here and new floors in the tests. */
export const ARCHIVES = {
    "uplc-turbo": { url: "https://pub-2239d82d9a074482b2eb2c886191cb4e.r2.dev/turbo.tar.zst", file: "turbo.tar.zst", sha256: "821af55e3323c826b5598c964d634b46dd468014834d0e97ebdc5edb0a158576", count: (d: string) => countFiles(d, ".flat"), what: "scripts" },
    "uplc-conformance": { url: "https://pub-2239d82d9a074482b2eb2c886191cb4e.r2.dev/uplc-conformance.tar.zst", file: "uplc-conformance.tar.zst", sha256: "8bd4ad4f9f4c8c6b8ffa1f06ed1db0b43043afbba77ef6a14bcfb5a52345ed3f", count: (d: string) => countFiles(d, ".uplc"), what: "vectors" },
} as const;

function run(cmd: string[], cwd = dir!): void {
    console.log(`$ ${cmd.join(" ")}`);
    const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) { console.error(`failed: ${cmd[0]} (exit ${p.exitCode})`); process.exit(1); }
}
/** Clone (or update) `url` at `ref` — a branch, or a commit hash (fetched directly) — and return the commit. */
function cloneOrUpdate(name: string, url: string, ref: string): string {
    const d = join(dir!, name);
    const isCommit = /^[0-9a-f]{40}$/.test(ref);
    if (!existsSync(join(d, ".git"))) {
        if (isCommit) { run(["git", "init", "-q", d]); run(["git", "remote", "add", "origin", url], d); }
        else run(["git", "clone", "--depth", "1", "--branch", ref, url, d]);
    }
    if (isCommit || existsSync(join(d, ".git"))) { run(["git", "fetch", "--depth", "1", "origin", ref], d); run(["git", "checkout", "-q", "FETCH_HEAD"], d); }
    const p = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: d, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : "unknown";
}
function countFiles(d: string, suffix: string): number {
    let n = 0;
    const walk = (p: string) => { for (const e of readdirSync(p)) { const q = join(p, e); if (statSync(q).isDirectory()) walk(q); else if (e.endsWith(suffix)) n++; } };
    walk(d);
    return n;
}
const digestOf = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

const manifestPath = join(dir, "corpora.json");
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const manifest: Record<string, unknown> = { fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") };

// 1. the site repository: schemas, ledger-rules fixtures, expectations, build.py — pinned
manifest.ndc = { dir: "ndc", repository: "https://github.com/pragma-org/node-diversity-conformance", ref: NDC_REV, commit: cloneOrUpdate("ndc", "https://github.com/pragma-org/node-diversity-conformance", NDC_REV) };
// 2. the CBOR corpus
manifest.cbor_dataset = { dir: "cbor-dataset", repository: "https://github.com/etorreborre/cardano-cbor-dataset", branch: "etorreborre/feat/normalization", corpus: "dataset/conway-123-100", commit: cloneOrUpdate("cbor-dataset", "https://github.com/etorreborre/cardano-cbor-dataset", "etorreborre/feat/normalization") };
// 3. the two UPLC archives: download (digest checked), unpack into a fresh directory
for (const [name, a] of Object.entries(ARCHIVES)) {
    const tarball = join(dir, a.file), dest = join(dir, name);
    if (!existsSync(tarball) || digestOf(tarball) !== a.sha256) {
        run(["curl", "-L", "--fail", "--retry", "3", "-o", tarball, a.url]);
        const got = digestOf(tarball);
        if (got !== a.sha256) { console.error(`${a.file}: sha256 ${got} != ${a.sha256} (pinned in scripts/ndc/fetch-corpora.ts)`); process.exit(1); }
    }
    console.log(`${a.file}: sha256 ${a.sha256} ok`);
    const recorded = previous[name.replace("-", "_")]?.sha256;
    if (!existsSync(dest) || recorded !== a.sha256) {
        console.log(`unpacking ${a.file} → ${dest}`);
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        const tar = join(dir, `.${a.file}.tar`);
        writeFileSync(tar, Bun.zstdDecompressSync(readFileSync(tarball)));
        run(["tar", "-xf", tar, "-C", dest]);
        rmSync(tar, { force: true });
    }
    const n = a.count(dest);
    console.log(`${name}: ${n} ${a.what} under ${dest}`);
    manifest[name.replace("-", "_")] = { url: a.url, archive: a.file, sha256: a.sha256, dir: name, [a.what]: n };
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\ncorpora ready in ${dir} (${manifestPath}); next:\n  bun scripts/ndc/report-all.ts --corpora ${dir} --out ~/ndc-reports --allow-dirty`);

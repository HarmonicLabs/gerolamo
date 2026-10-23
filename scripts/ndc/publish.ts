#!/usr/bin/env bun
/**
 * Publish the node-diversity-conformance reports as assets of a GitHub release of HarmonicLabs/gerolamo,
 * which pragma's site build downloads (nodes/gerolamo/metadata.json: `github_releases` + `gerolamo-*-<scenario>.json`).
 *
 *   bun scripts/ndc/publish.ts --dir <report dir from report-all.ts> --tag <vX.Y.Z-conformance-YYYYMMDD> [--repo HarmonicLabs/gerolamo] [--yes]
 *
 * Without --yes it only prints what it would do. It refuses when the manifest's commit is dirty, when the tag's
 * commit is not HEAD, or when HEAD is not pushed. This is an outward action: run it only when the operator says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = flag("dir"), tag = flag("tag"), repo = flag("repo", "HarmonicLabs/gerolamo")!, yes = argv.includes("--yes");
if (!dir || !tag) { console.error("usage: publish.ts --dir <dir> --tag <tag> [--repo owner/name] [--yes]"); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { implementation: { version: string; commit: string }; date: string; reports: Record<string, { file: string; sha256: string; totals: unknown }> };
const run = (cmd: string[]) => { const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };

const problems: string[] = [];
if (manifest.implementation.commit.endsWith("-dirty")) problems.push(`reports were produced from a dirty tree (${manifest.implementation.commit})`);
const head = run(["git", "rev-parse", "--short", "HEAD"]).out;
if (head !== manifest.implementation.commit.replace(/-dirty$/, "")) problems.push(`reports name commit ${manifest.implementation.commit} but HEAD is ${head}`);
const upstream = run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
if (upstream.code !== 0) problems.push("HEAD has no upstream branch (push it first)");
else { const ahead = run(["git", "rev-list", "--count", `${upstream.out}..HEAD`]).out; if (ahead !== "0") problems.push(`HEAD is ${ahead} commit(s) ahead of ${upstream.out} (push first)`); }
const files = Object.values(manifest.reports).map((r) => join(dir, r.file));
for (const f of files) if (!existsSync(f)) problems.push(`missing ${f}`);

const notes = [
    `Conformance reports for pragma-org/node-diversity-conformance, produced at commit ${manifest.implementation.commit} on ${manifest.date}.`,
    "",
    ...Object.entries(manifest.reports).map(([s, r]) => `- ${s}: \`${r.file}\` (sha256 ${r.sha256.slice(0, 16)}…) totals ${JSON.stringify(r.totals)}`),
    "",
    "Harnesses: scripts/ndc/. Details: docs/parity/ndc-*.md.",
].join("\n");

console.log(`release ${tag} on ${repo} with ${files.length} asset(s):\n  ${files.join("\n  ")}\n\nnotes:\n${notes}\n`);
if (problems.length) { console.error(`refusing:\n  ${problems.join("\n  ")}`); process.exit(1); }
if (!yes) { console.log("dry run: pass --yes to create the release"); process.exit(0); }
const r = Bun.spawnSync(["gh", "release", "create", tag, ...files, "--repo", repo, "--title", `Conformance reports ${manifest.date}`, "--notes", notes, "--prerelease"], { stdout: "inherit", stderr: "inherit" });
process.exit(r.exitCode);

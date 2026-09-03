import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

/** Version + git identity of the running node, for logs and /metrics. Computed once. */
export interface BuildInfo {
    version: string;
    commit: string | null;
    dirty: boolean;
    /** `version+commit[-dirty]` */
    label: string;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
    if (cached) return cached;
    const root = resolve(import.meta.dir, "..", "..");
    let version = "0.0.0";
    try {
        version = String(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version ?? version);
    } catch {
        /* keep default */
    }
    const git = (args: string[]): string | null => {
        try {
            const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 2000 });
            return r.status === 0 ? r.stdout.trim() : null;
        } catch {
            return null;
        }
    };
    const commit = git(["rev-parse", "--short", "HEAD"]);
    const dirty = commit != null && (git(["status", "--porcelain", "--untracked-files=no"]) ?? "").length > 0;
    cached = { version, commit, dirty, label: `${version}${commit ? `+${commit}${dirty ? "-dirty" : ""}` : ""}` };
    return cached;
}

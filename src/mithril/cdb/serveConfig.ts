/**
 * Node config for serving Mithril artifacts (off by default):
 *
 *   "mithril": { "serveArtifacts": true, "artifactsDir": "/path/to/store", "publicBaseUrl": "https://node.example/mithril" }
 *
 * Env: GEROLAMO_MITHRIL_ARTIFACTS=<dir> turns it on with that store; GEROLAMO_MITHRIL_ARTIFACTS=0 turns it off.
 */

import { resolve } from "node:path";

export type MithrilServeConfigInput = {
    serveArtifacts?: boolean;
    artifactsDir?: string;
    publicBaseUrl?: string;
    listUncertified?: boolean;
};

export type MithrilServeConfig = { artifactsDir: string; publicBaseUrl?: string; listUncertified: boolean };

export function resolveMithrilServeConfig(cfg: MithrilServeConfigInput | undefined, env: Record<string, string | undefined> = process.env): MithrilServeConfig | null {
    const e = env.GEROLAMO_MITHRIL_ARTIFACTS?.trim();
    if (e === "0" || e === "false") return null;
    if (e) return { artifactsDir: resolve(e), publicBaseUrl: cfg?.publicBaseUrl, listUncertified: !!cfg?.listUncertified };
    if (!cfg?.serveArtifacts) return null;
    if (!cfg.artifactsDir) throw new Error("mithril.serveArtifacts needs mithril.artifactsDir");
    return { artifactsDir: resolve(cfg.artifactsDir), publicBaseUrl: cfg.publicBaseUrl, listUncertified: !!cfg.listUncertified };
}

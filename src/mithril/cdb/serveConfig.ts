/**
 * Node config for serving Mithril artifacts (off by default):
 *
 *   "mithril": { "serveArtifacts": true, "artifactsDir": "/path/to/store", "publicBaseUrl": "https://node.example/mithril" }
 *
 * Env: --mithril-artifacts <dir> turns it on with that store; --mithril-artifacts 0 turns it off.
 */

import { settings } from "../../config/settings";
import { resolve } from "node:path";

export type MithrilServeConfigInput = {
    serveArtifacts?: boolean;
    artifactsDir?: string;
    publicBaseUrl?: string;
    listUncertified?: boolean;
};

export type MithrilServeConfig = { artifactsDir: string; publicBaseUrl?: string; listUncertified: boolean };

/** config `mithril.*`, or the --mithril-artifacts flag (a directory, or off). */
export function resolveMithrilServeConfig(cfg: MithrilServeConfigInput | undefined, override: string | null = settings().mithrilArtifacts): MithrilServeConfig | null {
    const e = override?.trim();
    if (e === "0" || e === "false" || e === "off") return null;
    if (e) return { artifactsDir: resolve(e), publicBaseUrl: cfg?.publicBaseUrl, listUncertified: !!cfg?.listUncertified };
    if (!cfg?.serveArtifacts) return null;
    if (!cfg.artifactsDir) throw new Error("mithril.serveArtifacts needs mithril.artifactsDir");
    return { artifactsDir: resolve(cfg.artifactsDir), publicBaseUrl: cfg.publicBaseUrl, listUncertified: !!cfg.listUncertified };
}

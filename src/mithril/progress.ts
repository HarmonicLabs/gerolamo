/**
 * Mithril bootstrap progress file — a small JSON the bootstrap rewrites as it goes
 * (certificate → download → apply → done) so the web dashboard (scripts/dashboard-server.ts
 * `--mithril-progress <file>`) can show a certified-chain import that runs outside the node.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type MithrilProgressPhase = "certificate" | "download" | "apply" | "done" | "error";

export type MithrilProgress = {
    phase: MithrilProgressPhase;
    network: string;
    snapshotHash?: string;
    snapshotEpoch?: number;
    /** Snapshot beacon: last immutable file number. */
    beacon?: number;
    certificateVerified?: boolean;
    /** Current chunk of the running phase and the total it works towards. */
    chunk?: number;
    chunks?: number;
    downloadedChunks?: number;
    appliedChunks?: number;
    /** Blocks stored so far (apply phase) and the slot of the last one. */
    blocks?: number;
    lastSlot?: number;
    lastEpoch?: number;
    /** Chunks per second of the running phase, and seconds left at that rate. */
    ratePerSec?: number;
    etaSec?: number | null;
    /** Block store the chain lands in (blocks-only) or the ledger it is applied to. */
    db?: string;
    blocksOnly?: boolean;
    startedAt: string;
    updatedAt: string;
    message?: string;
};

/** Atomic rewrite (tmp + rename) so a reader never sees a torn file. Best effort. */
export function writeMithrilProgress(file: string, p: MithrilProgress): void {
    try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...p, updatedAt: new Date().toISOString() }));
        renameSync(tmp, file);
    } catch {
        /* progress is informational */
    }
}

export type MithrilReplay = {
    /** "replay" while the node's tip is behind the certified chain, "live" once past it. */
    phase: "replay" | "live";
    certifiedSlot: number;
    certifiedEpoch?: number;
    tipSlot: number;
    percent: number;
    label: string;
};

/**
 * Where a node stands against a finished bootstrap: replaying the certified chain (tip behind the
 * snapshot's last slot) or live beyond it. Null while the bootstrap itself is still running.
 */
export function mithrilReplayStatus(p: MithrilProgress | null, tipSlot: number | bigint): MithrilReplay | null {
    if (!p || p.phase !== "done" || p.lastSlot == null || p.lastSlot <= 0) return null;
    const tip = Number(tipSlot);
    const certifiedSlot = p.lastSlot;
    if (tip >= certifiedSlot) return { phase: "live", certifiedSlot, certifiedEpoch: p.lastEpoch, tipSlot: tip, percent: 100, label: "certified chain replayed; following live peers" };
    const percent = Math.max(0, Math.min(100, (100 * tip) / certifiedSlot));
    return { phase: "replay", certifiedSlot, certifiedEpoch: p.lastEpoch, tipSlot: tip, percent, label: `replaying certified chain: slot ${tip.toLocaleString()} of ${certifiedSlot.toLocaleString()} (${percent.toFixed(1)} %)` };
}

const cache = new Map<string, { at: number; value: MithrilProgress | null }>();
/** `readMithrilProgress` with a short cache for hot paths (/metrics every second). */
export function readMithrilProgressCached(file: string, ttlMs = 3000): MithrilProgress | null {
    const hit = cache.get(file);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = readMithrilProgress(file);
    cache.set(file, { at: Date.now(), value });
    return value;
}

export function readMithrilProgress(file: string): MithrilProgress | null {
    try {
        const p = JSON.parse(readFileSync(file, "utf8")) as MithrilProgress;
        return p && typeof p.phase === "string" ? p : null;
    } catch {
        return null;
    }
}

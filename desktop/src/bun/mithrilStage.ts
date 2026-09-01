export type MithrilStage = "idle" | "starting" | "downloading" | "applying" | "ready" | "failed";

export type MithrilStageInput = {
  pidAlive: boolean;
  exitCode: number | null;
  snapshotBytes: number;
  dbBytes: number;
  immutableCount: number;
  logTail: string;
};

export function inferMithrilStage(input: MithrilStageInput): { stage: MithrilStage; label: string } {
  const log = input.logTail || "";
  if (!input.pidAlive && input.exitCode != null && input.exitCode !== 0) {
    return { stage: "failed", label: `Failed · exit ${input.exitCode}` };
  }
  if (!input.pidAlive && /mithril-bootstrap complete/i.test(log)) {
    return { stage: "ready", label: "Bootstrap complete · next: Start node" };
  }
  if (input.pidAlive && (/"phase"\s*:\s*"apply"/.test(log) || /chunksDone/.test(log))) {
    return { stage: "applying", label: "Applying chunks…" };
  }
  if (input.pidAlive && (input.snapshotBytes > 0 || input.immutableCount > 0)) {
    return { stage: "downloading", label: "Downloading snapshot…" };
  }
  if (input.pidAlive) {
    return { stage: "starting", label: "Starting…" };
  }
  return { stage: "idle", label: "" };
}

/** Same SQLite file cannot have two writers (node + bootstrap). */
export function writersConflict(input: {
  nodeDb: string;
  nodeAlive: boolean;
  bootstrapDb: string;
  bootstrapAlive: boolean;
}): boolean {
  if (input.nodeDb !== input.bootstrapDb) return false;
  return input.nodeAlive || input.bootstrapAlive;
}

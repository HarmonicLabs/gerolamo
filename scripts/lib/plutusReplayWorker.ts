/** Worker side of scripts/plutus-replay.ts. */
import { runReplayJob, type ReplayJob } from "./plutusReplayJob";
declare const self: Worker;
self.onmessage = async (ev: MessageEvent) => {
    const job = ev.data as ReplayJob;
    try { self.postMessage(await runReplayJob(job)); }
    catch (e) { self.postMessage({ ok: false, redeemers: 0, ms: 0, declaredCpu: 0, error: `exception: ${e instanceof Error ? e.message : String(e)}` }); }
};

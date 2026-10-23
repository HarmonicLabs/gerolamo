/**
 * Keep-alive reply deadline (bug 395).
 *
 * A KeepAlive request that is never answered means the bearer is dead, whatever the socket says: over a VPN or NAT
 * a TCP session can stay ESTABLISHED for hours after the far end is gone (laptop node 3037, 2026-10-13 09:57–15:07
 * UTC: the server relay was restarted twice, no RST ever arrived, and the local-root session sat "hot" with no
 * headers for five hours). cardano-node closes such a connection when a reply is overdue (StServer time limit 60 s).
 *
 * The check runs on the keep-alive tick. A tick that fires much later than scheduled means our own event loop was
 * blocked (a long ledger step); replies may be sitting unread in the socket buffer, so that tick never judges.
 */
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 60_000;

export function keepAliveTimeoutMs(env: Record<string, string | undefined> = process.env): number {
    const v = Number(env.GEROLAMO_KEEPALIVE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_KEEPALIVE_TIMEOUT_MS;
}

export type KeepAliveVerdict = "ok" | "late-tick" | "overdue";

export function keepAliveVerdict(o: {
    now: number;
    lastReplyAt: number;
    lastTickAt: number;
    intervalMs: number;
    timeoutMs: number;
}): KeepAliveVerdict {
    if (o.now - o.lastTickAt > 2 * o.intervalMs) return "late-tick";
    return o.now - o.lastReplyAt > o.timeoutMs ? "overdue" : "ok";
}

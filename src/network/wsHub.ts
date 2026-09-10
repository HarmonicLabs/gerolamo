/**
 * Bun WebSocket pub/sub hub for ops streaming (/ws/stats).
 * Fire-and-forget only — never await from rollForward / governor paths.
 */

/**
 * Topics:
 *   tip      — every applied block (coalesced 75 ms): slot, hash, epoch, era
 *   block    — the tip block in Blockfrost `/blocks/{id}` shape (only built when subscribed)
 *   metrics  — the /metrics document, at most once per second while blocks land
 *   peers    — governor snapshot on every governor tick
 *   governor — alias of peers
 *   mempool  — local mempool snapshot whenever it changes
 */
export type WsTopic = "tip" | "block" | "peers" | "metrics" | "governor" | "mempool";

export type WsClientData = {
    id: string;
    topics: Set<WsTopic>;
};

/** Bun Server requires a WebSocket data type param. */
export type GerolamoServer = import("bun").Server<WsClientData>;

const ALL_TOPICS: WsTopic[] = ["tip", "block", "peers", "metrics", "governor", "mempool"];

let serverRef: GerolamoServer | null = null;
let seq = 0;

export function attachWsServer(server: GerolamoServer): void {
    serverRef = server;
}

export function getWsServer(): GerolamoServer | null {
    return serverRef;
}

export function nextClientId(): string {
    seq += 1;
    return `c${seq}`;
}

export function isWsTopic(t: unknown): t is WsTopic {
    return typeof t === "string" && (ALL_TOPICS as string[]).includes(t);
}

/** Subscribers on a topic; 0 when no server is attached. Lets publishers skip building payloads nobody reads. */
export function wsSubscriberCount(topic: WsTopic): number {
    try {
        return serverRef?.subscriberCount(topic) ?? 0;
    } catch {
        return 0;
    }
}

export function defaultTopics(): Set<WsTopic> {
    return new Set<WsTopic>(["tip", "peers", "metrics"]);
}

export function allTopics(): readonly WsTopic[] {
    return ALL_TOPICS;
}

/** Publish JSON event to Bun topic subscribers. Never throws to callers. */
export function wsPublish(topic: WsTopic, data: unknown): void {
    try {
        // Serialising every tip for nobody was 2.7 % of the applier thread (profile 2026-09-07).
        if (wsSubscriberCount(topic) === 0) return;
        const payload = JSON.stringify({
            v: 1,
            type: topic,
            data,
            ts: new Date().toISOString(),
        });
        serverRef?.publish(topic, payload);
    } catch {
        /* drop */
    }
}

export const WS_BACKPRESSURE_BYTES = 256_000;

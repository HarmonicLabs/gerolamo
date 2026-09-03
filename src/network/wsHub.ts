/**
 * Bun WebSocket pub/sub hub for ops streaming (/ws/stats).
 * Fire-and-forget only — never await from rollForward / governor paths.
 */

export type WsTopic = "tip" | "peers" | "metrics" | "governor";

export type WsClientData = {
    id: string;
    topics: Set<WsTopic>;
};

/** Bun Server requires a WebSocket data type param. */
export type GerolamoServer = import("bun").Server<WsClientData>;

const ALL_TOPICS: WsTopic[] = ["tip", "peers", "metrics", "governor"];

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
    return (
        t === "tip" ||
        t === "peers" ||
        t === "metrics" ||
        t === "governor"
    );
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

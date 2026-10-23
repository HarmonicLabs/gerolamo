/**
 * A server-side WebSocket presented as the Node-socket shape the inbound N2N path expects
 * (`attachClient` uses on("data"/"close"/"error"), write, end, destroy, setTimeout,
 * remoteAddress/remotePort). Each WebSocket message is one mux segment (or several), exactly
 * the bytes a TCP peer would send; nothing is re-framed. docs/PLAN_BROWSER_NODE.md.
 */
import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";

export interface WsPeerInfo {
    remoteAddress: string;
    remotePort: number;
}

export class WsNodeSocket extends EventEmitter {
    readonly remoteAddress: string;
    readonly remotePort: number;
    private ws: ServerWebSocket<unknown> | null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private idleMs = 0;
    private idleCb: (() => void) | null = null;
    destroyed = false;

    constructor(ws: ServerWebSocket<unknown>, info: WsPeerInfo) {
        super();
        this.ws = ws;
        this.remoteAddress = info.remoteAddress;
        this.remotePort = info.remotePort;
    }

    /** Bun `websocket.message` handler feeds bytes here. */
    onMessage(data: string | ArrayBuffer | Uint8Array | Buffer): void {
        if (this.destroyed) return;
        // N2N over WebSocket is binary only (CIP draft, CIP/n2n-over-websocket): a text message is a protocol error
        if (typeof data === "string") { this.destroy(new Error("text message on an N2N WebSocket")); return; }
        const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        this.touch();
        this.emit("data", buf);
    }

    /** Bun `websocket.close` handler. */
    onClose(hadError = false): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.ws = null;
        this.clearIdle();
        this.emit("close", hadError);
    }

    onError(err: Error): void {
        this.emit("error", err);
    }

    write(data: Uint8Array | Buffer | string, cb?: (err?: Error) => void): boolean {
        if (!this.ws || this.destroyed) { cb?.(new Error("socket closed")); return false; }
        try {
            const bytes = typeof data === "string" ? Buffer.from(data, "binary") : data;
            this.ws.send(bytes);
            this.touch();
            cb?.();
            return true;
        } catch (err) {
            cb?.(err as Error);
            this.emit("error", err as Error);
            return false;
        }
    }

    end(): void {
        try { this.ws?.close(1000, "end"); } catch { /* already closed */ }
        this.onClose(false);
    }

    destroy(err?: Error): void {
        if (err) this.emit("error", err);
        try { this.ws?.close(1011, err ? err.message.slice(0, 120) : "destroy"); } catch { /* ignore */ }
        this.onClose(!!err);
    }

    /** Idle timeout in the Node socket sense: fires `cb` when no bytes moved for `ms`. */
    setTimeout(ms: number, cb?: () => void): this {
        this.idleMs = ms;
        this.idleCb = cb ?? null;
        this.touch();
        return this;
    }

    private touch(): void {
        this.clearIdle();
        if (this.idleMs > 0 && this.idleCb) this.idleTimer = setTimeout(() => this.emit("timeout"), this.idleMs);
        if (this.idleCb && this.listenerCount("timeout") === 0) this.on("timeout", this.idleCb);
    }

    private clearIdle(): void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }

    // Node-socket surface the multiplexer may probe
    get readyState(): string { return this.destroyed ? "closed" : "open"; }
    get writable(): boolean { return !this.destroyed; }
    get readable(): boolean { return !this.destroyed; }
    setNoDelay(): this { return this; }
    setKeepAlive(): this { return this; }
    pause(): this { return this; }
    resume(): this { return this; }
    unref(): this { return this; }
    ref(): this { return this; }
}

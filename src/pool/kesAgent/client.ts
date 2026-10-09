/**
 * kes-agent service client (what cardano-node runs with `--shelley-kes-agent-socket`): connect
 * to the agent's service socket, negotiate a version, then receive KES sign key + operational
 * certificate bundles whenever the agent has a new one (on connect, after a rotation, after
 * each evolution) and confirm each with a RecvResult. The key never touches the disk here.
 *
 * Behaviour ported from kes-agent's `Cardano.KESAgent.Processes.ServiceClient`:
 *   - versions: Service:2.0 preferred, then Service:1.0 (the agent offers, we pick);
 *   - V2 timestamps: a push not newer than the last one of the session is answered
 *     `KeyOutdated` without being installed;
 *   - reconnect forever after any session end.
 * And from Dingo's client (blinklabs-io/dingo kesagent/client.go): socket path length check,
 * exponential reconnect backoff (250 ms doubling to 30 s) reset only by an installed key, a
 * bound on how long the body of a message may take once its first byte arrived, and wiping
 * every buffer that held key material.
 */
import { resolve as resolvePath } from "node:path";
import { logger } from "../../utils/logger";
import {
    BUNDLE_BYTES, CLIENT_VERSIONS, DROP_KEY_MESSAGE, KEY_MESSAGE, MAX_OFFERED_VERSIONS, RecvResult, VERSION_ID_BYTES,
    concat, decodeBundle, decodeVersionIds, encodeRecvResult, encodeVersionAnswer, pickVersion, readU32, readU64, recvResultName, versionName,
    type AgentBundle, type ServiceVersion,
} from "./protocol";

/** Linux sun_path is 108 bytes including the terminating NUL. */
export const UNIX_SOCKET_PATH_MAX = 107;

/** Resolve and check a configured socket path; throws with an operator-readable reason. */
export function validateKesAgentSocketPath(path: string): string {
    if (typeof path !== "string" || !path.trim()) throw new Error("producer.kesAgentSocket must be a non-empty path");
    if (path.startsWith("\0") || path.startsWith("@")) throw new Error(`producer.kesAgentSocket ${JSON.stringify(path)}: abstract socket names are not supported, use a filesystem path`);
    const abs = resolvePath(path);
    const len = Buffer.byteLength(abs);
    if (len > UNIX_SOCKET_PATH_MAX) throw new Error(`producer.kesAgentSocket is ${len} bytes, over the ${UNIX_SOCKET_PATH_MAX}-byte Unix socket path limit (sun_path): use a shorter path: ${abs}`);
    return abs;
}

export interface KesAgentPushMeta {
    version: ServiceVersion;
    /** Agent timestamp in µs (Service:2.0), null on Service:1.0. */
    timestamp: bigint | null;
}

export interface KesAgentClientOptions {
    socketPath: string;
    /** Install a pushed bundle; resolve with a RecvResult code. Owns `bundle.kesSignKey` (zero it). */
    onKey(bundle: AgentBundle, meta: KesAgentPushMeta): Promise<number>;
    /** The agent asks us to forget the key (Service:2.0 DropKey); resolve with a RecvResult code. */
    onDrop?(meta: KesAgentPushMeta): Promise<number>;
    /** Connection state changes, for logs / metrics. */
    onState?(state: KesAgentClientState): void;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    /** Handshake (offer, answer, version message) must complete within this. */
    handshakeTimeoutMs?: number;
    /** Once the first byte of a push arrived, the rest must arrive within this. */
    bodyTimeoutMs?: number;
}

export interface KesAgentClientState {
    socketPath: string;
    connected: boolean;
    version: string | null;
    connects: number;
    disconnects: number;
    keysReceived: number;
    keysAccepted: number;
    keysRejected: number;
    drops: number;
    lastKeyAt: string | null;
    /** Last RecvResult we sent, by name. */
    lastResult: string | null;
    lastError: string | null;
    backoffMs: number;
    nextRetryAt: string | null;
}

class Eof extends Error {}

/** Accumulates socket chunks and hands out exact byte counts; consumed bytes are zeroed. */
export class ByteReader {
    private chunks: Uint8Array[] = [];
    private size = 0;
    private waiter: { n: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null } | null = null;
    private closed: Error | null = null;

    push(chunk: Uint8Array): void {
        if (this.closed || chunk.length === 0) return;
        this.chunks.push(Uint8Array.from(chunk));
        chunk.fill(0);
        this.size += chunk.length;
        this.serve();
    }

    close(err: Error = new Eof("connection closed")): void {
        if (this.closed) return;
        this.closed = err;
        const w = this.waiter;
        this.waiter = null;
        if (w) { if (w.timer) clearTimeout(w.timer); w.reject(err); }
        for (const c of this.chunks) c.fill(0);
        this.chunks = [];
        this.size = 0;
    }

    get buffered(): number { return this.size; }

    read(n: number, timeoutMs?: number): Promise<Uint8Array> {
        if (this.waiter) return Promise.reject(new Error("ByteReader: concurrent read"));
        if (this.size >= n) return Promise.resolve(this.take(n));
        if (this.closed) return Promise.reject(this.closed);
        return new Promise((resolve, reject) => {
            const timer = timeoutMs != null ? setTimeout(() => {
                if (this.waiter?.resolve !== resolve) return;
                this.waiter = null;
                reject(new Error(`timed out after ${timeoutMs} ms waiting for ${n} byte(s) (${this.size} buffered)`));
            }, timeoutMs) : null;
            this.waiter = { n, resolve, reject, timer };
        });
    }

    private serve(): void {
        const w = this.waiter;
        if (!w || this.size < w.n) return;
        this.waiter = null;
        if (w.timer) clearTimeout(w.timer);
        w.resolve(this.take(w.n));
    }

    private take(n: number): Uint8Array {
        const out = new Uint8Array(n);
        let o = 0;
        while (o < n) {
            const c = this.chunks[0]!;
            const k = Math.min(c.length, n - o);
            out.set(c.subarray(0, k), o);
            c.fill(0, 0, k);
            o += k;
            if (k === c.length) this.chunks.shift();
            else this.chunks[0] = c.subarray(k);
        }
        this.size -= n;
        return out;
    }
}

type BunSocket = { write(data: Uint8Array): number; end(): void; flush?(): void };

export class KesAgentClient {
    private readonly socketPath: string;
    private readonly minBackoff: number;
    private readonly maxBackoff: number;
    private readonly handshakeTimeout: number;
    private readonly bodyTimeout: number;
    private stopped = true;
    private socket: BunSocket | null = null;
    private reader: ByteReader | null = null;
    private pendingWrite: Uint8Array | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> | null = null;
    private backoff = 0;
    private readonly st: KesAgentClientState;

    constructor(private readonly opts: KesAgentClientOptions) {
        this.socketPath = validateKesAgentSocketPath(opts.socketPath);
        this.minBackoff = opts.minBackoffMs ?? 250;
        this.maxBackoff = opts.maxBackoffMs ?? 30_000;
        this.handshakeTimeout = opts.handshakeTimeoutMs ?? 10_000;
        this.bodyTimeout = opts.bodyTimeoutMs ?? 10_000;
        this.st = { socketPath: this.socketPath, connected: false, version: null, connects: 0, disconnects: 0, keysReceived: 0, keysAccepted: 0, keysRejected: 0, drops: 0, lastKeyAt: null, lastResult: null, lastError: null, backoffMs: 0, nextRetryAt: null };
    }

    state(): KesAgentClientState {
        return { ...this.st };
    }

    /** Connect and keep reconnecting until stop(). */
    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.loop();
    }

    stop(): void {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.st.nextRetryAt = null;
        try { this.socket?.end(); } catch { /* already closed */ }
        this.reader?.close(new Eof("client stopped"));
    }

    /** Resolves when the current session (if any) has ended; for tests. */
    async idle(): Promise<void> {
        await this.running;
    }

    private loop(): void {
        if (this.stopped || this.running) return;
        this.running = this.session()
            .catch((err: Error) => {
                if (this.stopped) return;
                const msg = err instanceof Eof ? "agent closed the connection" : String(err?.message ?? err);
                this.st.lastError = msg;
                logger.warn(`kes-agent: ${msg}`);
            })
            .finally(() => {
                this.running = null;
                const was = this.st.connected;
                this.st.connected = false;
                this.st.version = null;
                if (was) this.st.disconnects++;
                try { this.socket?.end(); } catch { /* already closed */ }
                this.reader?.close();
                this.socket = null;
                this.reader = null;
                this.pendingWrite = null;
                if (this.stopped) { this.notify(); return; }
                this.backoff = this.backoff ? Math.min(this.maxBackoff, this.backoff * 2) : this.minBackoff;
                this.st.backoffMs = this.backoff;
                this.st.nextRetryAt = new Date(Date.now() + this.backoff).toISOString();
                this.notify();
                this.retryTimer = setTimeout(() => { this.retryTimer = null; this.st.nextRetryAt = null; this.loop(); }, this.backoff);
            });
    }

    private notify(): void {
        try { this.opts.onState?.(this.state()); } catch { /* observer only */ }
    }

    private async connect(): Promise<ByteReader> {
        const reader = new ByteReader();
        this.reader = reader;
        const self = this;
        this.socket = await Bun.connect({
            unix: this.socketPath,
            socket: {
                data(_s, chunk) { reader.push(chunk); },
                drain(s) { self.flush(s as unknown as BunSocket); },
                close() { reader.close(); },
                end() { reader.close(); },
                error(_s, err) { reader.close(new Error(`socket error: ${err?.message ?? err}`)); },
            },
        }) as unknown as BunSocket;
        return reader;
    }

    private write(bytes: Uint8Array): void {
        const s = this.socket;
        if (!s) throw new Eof("not connected");
        this.pendingWrite = this.pendingWrite ? concat([this.pendingWrite, bytes]) : bytes;
        this.flush(s);
    }

    private flush(s: BunSocket): void {
        const p = this.pendingWrite;
        if (!p) return;
        const n = s.write(p);
        this.pendingWrite = n >= p.length ? null : p.subarray(Math.max(0, n));
    }

    private async session(): Promise<void> {
        let reader: ByteReader;
        try { reader = await this.connect(); }
        catch (err) { throw new Error(`cannot connect to ${this.socketPath}: ${(err as Error)?.message ?? err}`); }
        if (this.stopped) { try { this.socket?.end(); } catch { /* closed */ } return; }
        this.st.connects++;

        // 1. version handshake: the agent offers, we pick
        const t = this.handshakeTimeout;
        const count = readU32(await reader.read(4, t));
        if (count === 0 || count > MAX_OFFERED_VERSIONS) throw new Error(`protocol error: agent offered ${count} versions`);
        const offered = decodeVersionIds(await reader.read(count * VERSION_ID_BYTES, t), count);
        const version = pickVersion(offered);
        this.write(encodeVersionAnswer(version));
        if (!version) {
            try { this.socket?.end(); } catch { /* closed */ }
            throw new Error(`no common protocol version: the agent offers ${offered.join(", ")}; this client speaks ${CLIENT_VERSIONS.join(", ")}`);
        }
        // 2. the service protocol opens with the agent repeating the version
        const echoed = versionName(await reader.read(VERSION_ID_BYTES, t));
        if (echoed !== version) throw new Error(`protocol error: agreed ${version}, agent announced ${echoed}`);
        this.st.connected = true;
        this.st.version = version;
        this.st.lastError = null;
        logger.info(`kes-agent: connected to ${this.socketPath} (${version})`);
        this.notify();

        // 3. pushes until the agent hangs up
        let latest: bigint | null = null;
        for (;;) {
            let kind = KEY_MESSAGE;
            let timestamp: bigint | null = null;
            let bundleBytes: Uint8Array | null = null;
            if (version === "Service:2.0") {
                kind = (await reader.read(1))[0]!;
                if (kind !== KEY_MESSAGE && kind !== DROP_KEY_MESSAGE) throw new Error(`protocol error: unknown push kind ${kind}`);
                timestamp = readU64(await reader.read(8, this.bodyTimeout));
                if (kind === KEY_MESSAGE) bundleBytes = await reader.read(BUNDLE_BYTES, this.bodyTimeout);
            } else {
                const first = await reader.read(1);
                const rest = await reader.read(BUNDLE_BYTES - 1, this.bodyTimeout);
                bundleBytes = concat([first, rest]);
                first.fill(0); rest.fill(0);
            }
            const meta: KesAgentPushMeta = { version, timestamp };
            let code: number;
            if (timestamp != null && latest != null && timestamp <= latest) {
                code = RecvResult.keyOutdated;
                bundleBytes?.fill(0);
                if (kind === KEY_MESSAGE) { this.st.keysReceived++; this.st.keysRejected++; }
            } else if (kind === DROP_KEY_MESSAGE) {
                if (timestamp != null) latest = timestamp;
                this.st.drops++;
                code = this.opts.onDrop ? await this.opts.onDrop(meta).catch(() => RecvResult.unknown) : RecvResult.unsupportedOperation;
            } else {
                if (timestamp != null) latest = timestamp;
                this.st.keysReceived++;
                let bundle: AgentBundle | null = null;
                try { bundle = decodeBundle(bundleBytes!); } catch (err) { this.st.lastError = `malformed bundle: ${(err as Error)?.message ?? err}`; }
                finally { bundleBytes!.fill(0); }
                code = bundle ? await this.opts.onKey(bundle, meta).catch((err) => { this.st.lastError = String((err as Error)?.message ?? err); return RecvResult.unknown; }) : RecvResult.unknown;
                if (bundle) bundle.kesSignKey.fill(0); // the receiver copies what it keeps
                if (code === RecvResult.ok) {
                    this.st.keysAccepted++;
                    this.st.lastKeyAt = new Date().toISOString();
                    this.backoff = 0; // only an installed key proves the agent healthy (Dingo)
                    this.st.backoffMs = 0;
                } else this.st.keysRejected++;
            }
            this.st.lastResult = recvResultName(code);
            this.write(encodeRecvResult(code));
            this.notify();
        }
    }
}

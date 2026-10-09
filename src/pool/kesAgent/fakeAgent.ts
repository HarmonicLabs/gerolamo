/**
 * Test support: an in-process kes-agent service endpoint speaking the real wire protocol
 * (version offer, accept, version echo, key / drop pushes, RecvResult replies) on a Unix socket.
 * Not used by the node.
 */
import { concat, encodeVersionOffer, readU32, versionId, versionName } from "./protocol";

type Sock = { write(b: Uint8Array): number; end(): void; data: Conn };
interface Conn { buf: Uint8Array; phase: "answer" | "results" | "closed"; version: string | null }

export class FakeKesAgent {
    /** Version answers received: the accepted name, or null for a rejection. */
    readonly answers: Array<string | null> = [];
    /** RecvResult codes received, in order. */
    readonly results: number[] = [];
    connections = 0;
    private server: ReturnType<typeof Bun.listen> | null = null;
    private readonly socks = new Set<Sock>();
    private waiters: Array<() => void> = [];

    /** `versions`: what the agent offers; `onSession`: bytes to push right after the version echo (e.g. the current key). */
    constructor(readonly path: string, public versions: string[] = ["Service:2.0", "Service:1.0"], public onSession?: () => Uint8Array | null) {}

    start(): this {
        const self = this;
        this.server = Bun.listen<Conn>({
            unix: this.path,
            socket: {
                open(s) {
                    s.data = { buf: new Uint8Array(0), phase: "answer", version: null };
                    self.socks.add(s as unknown as Sock);
                    self.connections++;
                    s.write(encodeVersionOffer(self.versions));
                },
                data(s, chunk) {
                    const c = s.data;
                    c.buf = concat([c.buf, Uint8Array.from(chunk)]);
                    for (;;) {
                        if (c.phase === "answer") {
                            if (c.buf.length < 1) break;
                            if (c.buf[0] === 0) { self.answers.push(null); c.phase = "closed"; c.buf = c.buf.subarray(1); self.wake(); break; }
                            if (c.buf.length < 33) break;
                            c.version = versionName(c.buf.subarray(1, 33));
                            self.answers.push(c.version);
                            c.buf = c.buf.subarray(33);
                            c.phase = "results";
                            s.write(versionId(c.version));
                            const first = self.onSession?.();
                            if (first) s.write(first);
                            self.wake();
                            continue;
                        }
                        if (c.phase === "results") {
                            if (c.buf.length < 4) break;
                            self.results.push(readU32(c.buf));
                            c.buf = c.buf.subarray(4);
                            self.wake();
                            continue;
                        }
                        break;
                    }
                },
                close(s) { self.socks.delete(s as unknown as Sock); self.wake(); },
            },
        });
        return this;
    }

    get open(): number { return this.socks.size; }

    /** Write raw bytes to every connected client that finished the handshake. */
    push(bytes: Uint8Array): void {
        for (const s of this.socks) if (s.data.phase === "results") s.write(bytes);
    }

    /** Hang up on every client. */
    disconnectAll(): void {
        for (const s of [...this.socks]) s.end();
    }

    stop(): void {
        this.disconnectAll();
        this.server?.stop(true);
        this.server = null;
    }

    private wake(): void {
        const w = this.waiters;
        this.waiters = [];
        for (const f of w) f();
    }

    /** Resolve once `cond()` holds (checked on every protocol event and every 10 ms). */
    async until(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
        const t0 = Date.now();
        while (!cond()) {
            if (Date.now() - t0 > timeoutMs) throw new Error(`fake kes-agent: timed out waiting for ${what}`);
            await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 10); });
        }
    }
}

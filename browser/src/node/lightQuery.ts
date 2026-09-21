/**
 * Client side of the Gerolamo light-query mini-protocol (mux protocol 7 on N2N connections): the epoch nonce and a
 * pool's active stake, requested over the same WebSocket as chain-sync and block-fetch, so a
 * browser node needs nothing but the relay's N2N endpoint. Wire format: see
 * `src/network/n2n/N2NLightQueryHost.ts`.
 */
import { Cbor, CborArray, CborBytes, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import type { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";

/**
 * Mux protocol number. The multiplexer library only forwards known mini-protocol numbers, so the
 * light query rides on 7 (the node-to-client LocalStateQuery number), which never appears on a
 * node-to-node connection: cardano-nodes do not open it there and Gerolamo hosts nothing else on it.
 */
export const LIGHT_QUERY_PROTOCOL = 7;

export interface PoolStakeInfo {
    epoch: number;
    poolStake: bigint | null;
    totalActiveStake: bigint | null;
    activeSlotsCoeff: { num: bigint; den: bigint };
}

export class LightQueryClient {
    private queue: Array<{ resolve: (m: CborObj) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    private pending: Uint8Array | null = null;
    private readonly onPayload = (payload: Uint8Array) => this.receive(payload);
    readonly supported: Promise<boolean>;

    constructor(private readonly mux: Multiplexer, timeoutMs = 10_000) {
        this.mux.on(LIGHT_QUERY_PROTOCOL as any, this.onPayload);
        this.timeoutMs = timeoutMs;
        this.supported = this.hello().then(() => true).catch(() => false);
    }
    private timeoutMs: number;

    dispose(): void { try { this.mux.off(LIGHT_QUERY_PROTOCOL as any, this.onPayload); } catch { /* ignore */ } }

    private receive(payload: Uint8Array): void {
        const bytes = this.pending ? concat(this.pending, payload) : payload;
        this.pending = null;
        let off = 0;
        while (off < bytes.length) {
            let p: { parsed: CborObj; offset: number };
            try { p = Cbor.parseWithOffset(bytes.subarray(off)); } catch { this.pending = bytes.slice(off); return; }
            off += p.offset;
            const w = this.queue.shift();
            if (w) { clearTimeout(w.timer); w.resolve(p.parsed); }
        }
    }

    private request(msg: CborObj, timeoutMs = this.timeoutMs): Promise<CborObj> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { const i = this.queue.findIndex((q) => q.timer === timer); if (i >= 0) this.queue.splice(i, 1); reject(new Error("light query timed out")); }, timeoutMs);
            this.queue.push({ resolve, reject, timer });
            this.mux.send(Cbor.encode(msg).toBuffer(), { protocol: LIGHT_QUERY_PROTOCOL as any, hasAgency: true });
        });
    }

    async hello(): Promise<{ magic: number }> {
        const r = await this.request(new CborArray([new CborUInt(4)]));
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 5) throw new Error("light query not supported by this relay");
        return { magic: Number((a[1] as CborUInt).num) };
    }

    async epochNonce(epoch: number): Promise<Uint8Array | null> {
        const r = await this.request(new CborArray([new CborUInt(0), new CborUInt(epoch)]));
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 1) throw new Error("unexpected light query reply");
        return a[2] instanceof CborBytes ? a[2].bytes : null;
    }

    /** A complete immutable chunk (the three files) from the relay, or null when it does not have it. */
    async chunk(chunkNo: number): Promise<{ chunk: Uint8Array; primary: Uint8Array; secondary: Uint8Array } | null> {
        const r = await this.request(new CborArray([new CborUInt(6), new CborUInt(chunkNo)]), 60_000);
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 7) throw new Error("unexpected light query reply");
        if (!(a[2] instanceof CborBytes)) return null;
        return { chunk: (a[2] as CborBytes).bytes, primary: (a[3] as CborBytes).bytes, secondary: (a[4] as CborBytes).bytes };
    }

    async poolStake(epoch: number, poolId: Uint8Array): Promise<PoolStakeInfo> {
        const r = await this.request(new CborArray([new CborUInt(2), new CborUInt(epoch), new CborBytes(poolId)]));
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 3) throw new Error("unexpected light query reply");
        const u = (x: CborObj | undefined) => (x instanceof CborUInt ? BigInt(x.num) : null);
        return { epoch, poolStake: u(a[2]), totalActiveStake: u(a[3]), activeSlotsCoeff: { num: u(a[4]) ?? 5n, den: u(a[5]) ?? 100n } };
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }

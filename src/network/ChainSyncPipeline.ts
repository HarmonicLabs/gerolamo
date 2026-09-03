/**
 * Bookkeeping for pipelined ChainSync `MsgRequestNext`.
 *
 * The mini-protocol lets the client send several RequestNext before the
 * first reply (network-spec §3.7); the server answers in order. Without this
 * a syncing node pays one full round trip per header (~150 ms to a relay on
 * another continent), which capped Gerolamo at ~6 headers/s regardless of
 * how fast validation is.
 *
 * Depth policy: `maxDepth` while catching up; 1 once the server has answered
 * `MsgAwaitReply` (we are at its tip and should not stack awaits). A
 * rollback keeps the current mode.
 */
export interface ChainSyncPipelineOptions {
    /** Requests kept in flight while behind the peer's tip. Clamped 1..256. Default 32. */
    maxDepth?: number;
}

export class ChainSyncPipeline {
    private outstanding = 0;
    private atTip = false;
    private readonly maxDepth: number;

    constructor(opts: ChainSyncPipelineOptions = {}) {
        const d = Number(opts.maxDepth ?? 32);
        this.maxDepth = Number.isFinite(d) ? Math.max(1, Math.min(256, Math.trunc(d))) : 32;
    }

    get inFlight(): number {
        return this.outstanding;
    }

    get isAtTip(): boolean {
        return this.atTip;
    }

    /** Current target depth. */
    depth(): number {
        return this.atTip ? 1 : this.maxDepth;
    }

    /** Server said it has nothing new: we are at its tip. */
    noteAwaitReply(): void {
        this.atTip = true;
    }

    /**
     * A reply (RollForward or RollBackward) consumed one outstanding request.
     * `tipGapSlots` (peer tip − this header's slot) lets us leave tip mode
     * again when the peer has moved far ahead of what it is sending us.
     */
    noteReply(tipGapSlots?: bigint | number): void {
        if (this.outstanding > 0) this.outstanding--;
        if (tipGapSlots != null && Number(tipGapSlots) > ChainSyncPipeline.CATCH_UP_GAP_SLOTS) this.atTip = false;
    }

    /** How many RequestNext to send now to reach the target depth. */
    toSend(): number {
        return Math.max(0, this.depth() - this.outstanding);
    }

    /** Record that `n` requests were sent. */
    noteSent(n: number): void {
        this.outstanding += Math.max(0, n);
    }

    /** Connection reset / sync loop stopped. */
    reset(): void {
        this.outstanding = 0;
        this.atTip = false;
    }

    /** Beyond this many slots behind the peer's tip we are clearly catching up. */
    static readonly CATCH_UP_GAP_SLOTS = 600;
}

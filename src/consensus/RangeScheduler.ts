/**
 * Parallel BlockFetch across peers with strictly ordered apply.
 *
 * The primary peer's ChainSync delivers validated headers in order. Each
 * batch of headers becomes one *range*; ranges are downloaded concurrently
 * from any peer the caller deems safe for that range (`pickPeers`), verified
 * against their advertised headers on arrival, then handed to `onRange` one
 * at a time in submission order. A range that fails on one peer is reissued
 * to another; a range that fails `retryLimit` times poisons the queue and
 * every later range rejects.
 *
 * BlockFetch is request/response per connection, so the parallelism here is
 * across *peers* — that is what "batch download from more than one node" is.
 *
 * Generic over the point and block types; no I/O of its own.
 */

export interface RangePoint {
    slot: bigint;
    hash: string;
}

export interface RangeSchedulerOptions<Pt extends RangePoint, Blk> {
    /** Max ranges downloading at once (≈ number of hot peers). */
    maxInFlight: number;
    /** Peers allowed to serve a range ending at `endSlot`, best first. */
    pickPeers: (endSlot: bigint) => string[];
    /** Download `points` from `peer`. Must resolve with exactly one block per point. */
    fetch: (peer: string, points: Pt[]) => Promise<Blk[]>;
    /** Throw when `blocks` do not match `points` (hash/slot/body). */
    verify: (points: Pt[], blocks: Blk[], peer: string) => void | Promise<void>;
    /** Apply a verified range. Called strictly in submission order, one at a time. */
    onRange: (points: Pt[], blocks: Blk[], peer: string) => Promise<void>;
    /** Stop starting downloads while this many verified ranges wait for apply (default 2×maxInFlight). */
    maxAwaitingApply?: number;
    /** A peer failed a range (network) or served bad data (`malicious`). */
    onPeerFailure?: (peer: string, err: unknown, info: { malicious: boolean; seq: number }) => void;
    /** Apply failed or a range exhausted its retries: the queue is poisoned. */
    onFatal?: (err: unknown) => void;
    retryLimit?: number;
}

interface RangeJob<Pt, Blk> {
    seq: number;
    points: Pt[];
    blocks: Blk[] | null;
    peer: string | null;
    attempts: number;
    triedPeers: Set<string>;
    scheduled: { resolve: () => void; reject: (e: unknown) => void };
    applied: { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };
    error: unknown;
}

export interface RangeSchedulerStats {
    inFlight: number;
    queued: number;
    awaitingApply: number;
    applied: number;
    retries: number;
    nextApplySeq: number;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export class RangeScheduler<Pt extends RangePoint, Blk> {
    private readonly opts: Required<Pick<RangeSchedulerOptions<Pt, Blk>, "maxInFlight" | "retryLimit">> &
        RangeSchedulerOptions<Pt, Blk>;
    private seq = 0;
    private nextApplySeq = 0;
    private inFlight = 0;
    private readonly waitingForSlot: RangeJob<Pt, Blk>[] = [];
    private readonly jobs = new Map<number, RangeJob<Pt, Blk>>();
    private applying = false;
    private poisoned: unknown = null;
    private retries = 0;
    private appliedCount = 0;
    private rr = 0;
    /** Peers with a range download in progress. BlockFetch is request/response per connection: one range per peer at a time. */
    private readonly busyPeers = new Set<string>();
    /** Bumped by reset(); stale downloads must not touch counters afterwards. */
    private generation = 0;

    constructor(opts: RangeSchedulerOptions<Pt, Blk>) {
        this.opts = { retryLimit: 3, ...opts, maxInFlight: Math.max(1, opts.maxInFlight) };
    }

    /**
     * Queue one range. Resolves `scheduled` when a download slot is taken
     * (back-pressure for the header stream) and `applied` when `onRange`
     * finished for this range.
     */
    submit(points: Pt[]): { seq: number; scheduled: Promise<void>; applied: Promise<void> } {
        if (points.length === 0) throw new Error("RangeScheduler.submit: empty range");
        if (this.poisoned) {
            const err = this.poisoned;
            const scheduled = Promise.reject(err);
            const applied = Promise.reject(err);
            scheduled.catch(() => undefined);
            applied.catch(() => undefined);
            return { seq: -1, scheduled, applied };
        }
        const scheduled = deferred();
        const applied = deferred();
        const job: RangeJob<Pt, Blk> = {
            seq: this.seq++,
            points,
            blocks: null,
            peer: null,
            attempts: 0,
            triedPeers: new Set(),
            scheduled,
            applied,
            error: null,
        };
        // Callers may await only one of the two; keep the other from surfacing as unhandled.
        scheduled.promise.catch(() => undefined);
        applied.promise.catch(() => undefined);
        this.jobs.set(job.seq, job);
        this.waitingForSlot.push(job);
        this.pump();
        return { seq: job.seq, scheduled: scheduled.promise, applied: applied.promise };
    }

    stats(): RangeSchedulerStats {
        let awaitingApply = 0;
        for (const j of this.jobs.values()) if (j.blocks && j.seq >= this.nextApplySeq) awaitingApply++;
        return {
            inFlight: this.inFlight,
            queued: this.waitingForSlot.length,
            awaitingApply,
            applied: this.appliedCount,
            retries: this.retries,
            nextApplySeq: this.nextApplySeq,
        };
    }

    /** Wait until every submitted range has been applied (or the queue is poisoned). */
    async drain(): Promise<void> {
        const pending = [...this.jobs.values()].map((j) => j.applied.promise);
        await Promise.allSettled(pending);
        if (this.poisoned) throw this.poisoned;
    }

    /** Forget everything (after a rollback / primary switch). Pending promises reject with SchedulerReset. */
    reset(reason = "scheduler reset"): void {
        const err = new SchedulerReset(reason);
        for (const j of this.jobs.values()) {
            j.scheduled.reject(err);
            j.applied.reject(err);
        }
        this.jobs.clear();
        this.waitingForSlot.length = 0;
        this.inFlight = 0;
        this.busyPeers.clear();
        this.generation++;
        this.nextApplySeq = this.seq;
        this.poisoned = null;
    }

    private awaitingApply(): number {
        let n = 0;
        for (const j of this.jobs.values()) if (j.blocks && j.seq >= this.nextApplySeq) n++;
        return n;
    }

    private pump(): void {
        const cap = this.opts.maxAwaitingApply ?? this.opts.maxInFlight * 2;
        while (
            this.inFlight < this.opts.maxInFlight &&
            this.waitingForSlot.length > 0 &&
            this.awaitingApply() + this.inFlight < cap + this.opts.maxInFlight
        ) {
            const job = this.waitingForSlot[0]!;
            // Only start when a peer is free: never two ranges on one connection.
            const peer = this.choosePeer(job);
            if (!peer) break;
            this.waitingForSlot.shift();
            this.inFlight++;
            this.busyPeers.add(peer);
            job.scheduled.resolve();
            void this.download(job, peer, this.generation);
        }
    }

    /** A free peer for this range, untried ones first, round-robin within a class. */
    private choosePeer(job: RangeJob<Pt, Blk>): string | null {
        const end = job.points[job.points.length - 1]!.slot;
        const eligible = this.opts.pickPeers(end).filter((p) => !this.busyPeers.has(p));
        if (eligible.length === 0) return null;
        const untried = eligible.filter((p) => !job.triedPeers.has(p));
        const pool = untried.length > 0 ? untried : eligible;
        return pool[this.rr++ % pool.length]!;
    }

    private async download(job: RangeJob<Pt, Blk>, firstPeer: string, gen: number): Promise<void> {
        let peer: string | null = firstPeer;
        try {
            while (true) {
                if (this.poisoned) throw this.poisoned;
                if (!peer) {
                    // Every eligible peer is busy: give the event loop a turn and retry.
                    await new Promise((r) => setTimeout(r, 25));
                    if (gen !== this.generation) return;
                    peer = this.choosePeer(job);
                    if (!peer) {
                        if (this.opts.pickPeers(job.points[job.points.length - 1]!.slot).length === 0) {
                            throw new Error(`no peer available for range seq=${job.seq}`);
                        }
                        continue;
                    }
                    this.busyPeers.add(peer);
                }
                job.attempts++;
                job.triedPeers.add(peer);
                job.peer = peer;
                try {
                    const blocks = await this.opts.fetch(peer, job.points);
                    if (gen !== this.generation) return;
                    if (!Array.isArray(blocks) || blocks.length !== job.points.length) {
                        throw new RangeMismatch(
                            `peer ${peer} returned ${Array.isArray(blocks) ? blocks.length : "no"} blocks for ${job.points.length}-point range`,
                        );
                    }
                    await this.opts.verify(job.points, blocks, peer);
                    job.blocks = blocks;
                    break;
                } catch (err) {
                    if (gen !== this.generation) return;
                    const malicious = err instanceof RangeMismatch;
                    this.opts.onPeerFailure?.(peer, err, { malicious, seq: job.seq });
                    if (job.attempts >= this.opts.retryLimit) throw err;
                    this.retries++;
                } finally {
                    if (peer) this.busyPeers.delete(peer);
                    peer = null;
                }
            }
        } catch (err) {
            if (gen !== this.generation) return;
            job.error = err;
            this.poison(err);
            return;
        } finally {
            if (gen === this.generation) {
                this.inFlight--;
                this.pump();
            }
        }
        void this.applyInOrder();
    }

    private poison(err: unknown): void {
        if (this.poisoned) return;
        this.poisoned = err;
        for (const j of this.jobs.values()) {
            j.scheduled.reject(err);
            j.applied.reject(err);
        }
        this.waitingForSlot.length = 0;
        this.opts.onFatal?.(err);
    }

    private async applyInOrder(): Promise<void> {
        if (this.applying) return;
        this.applying = true;
        try {
            while (!this.poisoned) {
                const job = this.jobs.get(this.nextApplySeq);
                if (!job || !job.blocks) break;
                try {
                    await this.opts.onRange(job.points, job.blocks, job.peer!);
                } catch (err) {
                    job.error = err;
                    this.poison(err);
                    break;
                }
                this.jobs.delete(job.seq);
                this.nextApplySeq++;
                this.appliedCount++;
                job.applied.resolve();
                this.pump(); // an apply slot freed: allow more downloads
            }
        } finally {
            this.applying = false;
        }
    }
}

/** Thrown by `verify` (or internally) when a peer's blocks do not match the advertised range. */
/** Pending work was dropped on purpose (rollback / primary switch) — not a failure of the peer. */
export class SchedulerReset extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "SchedulerReset";
    }
}

export class RangeMismatch extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RangeMismatch";
    }
}

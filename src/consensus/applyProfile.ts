/**
 * Cheap phase timers for the sync pipeline. `performance.now()` deltas are
 * summed per label so `/metrics.sync.profile` can show where wall time goes
 * (parse vs validate vs SQLite vs nonce…). Overhead is one clock read per
 * phase; safe to leave on.
 */
export interface PhaseStat {
    ms: number;
    count: number;
}

export interface ProfileSnapshot {
    /** Total ms and calls per phase. */
    phases: Record<string, PhaseStat>;
    /** Blocks applied since the profile was created / reset. */
    blocks: number;
    /** Wall ms between first and last `noteBlock`, for utilisation math. */
    wallMs: number;
    /** ms per block for each phase (phase.ms / blocks), rounded. */
    perBlockMs: Record<string, number>;
}

export class ApplyProfile {
    private readonly phases = new Map<string, PhaseStat>();
    private blocks = 0;
    private firstAt: number | null = null;
    private lastAt: number | null = null;

    add(label: string, ms: number): void {
        const p = this.phases.get(label);
        if (p) {
            p.ms += ms;
            p.count++;
        } else {
            this.phases.set(label, { ms, count: 1 });
        }
    }

    /** Time a synchronous section. */
    time<T>(label: string, fn: () => T): T {
        const t0 = performance.now();
        try {
            return fn();
        } finally {
            this.add(label, performance.now() - t0);
        }
    }

    /** Time an awaited section. */
    async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const t0 = performance.now();
        try {
            return await fn();
        } finally {
            this.add(label, performance.now() - t0);
        }
    }

    noteBlock(n = 1): void {
        const now = performance.now();
        if (this.firstAt == null) this.firstAt = now;
        this.lastAt = now;
        this.blocks += n;
    }

    get blockCount(): number {
        return this.blocks;
    }

    snapshot(): ProfileSnapshot {
        const phases: Record<string, PhaseStat> = {};
        const perBlockMs: Record<string, number> = {};
        for (const [k, v] of this.phases) {
            phases[k] = { ms: Math.round(v.ms), count: v.count };
            perBlockMs[k] = this.blocks > 0 ? Math.round((v.ms / this.blocks) * 100) / 100 : 0;
        }
        return {
            phases,
            blocks: this.blocks,
            wallMs: this.firstAt != null && this.lastAt != null ? Math.round(this.lastAt - this.firstAt) : 0,
            perBlockMs,
        };
    }

    /** One-line summary, phases sorted by total time. */
    summary(): string {
        const s = this.snapshot();
        const parts = Object.entries(s.phases)
            .sort((a, b) => b[1].ms - a[1].ms)
            .map(([k, v]) => `${k}=${s.perBlockMs[k]}ms/${v.count}x`);
        return `blocks=${s.blocks} wall=${s.wallMs}ms per-block(ms)/calls: ${parts.join(" ")}`;
    }

    reset(): void {
        this.phases.clear();
        this.blocks = 0;
        this.firstAt = null;
        this.lastAt = null;
    }
}

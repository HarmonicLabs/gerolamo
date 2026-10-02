/**
 * Genesis State Machine (ouroboros-consensus 3.0 `Ouroboros.Consensus.Node.GSM`, cardano-node 11):
 *
 *   PreSyncing ──HAA satisfied──▶ Syncing ──all peers idle, no candidate better than ours──▶ CaughtUp
 *        ▲                          │                                                        │
 *        └──────HAA lost────────────┘            ◀── selection older than maxCaughtUpAge ─────┘
 *
 *   - Honest Availability Assumption (Genesis mode, `outboundConnectionsState`): at least
 *     `minBigLedgerPeersForTrustedState` (5) active big ledger peers, or only trusted local roots
 *     connected;
 *   - CaughtUp is left when the tip is older than `maxCaughtUpAge` (20 min, `llrnMaxCaughtUpAge`)
 *     plus a random bonus of up to 300 s (anti thundering herd, drawn once per CaughtUp period),
 *     but never before `minCaughtUpDuration` (= maxCaughtUpAge in cardano-node) has passed;
 *   - the state survives restarts through a marker file: present and the tip not too old →
 *     start CaughtUp, otherwise PreSyncing.
 *
 * What each state means for the node (Node/Genesis.hs `setGetLoEFragment`): PreSyncing → the LoE
 * fragment is empty at the immutable tip (the selection may not run more than k blocks past it);
 * Syncing → LoE = the shared prefix of the candidates, GDD active; CaughtUp → LoE and GDD off.
 * Pure: the caller supplies the view and the clock.
 */
export type GsmState = "PreSyncing" | "Syncing" | "CaughtUp";

export interface GsmView {
    /** Honest Availability Assumption currently satisfied. */
    haa: boolean;
    /** Number of upstream peers with a ChainSync state. */
    peers: number;
    /** Every peer's ChainSync is idle (MsgAwaitReply: nothing more to send). */
    allIdle: boolean;
    /** Some peer's candidate is preferable to our selection (or does not intersect it). */
    anyCandidateBetter: boolean;
    /** Wall-clock age of our selection's tip, ms (Infinity when past the forecast horizon or unknown). */
    tipAgeMs: number;
}

export interface GsmOptions {
    maxCaughtUpAgeMs?: number;
    minCaughtUpDurationMs?: number;
    /** Upper bound of the random bonus added to maxCaughtUpAge per CaughtUp period (ms). 0 disables. */
    maxBonusMs?: number;
    rng?: () => number;
    onTransition?: (from: GsmState, to: GsmState, why: string) => void;
}

export const GSM_DEFAULTS = { maxCaughtUpAgeMs: 20 * 60_000, maxBonusMs: 300_000, minBigLedgerPeersForTrustedState: 5 } as const;

export class GenesisStateMachine {
    private st: GsmState;
    private caughtUpSince = 0;
    private bonusMs = 0;
    private readonly maxAge: number;
    private readonly minDuration: number;
    private readonly maxBonus: number;
    private readonly rng: () => number;

    constructor(initial: GsmState, private readonly opts: GsmOptions = {}, now = Date.now()) {
        this.maxAge = opts.maxCaughtUpAgeMs ?? GSM_DEFAULTS.maxCaughtUpAgeMs;
        this.minDuration = opts.minCaughtUpDurationMs ?? this.maxAge;
        this.maxBonus = opts.maxBonusMs ?? GSM_DEFAULTS.maxBonusMs;
        this.rng = opts.rng ?? Math.random;
        this.st = initial;
        if (initial === "CaughtUp") { this.caughtUpSince = now - this.minDuration; this.drawBonus(); } // restarted CaughtUp: no minimum stay
    }

    /** `initializationGsmState`: CaughtUp if the marker says so and the tip is still young enough. */
    static initialState(markerPresent: boolean, tipAgeMs: number, maxCaughtUpAgeMs: number = GSM_DEFAULTS.maxCaughtUpAgeMs): GsmState {
        return markerPresent && tipAgeMs < maxCaughtUpAgeMs ? "CaughtUp" : "PreSyncing";
    }

    get state(): GsmState { return this.st; }

    private drawBonus(): void { this.bonusMs = this.maxBonus > 0 ? Math.floor(this.rng() * (this.maxBonus / 1000 + 1)) * 1000 : 0; }

    private go(to: GsmState, why: string, now: number): GsmState {
        const from = this.st;
        this.st = to;
        if (to === "CaughtUp") { this.caughtUpSince = now; this.drawBonus(); }
        this.opts.onTransition?.(from, to, why);
        return to;
    }

    /** Evaluate the transitions once (the Haskell version blocks on STM; we poll). */
    step(v: GsmView, now = Date.now()): GsmState {
        switch (this.st) {
            case "PreSyncing":
                if (v.haa) return this.go("Syncing", "Honest Availability Assumption satisfied", now);
                return this.st;
            case "Syncing":
                if (!v.haa) return this.go("PreSyncing", "Honest Availability Assumption no longer satisfied", now);
                if (v.peers > 0 && v.allIdle && !v.anyCandidateBetter) return this.go("CaughtUp", `all ${v.peers} peer(s) idle, no better candidate`, now);
                return this.st;
            case "CaughtUp":
                if (now - this.caughtUpSince < this.minDuration) return this.st;
                if (v.tipAgeMs >= this.maxAge + this.bonusMs) return this.go("PreSyncing", `selection is ${Math.round(v.tipAgeMs / 1000)} s old (> ${Math.round((this.maxAge + this.bonusMs) / 1000)} s)`, now);
                return this.st;
        }
    }
}

/** HAA in Genesis mode (cardano-diffusion `outboundConnectionsState`, `DontUseBootstrapPeers, GenesisMode`). */
export function honestAvailability(opts: { activeBigLedgerPeers: number; minBigLedgerPeers?: number; onlyTrustedLocalRoots: boolean }): boolean {
    if (opts.onlyTrustedLocalRoots) return true;
    return opts.activeBigLedgerPeers >= (opts.minBigLedgerPeers ?? GSM_DEFAULTS.minBigLedgerPeersForTrustedState);
}

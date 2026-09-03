/**
 * Decouples consensus / peer manager from HTTP WS publishing.
 * Callers emit; peerBlockServer registers listeners that wsPublish.
 */

export type TipEvent = {
    slot: string;
    hash?: string;
    epoch?: number | null;
    /** Ledger era (0/1 Byron … 7 Conway, 8 Dijkstra). */
    era?: number | null;
};

export type PeersEvent = Record<string, unknown>;

type TipListener = (tip: TipEvent) => void;
type PeersListener = (snap: PeersEvent) => void;

let tipListener: TipListener | null = null;
let peersListener: PeersListener | null = null;

/** Coalesce tip bursts: last-wins within window. */
let pendingTip: TipEvent | null = null;
let tipTimer: ReturnType<typeof setTimeout> | null = null;
const TIP_COALESCE_MS = 75;

export function setTipListener(cb: TipListener | null): void {
    tipListener = cb;
}

export function setPeersListener(cb: PeersListener | null): void {
    peersListener = cb;
}

export function emitTip(tip: TipEvent): void {
    pendingTip = tip;
    if (tipTimer != null) return;
    tipTimer = setTimeout(() => {
        tipTimer = null;
        const t = pendingTip;
        pendingTip = null;
        if (!t || !tipListener) return;
        queueMicrotask(() => {
            try {
                tipListener?.(t);
            } catch {
                /* */
            }
        });
    }, TIP_COALESCE_MS);
}

export function emitPeers(snap: PeersEvent): void {
    if (!peersListener) return;
    queueMicrotask(() => {
        try {
            peersListener?.(snap);
        } catch {
            /* */
        }
    });
}

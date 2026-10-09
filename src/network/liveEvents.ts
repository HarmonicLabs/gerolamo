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

/**
 * The selected chain changed (a block adopted or a rollback): the validating mempool re-applies
 * its transactions. Called synchronously on every change; the listener coalesces.
 */
type ChainChangedListener = () => void;
let chainChangedListener: ChainChangedListener | null = null;
export function setChainChangedListener(cb: ChainChangedListener | null): void {
    chainChangedListener = cb;
}
/** Further chain-change subscribers (UTxO RPC streams); each gets every change, errors are contained. */
const chainChangedSubscribers = new Set<ChainChangedListener>();
export function subscribeChainChanged(cb: ChainChangedListener): () => void {
    chainChangedSubscribers.add(cb);
    return () => { chainChangedSubscribers.delete(cb); };
}
export function emitChainChanged(): void {
    try {
        chainChangedListener?.();
    } catch {
        /* */
    }
    for (const cb of chainChangedSubscribers) {
        try { cb(); } catch { /* */ }
    }
}

export function emitTip(tip: TipEvent): void {
    emitChainChanged();
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

type MempoolListener = () => void;
let mempoolListener: MempoolListener | null = null;
let mempoolTimer: ReturnType<typeof setTimeout> | null = null;
const MEMPOOL_COALESCE_MS = 200;

export function setMempoolListener(cb: MempoolListener | null): void {
    mempoolListener = cb;
}

/** The local mempool changed (a tx was added or drained). Coalesced; the listener snapshots it. */
export function emitMempool(): void {
    if (mempoolTimer != null) return;
    mempoolTimer = setTimeout(() => {
        mempoolTimer = null;
        try {
            mempoolListener?.();
        } catch {
            /* */
        }
    }, MEMPOOL_COALESCE_MS);
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

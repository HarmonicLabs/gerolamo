import { MiniProtocol, type Multiplexer, type MultiplexerHeader } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../../utils/logger";
import { isN2NInitiatorFrame } from "./N2NDirection";
import { N2NBlockFetchHost } from "./N2NBlockFetchHost";
import { N2NChainSyncHost } from "./N2NChainSyncHost";
import { N2NKeepAliveHost } from "./N2NKeepAliveHost";
import { N2NPeerSharingHost, type SharePeersProvider } from "./N2NPeerSharingHost";
import { N2NTxSubmissionHost, type TxSubmissionMempool } from "./N2NTxSubmissionHost";
import type { RelayChainStore } from "./RelayChainStore";
import { SqliteRelayChainStore } from "./SqliteRelayChainStore";
import { relayChainStoreOverride } from "../../storage/nodeBlockStore";

/**
 * Responder side of a duplex outbound connection. A relay or producer advertises
 * InitiatorAndResponder in its outbound handshake, and cardano-node then runs its own
 * ChainSync / BlockFetch / KeepAlive / PeerSharing / TxSubmission initiators over the
 * connection *we* opened: the hot peers we already talk to can pull our forged blocks
 * without ever dialling our inbound port. Until 2026-09-12 the flag was advertised and
 * nothing answered (their requests hit our client parsers), so a forged block could only
 * leave through a rare inbound hot peer.
 */
export interface DuplexResponderDeps {
    store?: RelayChainStore;
    sharePeers?: SharePeersProvider;
    mempool?: TxSubmissionMempool;
    maxRangeBlocks?: number;
}

let deps: DuplexResponderDeps | null = null;
let sharedStore: RelayChainStore | null = null;
/** Outbound peers that have sent ChainSync requests over the connection we opened. */
const pullers = new Map<string, number>();
/** Which of the remote's initiators have spoken on each outbound bearer (keep-alive = it holds us warm, chain-sync = hot). */
const activity = new Map<string, Map<string, number>>();
const PROTOCOL_NAMES: Record<number, string> = { [MiniProtocol.ChainSync]: "chain-sync", [MiniProtocol.BlockFetch]: "block-fetch", [MiniProtocol.TxSubmission]: "tx-submission", [MiniProtocol.KeepAlive]: "keep-alive", [MiniProtocol.PeerSharing]: "peer-sharing" };

/** Protocols the remote has started over the connection we opened to `peer`, with first-seen times. */
export function duplexActivity(peer: string): Array<{ protocol: string; since: number }> {
    return [...(activity.get(peer) ?? [])].map(([protocol, since]) => ({ protocol, since }));
}

/** When a given outbound peer first pulled our chain over duplex; null if it has not. */
export function duplexPullingSince(peer: string): number | null {
    return pullers.get(peer) ?? null;
}

/** A duplex puller counts while its chain-sync initiator has spoken within this window. */
const PULLER_LIVE_MS = 120_000;
/** Last chain-sync frame per peer (a puller that went quiet is not a carrier, whatever the governor thinks). */
const lastChainSyncFrame = new Map<string, number>();

/** Peer keys pulling our chain over duplex right now (a chain-sync frame in the last 2 min), with their first request time. */
export function duplexPullers(): Array<{ peer: string; since: number }> {
    const now = Date.now();
    return [...pullers].filter(([peer]) => now - (lastChainSyncFrame.get(peer) ?? 0) < PULLER_LIVE_MS).map(([peer, since]) => ({ peer, since }));
}

/** Enable duplex responders on outbound connections (call once, before peers connect). */
export function setDuplexResponderDeps(d: DuplexResponderDeps | null): void {
    deps = d;
    sharedStore = d?.store ?? null;
}

export function duplexRespondersEnabled(): boolean {
    return deps !== null;
}

export interface DuplexResponders {
    dispose(): void;
}

/** Attach the responder hosts to an outbound bearer (they only act on initiator-direction frames). */
export function startDuplexResponders(mplexer: Multiplexer, peer: string): DuplexResponders | null {
    if (!deps) return null;
    if (!sharedStore) sharedStore = relayChainStoreOverride() ?? new SqliteRelayChainStore(); // the block store opens after these deps are set
    const chainSync = new N2NChainSyncHost(mplexer, sharedStore, { peer: `${peer} (duplex)` });
    const blockFetch = new N2NBlockFetchHost(mplexer, sharedStore, { maxRangeBlocks: deps.maxRangeBlocks ?? 256, peer: `${peer} (duplex)` });
    const keepAlive = new N2NKeepAliveHost(mplexer);
    const peerSharing = new N2NPeerSharingHost(mplexer, deps.sharePeers ?? (() => []));
    const txSubmission = deps.mempool ? new N2NTxSubmissionHost(mplexer, { mempool: deps.mempool, peer }) : null;
    // one line per protocol when the remote first speaks it, so the log shows the remote's
    // governor promoting us (keep-alive = warm, chain-sync / block-fetch = hot: it pulls our blocks)
    const seen = new Map<number, (p: Uint8Array, header?: MultiplexerHeader) => void>();
    activity.set(peer, new Map());
    for (const proto of [MiniProtocol.ChainSync, MiniProtocol.BlockFetch, MiniProtocol.TxSubmission, MiniProtocol.KeepAlive, MiniProtocol.PeerSharing]) {
        const name = PROTOCOL_NAMES[proto] ?? String(proto);
        const listener = (_p: Uint8Array, header?: MultiplexerHeader) => {
            if (!isN2NInitiatorFrame(header)) return;
            if (proto === MiniProtocol.ChainSync) lastChainSyncFrame.set(peer, Date.now());
            const acts = activity.get(peer);
            if (!acts || acts.has(name)) return;
            acts.set(name, Date.now());
            if (proto === MiniProtocol.ChainSync) pullers.set(peer, Date.now());
            logger.info(`Duplex: ${peer} started ${name} over the connection we opened${proto === MiniProtocol.ChainSync ? " (it is pulling our chain)" : proto === MiniProtocol.KeepAlive ? " (it holds us as a warm peer)" : ""}`);
        };
        seen.set(proto, listener);
        mplexer.on(proto, listener);
    }
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const [proto, l] of seen) { try { mplexer.off(proto, l); } catch { /* ignore */ } }
            pullers.delete(peer);
            activity.delete(peer);
            lastChainSyncFrame.delete(peer);
            for (const h of [chainSync, blockFetch, keepAlive, peerSharing, txSubmission]) {
                try { h?.dispose(); } catch { /* ignore */ }
            }
        },
    };
}

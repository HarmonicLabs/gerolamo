/**
 * What the Prometheus endpoint reports, gathered from the running node with cheap reads only
 * (tip, the last k block points every 30 s, the shared mempool, governor / inbound state, the
 * block producer). Metric names: see prometheus.ts; the cardano-node source of each is noted.
 */
import { equivocationStats } from "../consensus/equivocation";
import { getChainTip, getRecentBlockPoints } from "../db";
import { getBlockProducer } from "../pool/startBlockProducer";
import { slotAt } from "../pool/slotClock";
import { epochForSlot, firstSlotOfEpoch, getEpochNetwork } from "../utils/epochFromSlotCalculations";
import { getBuildInfo } from "../utils/buildInfo";
import { allCounters, lastForgedSlot } from "./nodeMetrics";
import { getInboundN2NStatus, getOutboundConnectionStats, getPeerSelectionCounters, type GerolamoConfig } from "./peerManager";
import { initiatorOnly } from "./nodeRole";
import { GlobalSharedMempool } from "./SharedMempool";
import { haskellUtc, processMetrics, type Metric } from "./prometheus";

/**
 * cardano-node `fragmentChainDensity` over the last k blocks: (tip block number − oldest block
 * number) / (tip slot − oldest slot). Our points are consecutive blocks, so the block span is
 * count − 1.
 */
export function chainDensity(slotsNewestFirst: bigint[]): number {
    if (slotsNewestFirst.length < 2) return 0;
    const span = Number(slotsNewestFirst[0]! - slotsNewestFirst[slotsNewestFirst.length - 1]!);
    return span > 0 ? (slotsNewestFirst.length - 1) / span : 0;
}

let densityCache: { at: number; tipSlot: bigint; value: number } | null = null;

async function densityNow(k: number, tipSlot: bigint): Promise<number> {
    if (densityCache && densityCache.tipSlot === tipSlot) return densityCache.value;
    if (densityCache && Date.now() - densityCache.at < 30_000) return densityCache.value;
    const pts = await getRecentBlockPoints(Math.max(2, k)).catch(() => [] as Array<{ slot: bigint }>);
    const value = chainDensity(pts.map((p) => BigInt(p.slot)));
    densityCache = { at: Date.now(), tipSlot, value };
    return value;
}

/** GSM state (Consensus.hs `GSM.state`): 0 PreSyncing, 1 Syncing, 2 CaughtUp. Approximated from the tip's age. */
export function gsmState(tipSlot: bigint | null, wallSlot: bigint, caughtUpWithinSlots = 1200n): 0 | 1 | 2 {
    if (tipSlot == null) return 0;
    return wallSlot - tipSlot <= caughtUpWithinSlots ? 2 : 1;
}

export async function collectNodeMetrics(ctx: { config: GerolamoConfig; startedAtMs: number; securityParam: number }): Promise<Metric[]> {
    const m: Metric[] = [];
    const net = getEpochNetwork();
    const tip = await getChainTip().catch(() => null);
    // ChainDB.hs AddedToCurrentChain / SwitchedToAFork
    if (tip) {
        const epoch = epochForSlot(tip.slot, net);
        m.push(
            { name: "density", kind: "real", value: await densityNow(ctx.securityParam, tip.slot) },
            { name: "slotNum", kind: "int", value: tip.slot },
            { name: "blockNum", kind: "int", value: tip.blockNumber },
            { name: "slotInEpoch", kind: "int", value: tip.slot - firstSlotOfEpoch(epoch, net) },
            { name: "epoch", kind: "int", value: epoch },
        );
    }
    m.push({ name: "GSM.state", kind: "int", value: gsmState(tip?.slot ?? null, slotAt(Date.now(), net)) });

    // Mempool (Consensus.hs txsInMempool / mempoolBytes)
    try {
        const hs = await GlobalSharedMempool.getInstance().getTxHashesAndSizes();
        m.push({ name: "txsInMempool", kind: "int", value: hs.length }, { name: "mempoolBytes", kind: "int", value: hs.reduce((a, h) => a + Number((h as { size?: number }).size ?? 0), 0) });
    } catch { /* mempool not initialised */ }

    // Served blocks / headers, forge events (counters)
    for (const [name, v] of allCounters()) m.push({ name, kind: "counter", value: v });
    const fs = lastForgedSlot();
    if (fs != null) m.push({ name: "forgedSlotLast", kind: "int", value: fs });

    // Equivocations: two valid headers from one pool for one slot (Gerolamo; Dingo exports dingo_equivocation_total)
    const eq = equivocationStats();
    m.push({ name: "equivocations", kind: "counter", value: eq.total }, { name: "equivocationsOwnPool", kind: "counter", value: eq.self });

    // Block producer: forging, ForgingStats, KES (KESInfo.hs)
    const bp = getBlockProducer();
    m.push({ name: "forging_enabled", kind: "int", value: bp && !bp.stats().dryRun ? 1 : 0 });
    if (bp) {
        const st = bp.stats();
        if (st.opcert && st.kes) {
            const start = BigInt(st.opcert.kesPeriod);
            const current = BigInt(st.kes.period);
            const expiry = start + BigInt(st.kes.maxEvolutions);
            m.push(
                { name: "operationalCertificateStartKESPeriod", kind: "int", value: start },
                { name: "operationalCertificateExpiryKESPeriod", kind: "int", value: expiry },
                { name: "currentKESPeriod", kind: "int", value: current },
                { name: "remainingKESPeriods", kind: "int", value: expiry > current ? expiry - current : 0n },
            );
        }
        // kes-agent client (Gerolamo names; cardano-node traces these but exports no metric)
        const ag = st.credentials.agent;
        if (ag) {
            m.push(
                { name: "kesAgent.connected", kind: "int", value: ag.connected ? 1 : 0 },
                { name: "kesAgent.keysReceived", kind: "counter", value: ag.keysReceived },
                { name: "kesAgent.keysAccepted", kind: "counter", value: ag.keysAccepted },
                { name: "kesAgent.keysRejected", kind: "counter", value: ag.keysRejected },
                { name: "kesAgent.disconnects", kind: "counter", value: ag.disconnects },
            );
        }
        m.push(
            { name: "kesCredentialsInstalled", kind: "int", value: st.credentials.installed ? 1 : 0 },
            { name: "blocksForged", kind: "int", value: st.forged },
            { name: "nodeIsLeader", kind: "int", value: allCounters().get("Forge.node-is-leader") ?? 0 },
            { name: "nodeCannotForge", kind: "int", value: allCounters().get("Forge.could-not-forge") ?? 0 },
            { name: "slotsMissed", kind: "int", value: st.missedLeaderChecks },
        );
    }

    // Peer selection (PeerSelectionCounters.hs)
    const psc = getPeerSelectionCounters();
    if (psc) for (const [k, v] of Object.entries(psc)) m.push({ name: `peerSelection.${k}`, kind: "int", value: v });

    // Connection manager / inbound governor. Our outbound connections are duplex unless this is
    // a data node (InitiatorOnly); full duplex = the remote also runs its initiator side over it;
    // inbound connections are unidirectional (our handshake answer is InitiatorOnly).
    const inb = getInboundN2NStatus();
    const out = getOutboundConnectionStats();
    const dataNode = initiatorOnly(ctx.config);
    const inboundCount = inb.clients ?? 0;
    const duplexPullers = (inb.duplexPullers ?? []).length;
    m.push(
        { name: "connectionManager.outboundConns", kind: "int", value: out.outbound },
        { name: "connectionManager.inboundConns", kind: "int", value: inboundCount },
        { name: "connectionManager.duplexConns", kind: "int", value: dataNode ? 0 : out.outbound },
        { name: "connectionManager.fullDuplexConns", kind: "int", value: dataNode ? 0 : Math.max(out.duplex, duplexPullers) },
        { name: "connectionManager.unidirectionalConns", kind: "int", value: inboundCount + (dataNode ? out.outbound : 0) },
    );
    if (inb.listening) {
        let hot = 0, warm = 0, idle = 0;
        for (const c of inb.clientList ?? []) {
            const p = c.protocols ?? [];
            if (p.includes("chain-sync") || p.includes("block-fetch") || p.includes("tx-submission")) hot++;
            else if (p.includes("keep-alive")) warm++;
            else if (c.handshakeOk) idle++;
        }
        m.push({ name: "inboundGovernor.hot", kind: "int", value: hot }, { name: "inboundGovernor.warm", kind: "int", value: warm }, { name: "inboundGovernor.idle", kind: "int", value: idle });
    }

    // Startup.hs basicInfo / node.start.time
    m.push(
        { name: "basicInfo", kind: "info", value: 1, labels: { nodeStartTime: haskellUtc(ctx.startedAtMs) } },
        { name: "node.start.time", kind: "int", value: Math.ceil(ctx.startedAtMs / 1000) },
        { name: "gerolamo_build_info", kind: "info", value: 1, labels: { version: getBuildInfo().label } },
    );
    m.push(...processMetrics(ctx.startedAtMs));
    return m;
}

/**
 * Hard-fork history per network as the node-to-client LocalStateQuery serves it
 * (QueryHardFork GetInterpreter / GetSystemStart): era boundaries in epochs and the era
 * parameters, encoded exactly like ouroboros-consensus (captured from a cardano-node with
 * scripts/n2c-oracle.ts on 2026-09-14). Era summary = [start, end, params]; bound =
 * [relative time in picoseconds, slot, epoch]; params = [epochSize, slotLength ms,
 * safeZone [0, n, [0]], genesisWindow]; the last era's end is the horizon (start of the epoch after the tip's).
 *
 * The node answers from its ledger-driven hard-fork history (consensus/hfc, `interpreterFor`); the
 * per-network table below is the fallback when that history does not reach the tip's era.
 */
import { CborBytes, CborArray, CborSimple, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { getHardForkHistory } from "../../consensus/hfc/hfcNode";
import { encodeInterpreter, eraShape, reconstructSummary } from "../../consensus/hfc/hfc";

export type EraHistoryNetwork = "preview" | "preprod" | "mainnet";

export const HFC_ERA_NAMES = ["Byron", "Shelley", "Allegra", "Mary", "Alonzo", "Babbage", "Conway", "Dijkstra"] as const;

interface NetworkEras {
    systemStart: string;
    /** First epoch of each era, Byron first; the Byron epoch/slot geometry follows. */
    eraStartEpochs: number[];
    byron: { epochSlots: number; slotMs: number; safeZone: number };
    shelley: { epochSlots: number; slotMs: number; safeZone: number };
}

const NETWORKS: Record<EraHistoryNetwork, NetworkEras> = {
    // Byron, Shelley, Allegra and Mary are empty on preview (all start and end at epoch 0)
    preview: { systemStart: "2022-10-25T00:00:00Z", eraStartEpochs: [0, 0, 0, 0, 0, 3, 646], byron: { epochSlots: 4320, slotMs: 20000, safeZone: 864 }, shelley: { epochSlots: 86400, slotMs: 1000, safeZone: 25920 } },
    preprod: { systemStart: "2022-06-01T00:00:00Z", eraStartEpochs: [0, 4, 5, 6, 7, 12, 163], byron: { epochSlots: 21600, slotMs: 20000, safeZone: 4320 }, shelley: { epochSlots: 432000, slotMs: 1000, safeZone: 129600 } },
    mainnet: { systemStart: "2017-09-23T21:44:51Z", eraStartEpochs: [0, 208, 236, 251, 290, 365, 507], byron: { epochSlots: 21600, slotMs: 20000, safeZone: 4320 }, shelley: { epochSlots: 432000, slotMs: 1000, safeZone: 129600 } },
};

export function networkFromMagic(magic: number): EraHistoryNetwork | null {
    return magic === 2 ? "preview" : magic === 1 ? "preprod" : magic === 764824073 ? "mainnet" : null;
}

/** A uint that may exceed 2^64: encoded as CBOR bignum (tag 2, minimal big-endian bytes) like the reference node. */
function bigUInt(v: bigint): CborUInt {
    if (v < 1n << 64n) return new CborUInt(v);
    let hex = v.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    return new CborUInt(v, undefined, new CborBytes(Uint8Array.from(Buffer.from(hex, "hex"))));
}

/** UTCTime as the consensus codec writes it: [year, day of year (1-based), picoseconds of day]. */
export function encodeUtcTime(iso: string): CborArray {
    const d = new Date(iso);
    const year = d.getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    const dayOfYear = Math.floor((d.getTime() - start) / 86_400_000) + 1;
    const midnight = Date.UTC(year, d.getUTCMonth(), d.getUTCDate());
    const picos = BigInt(d.getTime() - midnight) * 1_000_000_000n;
    return new CborArray([new CborUInt(year), new CborUInt(dayOfYear), new CborUInt(picos)]);
}

export function systemStartOf(network: EraHistoryNetwork): string {
    return NETWORKS[network].systemStart;
}

/** Slot at which `epoch` starts, walking the Byron/Shelley geometry through the era table. */
function epochStartSlotAndTime(n: NetworkEras, epoch: number): { slot: bigint; seconds: bigint } {
    const byronEpochs = Math.max(0, n.eraStartEpochs[1]!); // Shelley's first epoch = number of Byron epochs
    const byronPart = Math.min(epoch, byronEpochs);
    const shelleyPart = Math.max(0, epoch - byronEpochs);
    const slot = BigInt(byronPart) * BigInt(n.byron.epochSlots) + BigInt(shelleyPart) * BigInt(n.shelley.epochSlots);
    const seconds = BigInt(byronPart) * BigInt(n.byron.epochSlots) * BigInt(n.byron.slotMs / 1000) + BigInt(shelleyPart) * BigInt(n.shelley.epochSlots) * BigInt(n.shelley.slotMs / 1000);
    return { slot, seconds };
}

function bound(n: NetworkEras, epoch: number): CborArray {
    const { slot, seconds } = epochStartSlotAndTime(n, epoch);
    return new CborArray([bigUInt(seconds * 1_000_000_000_000n), new CborUInt(slot), new CborUInt(epoch)]);
}

function params(p: { epochSlots: number; slotMs: number; safeZone: number }): CborArray {
    return new CborArray([new CborUInt(p.epochSlots), new CborUInt(p.slotMs), new CborArray([new CborUInt(0), new CborUInt(p.safeZone), new CborArray([new CborUInt(0)])]), new CborUInt(p.safeZone)]);
}

/** The era summaries up to and including `currentEraIndex` (HFC index: Byron 0 … Conway 6). */
export function eraSummaries(network: EraHistoryNetwork, currentEraIndex: number, horizonEpoch?: number): CborObj {
    const n = NETWORKS[network];
    const out: CborObj[] = [];
    const last = Math.min(currentEraIndex, n.eraStartEpochs.length - 1);
    for (let i = 0; i <= last; i++) {
        const start = bound(n, n.eraStartEpochs[i]!);
        // The last era's end is the forecast horizon: the boundary after the current epoch (a
        // cardano-node at epoch 1420 reported Conway ending at epoch 1421, 2026-09-14); null when unknown.
        const end = i < last ? bound(n, n.eraStartEpochs[i + 1]!) : horizonEpoch != null ? bound(n, horizonEpoch + 1) : new CborSimple(null);
        out.push(new CborArray([start, end, params(i === 0 ? n.byron : n.shelley)]));
    }
    return new CborArray(out, { indefinite: true }); // the reference node writes the summary list indefinite-length
}

/**
 * GetInterpreter for a ledger whose tip is at `tipSlot` in HFC era `eraIndex`: the node's
 * hard-fork history when it reaches that era (custom networks included), else the table above with
 * the consensus safe-zone horizon. null when neither knows the network.
 */
export function interpreterFor(network: EraHistoryNetwork | null, eraIndex: number, tipSlot: bigint | null): CborObj | null {
    const h = getHardForkHistory();
    if (h && h.currentEra() === eraIndex) return encodeInterpreter(h.summary(tipSlot));
    if (!network) return null;
    const n = NETWORKS[network];
    const shape = eraShape({
        byron: { k: n.byron.safeZone / 2, slotDurationMs: n.byron.slotMs },
        shelley: { epochLength: n.shelley.epochSlots, slotLengthSec: n.shelley.slotMs / 1000, securityParam: n.byron.safeZone / 2, activeSlotsCoeff: 0.05, systemStart: n.systemStart },
    });
    const starts = n.eraStartEpochs.slice(0, Math.min(eraIndex, n.eraStartEpochs.length - 1) + 1).map((e) => BigInt(e));
    return encodeInterpreter(reconstructSummary(shape, starts, { kind: "unknown", ledgerTipSlot: tipSlot }));
}

/** GetSystemStart: the Shelley genesis `systemStart` of the running network (table fallback). */
export function systemStartFor(network: EraHistoryNetwork | null): string | null {
    return getHardForkHistory()?.geometry.shelley.systemStart ?? (network ? NETWORKS[network].systemStart : null);
}

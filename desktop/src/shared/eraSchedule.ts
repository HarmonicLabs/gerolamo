/**
 * Hard-fork schedule per network: the first epoch of each ledger era.
 * Used to say how much of the current era is left while syncing.
 * Mainnet: Shelley 208, Allegra 236, Mary 251, Alonzo 290, Babbage 365, Conway 507.
 */
import type { GerolamoNetwork } from "./syncStatus";

export type EraStart = { era: string; epoch: number };

export const ERA_STARTS: Record<GerolamoNetwork, EraStart[]> = {
  mainnet: [
    { era: "Byron", epoch: 0 },
    { era: "Shelley", epoch: 208 },
    { era: "Allegra", epoch: 236 },
    { era: "Mary", epoch: 251 },
    { era: "Alonzo", epoch: 290 },
    { era: "Babbage", epoch: 365 },
    { era: "Conway", epoch: 507 },
  ],
  preprod: [
    { era: "Byron", epoch: 0 },
    { era: "Shelley", epoch: 4 },
    { era: "Allegra", epoch: 5 },
    { era: "Mary", epoch: 6 },
    { era: "Alonzo", epoch: 7 },
    { era: "Babbage", epoch: 12 },
    { era: "Conway", epoch: 163 },
  ],
  preview: [
    { era: "Alonzo", epoch: 0 },
    { era: "Babbage", epoch: 3 },
    { era: "Conway", epoch: 646 },
  ],
};

export type EraProgress = {
  era: string;
  startEpoch: number;
  /** Epochs of this era already behind the tip epoch (the tip epoch itself excluded). */
  epochsDone: number;
  /** Next era and its first epoch; null in the last scheduled era. */
  nextEra: string | null;
  nextEpoch: number | null;
  /** Epochs still to apply before the next era begins, counting the tip epoch; null when none is scheduled. */
  epochsLeft: number | null;
};

/** Where `epoch` sits in the network's era schedule. */
export function eraProgress(epoch: number, network: GerolamoNetwork): EraProgress {
  const starts = ERA_STARTS[network] ?? ERA_STARTS.mainnet;
  let i = 0;
  for (let k = 0; k < starts.length; k++) if (starts[k]!.epoch <= epoch) i = k;
  const cur = starts[i]!;
  const next = starts[i + 1] ?? null;
  return {
    era: cur.era,
    startEpoch: cur.epoch,
    epochsDone: Math.max(0, epoch - cur.epoch),
    nextEra: next?.era ?? null,
    nextEpoch: next?.epoch ?? null,
    epochsLeft: next ? Math.max(0, next.epoch - epoch) : null,
  };
}

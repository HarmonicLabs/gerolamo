/**
 * The HFC era index a block forged on `tipSlot`, or a transaction announced now, belongs to
 * (bug 237). Three floors, never below any of them:
 *   - the hard-fork history's answer, when it is complete (`ready`);
 *   - the era tag of the block store's tip block (`tipEra`: eras are monotone along the chain);
 *   - the built-in history of the public networks (`tableEra`).
 */
import type { HardForkHistory } from "./HardForkHistory";
import { LAST_REACHABLE_ERA } from "./hfc";

export function eraIndexAt(hfc: HardForkHistory | null, slot: bigint, tableEra: number): number {
    let era = tableEra;
    if (hfc) {
        const t = hfc.floorEraAt(slot);
        if (t != null && t > era) era = t;
        if (hfc.ready) { const e = hfc.eraOfSlot(slot); if (e > era) era = e; }
    }
    return Math.min(LAST_REACHABLE_ERA, era);
}

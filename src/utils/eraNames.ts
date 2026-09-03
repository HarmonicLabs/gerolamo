/**
 * Ledger era numbering shared by cardano-ledger-ts MultiEraBlock/MultiEraHeader
 * and Gerolamo's header parser: 0 Byron EBB, 1 Byron, 2 Shelley … 7 Conway, 8 Dijkstra.
 */
export const ERA_NAMES: Record<number, string> = {
    0: "Byron",
    1: "Byron",
    2: "Shelley",
    3: "Allegra",
    4: "Mary",
    5: "Alonzo",
    6: "Babbage",
    7: "Conway",
    8: "Dijkstra",
};

export function eraName(era: number | null | undefined): string | null {
    if (era == null || !Number.isFinite(era)) return null;
    return ERA_NAMES[era] ?? `Era ${era}`;
}

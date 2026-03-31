import type { BlockInfo } from "@/lib/api";

/** Era indices as used by BlockInfo.era */
export const ERA_NAMES: Record<number, string> = {
  0: "Byron",
  1: "Shelley",
  2: "Allegra",
  3: "Mary",
  4: "Alonzo",
  5: "Babbage",
  6: "Conway",
};

/** Spec-defined era colors */
export const ERA_COLORS: Record<number, string> = {
  0: "#9AA6B2", // Byron — muted gray
  1: "#00B3FF", // Shelley — cyan
  2: "#00B3FF", // Allegra — cyan
  3: "#00B3FF", // Mary — cyan
  4: "#FF8A00", // Alonzo — orange
  5: "#9B59B6", // Babbage — purple
  6: "#00E676", // Conway — green
};

/** Health status for a block's rim glow */
export type BlockHealth = "finalized" | "volatile" | "rolled-back";

/** Health status -> rim color */
export const HEALTH_COLORS: Record<BlockHealth, string> = {
  finalized: "#00E676",
  volatile: "#FF8A00",
  "rolled-back": "#FF4466",
};

/** Extended block representation for the diagram */
export interface DiagramBlock extends BlockInfo {
  /** Unique ID for keying */
  id: string;
  /** Health/finality status */
  health: BlockHealth;
  /** Whether this block just arrived via SSE */
  isNew: boolean;
  /** Client-side receive timestamp */
  receivedAt: number;
  /** Total fees in lovelace (sum of all tx fees), 0 if unknown */
  totalFees: number;
}

/** Lightweight transaction representation */
export interface DiagramTx {
  hash: string;
  fee: number;
  inputCount: number;
  outputCount: number;
  hasScripts: boolean;
  scriptValid: boolean;
  hasCollateral: boolean;
  hasMint: boolean;
}

/** Easing for scroll/expand animations */
export const EASE_SMOOTH = "cubic-bezier(0.4, 0, 0.2, 1)";
export const SCROLL_DURATION_MS = 250;

/** Number of blocks considered volatile (not yet finalized) */
export const VOLATILE_WINDOW = 2160;

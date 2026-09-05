import { describe, expect, test } from "bun:test";
import { eraProgress } from "./eraSchedule";

describe("eraProgress", () => {
  test("mainnet Byron epoch 89: 119 epochs until Shelley at 208", () => {
    expect(eraProgress(89, "mainnet")).toEqual({ era: "Byron", startEpoch: 0, epochsDone: 89, nextEra: "Shelley", nextEpoch: 208, epochsLeft: 119 });
  });
  test("boundary epochs belong to the new era", () => {
    expect(eraProgress(208, "mainnet").era).toBe("Shelley");
    expect(eraProgress(207, "mainnet").era).toBe("Byron");
    expect(eraProgress(163, "preprod").era).toBe("Conway");
  });
  test("last scheduled era has no end", () => {
    const p = eraProgress(600, "mainnet");
    expect(p.era).toBe("Conway");
    expect(p.nextEra).toBeNull();
    expect(p.epochsLeft).toBeNull();
    expect(p.epochsDone).toBe(93);
  });
  test("preview starts in Alonzo", () => {
    expect(eraProgress(1, "preview")).toMatchObject({ era: "Alonzo", nextEra: "Babbage", epochsLeft: 2 });
  });
});

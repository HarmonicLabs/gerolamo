import { describe, expect, test } from "bun:test";
import { ignoredValidationKeys, resolveValidationPolicy } from "./validationPolicy";

describe("validation policy", () => {
    test("genesis and point sync enforce everything", () => {
        for (const c of [{ syncFromGenesis: true }, { syncFromPoint: true }, {}, undefined]) {
            const p = resolveValidationPolicy(c);
            expect(p.ledgerComplete).toBe(true);
            expect(p.body).toBe("strict");
            expect(p.script).toBe("strict");
        }
    });

    test("tip sync is report-only for ledger rules and says why", () => {
        const p = resolveValidationPolicy({ syncFromTip: true });
        expect(p.ledgerComplete).toBe(false);
        expect(p.body).toBe("soft");
        expect(p.script).toBe("log");
        expect(p.note).toContain("Tip sync");
    });

    test("config knobs are ignored, not honoured", () => {
        const p = resolveValidationPolicy({ syncFromGenesis: true, bodyValidation: "soft", scriptValidation: "off" });
        expect(p.body).toBe("strict");
        expect(p.script).toBe("strict");
        expect(ignoredValidationKeys({ bodyValidation: "soft", scriptValidation: "off" })).toEqual(["bodyValidation=soft", "scriptValidation=off"]);
        expect(ignoredValidationKeys({})).toEqual([]);
    });
});

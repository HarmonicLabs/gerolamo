import { describe, expect, test } from "bun:test";
import { alonzoGenesisRaw, applyEraGenesis, conwayGenesisRaw, diffRawParams } from "./pparams";

const alonzo = "src/config/preprod/alonzo-genesis.json";
const conway = "src/config/preprod/conway-genesis.json";

describe("era genesis parameter merges", () => {
    test("Alonzo genesis → Blockfrost-shaped keys", async () => {
        const raw = alonzoGenesisRaw(await Bun.file(alonzo).json());
        expect(raw.coins_per_utxo_word).toBe("34482");
        expect(raw.price_mem).toBeCloseTo(0.0577, 6);
        expect(raw.price_step).toBeCloseTo(0.0000721, 9);
        expect(raw.max_tx_ex_mem).toBe("10000000");
        expect(raw.collateral_percent).toBe(150);
        expect(raw.max_collateral_inputs).toBe(3);
        expect(Object.keys((raw.cost_models as any).PlutusV1).length).toBe(166);
    });
    test("crossing into Alonzo, then Babbage, then Conway", async () => {
        const files = { alonzo, conway };
        const raw: Record<string, unknown> = { protocol_major_ver: 5, min_utxo: "1000000" };
        const merged = await applyEraGenesis(raw, 4, files);
        expect(merged).toContain("coins_per_utxo_word");
        expect(raw.coins_per_utxo_size).toBe("34482"); // Alonzo: the per-word value, as Blockfrost reports it
        expect(raw.min_utxo).toBe("0");
        raw.protocol_major_ver = 7;
        await applyEraGenesis(raw, 5, files);
        expect(raw.coins_per_utxo_size).toBe("4310");
        expect(raw.coins_per_utxo_word).toBe("4310"); // Blockfrost convention from Babbage on
        expect(raw.min_utxo).toBe("4310");
        expect(raw.decentralisation_param).toBe(0);
        raw.protocol_major_ver = 9;
        await applyEraGenesis(raw, 8, files);
        expect(raw.min_fee_ref_script_cost_per_byte).toBe(15);
        expect(raw.gov_action_lifetime).toBe(6);
        expect(raw.drep_deposit).toBe("500000000");
        expect(raw.dvt_p_p_gov_group).toBe(0.75);
        expect(Object.keys((raw.cost_models as any).PlutusV3).length).toBeGreaterThan(200);
        expect(Object.keys((raw.cost_models as any).PlutusV1).length).toBe(166);
    });
    test("an explicit update value wins over the genesis default", async () => {
        const raw: Record<string, unknown> = { protocol_major_ver: 7, coins_per_utxo_size: "4311", coins_per_utxo_word: "34482" };
        await applyEraGenesis(raw, 6, { alonzo, conway });
        expect(raw.coins_per_utxo_size).toBe("4311");
    });
    test("diff ignores representation differences", () => {
        expect(diffRawParams({ min_fee_a: "44", price_mem: 0.0577, epoch: 1 }, { min_fee_a: 44, price_mem: "0.0577", epoch: 2 })).toEqual([]);
        expect(diffRawParams({ min_fee_a: "44" }, { min_fee_a: 45 })).toEqual(["min_fee_a: local 44 vs external 45"]);
        expect(conwayGenesisRaw({ committeeMinSize: 7 }, null).committee_min_size).toBe(7);
    });
});

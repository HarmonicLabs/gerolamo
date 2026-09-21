import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { conwayPParamsCbor, toFraction } from "./pparamsCbor";

describe("toFraction", () => {
    test("decimals become fractions in lowest terms", () => {
        expect(toFraction(0.3)).toEqual([3n, 10n]);
        expect(toFraction(0.003)).toEqual([3n, 1000n]);
        expect(toFraction(0.2)).toEqual([1n, 5n]);
        expect(toFraction(0.0577)).toEqual([577n, 10000n]);
        expect(toFraction(7.21e-5)).toEqual([721n, 10000000n]);
        expect(toFraction(15)).toEqual([15n, 1n]);
        expect(toFraction("0.67")).toEqual([67n, 100n]);
        expect(toFraction("2/3")).toEqual([2n, 3n]);
        expect(toFraction(0)).toEqual([0n, 1n]);
    });
});

describe("conwayPParamsCbor", () => {
    test("31-field record with tag-30 rationals and the cost-model map", () => {
        const raw = {
            min_fee_a: 44, min_fee_b: 155381, max_block_size: 90112, max_tx_size: 16384, max_block_header_size: 1100,
            key_deposit: 2000000, pool_deposit: 500000000, e_max: 18, n_opt: 500, a0: 0.3, rho: 0.003, tau: 0.2,
            protocol_major_ver: 11, protocol_minor_ver: 0, min_pool_cost: 75000000, coins_per_utxo_size: "4310",
            cost_models: { PlutusV3: [1, -900], PlutusV1: [3] }, price_mem: 0.0577, price_step: 7.21e-5,
            max_tx_ex_mem: "17500000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "77500000", max_block_ex_steps: "20000000000",
            max_val_size: "5000", collateral_percent: 150, max_collateral_inputs: 3,
            pvt_motion_no_confidence: 0.51, pvt_committee_normal: 0.51, pvt_committee_no_confidence: 0.51, pvt_hard_fork_initiation: 0.51, pvt_p_p_security_group: 0.51,
            dvt_motion_no_confidence: 0.67, dvt_committee_normal: 0.67, dvt_committee_no_confidence: 0.6, dvt_update_to_constitution: 0.75, dvt_hard_fork_initiation: 0.6,
            dvt_p_p_network_group: 0.67, dvt_p_p_economic_group: 0.67, dvt_p_p_technical_group: 0.67, dvt_p_p_gov_group: 0.75, dvt_treasury_withdrawal: 0.67,
            committee_min_size: 3, committee_max_term_length: 365, gov_action_lifetime: 30, gov_action_deposit: 1000000000, drep_deposit: "500000000", drep_activity: 31,
            min_fee_ref_script_cost_per_byte: 15,
        };
        const pp = conwayPParamsCbor(raw);
        expect(pp.array.length).toBe(31);
        const back = Cbor.parse(Cbor.encode(pp).toBuffer()) as CborArray;
        expect(back.array.length).toBe(31);
        expect((back.array[0] as CborUInt).num).toBe(44n);
        const a0 = back.array[9] as CborTag;
        expect(a0.tag).toBe(30n);
        expect(((a0.data as CborArray).array as CborUInt[]).map((x) => x.num)).toEqual([3n, 10n]);
        expect(((back.array[12] as CborArray).array as CborUInt[]).map((x) => x.num)).toEqual([11n, 0n]);
        const cm = back.array[15] as any;
        expect(cm.map.map((e: any) => Number(e.k.num))).toEqual([0, 2]);
        expect(Number(cm.map[1].v.array[1].num)).toBe(-900);
        expect(Buffer.from(Cbor.encode(pp.array[15]!).toBuffer()).toString('hex')).toBe('a2009f03ff029f01390383ff'); // indefinite lists, negative int
        expect((back.array[22] as CborArray).array.length).toBe(5);
        expect((back.array[23] as CborArray).array.length).toBe(10);
        const ref = back.array[30] as CborTag;
        expect(((ref.data as CborArray).array as CborUInt[]).map((x) => x.num)).toEqual([15n, 1n]);
    });
});

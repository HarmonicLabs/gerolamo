import { describe, expect, test } from "bun:test";
import {
  EXPECTED_PLUTUS_V3_COST_MODEL_LENGTH,
  koiosRowToBlockfrostParams,
  plutusV3Length,
} from "./liveProtocolParams";

describe("koiosRowToBlockfrostParams", () => {
  test("maps Koios epoch_params into BF shape with PlutusV3 350", () => {
    const v3 = Array.from({ length: 350 }, (_, i) => i);
    const mapped = koiosRowToBlockfrostParams({
      epoch_no: 309,
      min_fee_a: 44,
      min_fee_b: 155381,
      max_block_size: 90112,
      max_tx_size: 16384,
      max_bh_size: 1100,
      key_deposit: 2000000,
      pool_deposit: 500000000,
      coins_per_utxo_size: 4310,
      collateral_percent: 150,
      max_collateral_inputs: 3,
      cost_models: {
        PlutusV1: [1],
        PlutusV2: [2],
        PlutusV3: v3,
      },
    });
    expect(mapped.min_fee_a).toBe(44);
    expect(mapped.min_fee_b).toBe(155381);
    expect(mapped.coins_per_utxo_size).toBe("4310");
    expect(mapped.max_block_header_size).toBe(1100);
    expect(plutusV3Length(mapped)).toBe(EXPECTED_PLUTUS_V3_COST_MODEL_LENGTH);
  });
});

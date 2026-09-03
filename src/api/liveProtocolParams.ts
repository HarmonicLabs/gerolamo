/**
 * Live epoch protocol parameters for MiniBF.
 * Genesis Conway V3 is 251 ops; current preprod PlutusV3 is 350.
 * Source of truth: Koios epoch_params (no project_id). Cached in protocol_params.
 */
import { populateProtocolParams } from "../state/blockfrost/protocol_params";
import { getLatestProtocolParams } from "../db";

export const EXPECTED_PLUTUS_V3_COST_MODEL_LENGTH = 350;

const KOIOS: Record<string, string> = {
  preprod: "https://preprod.koios.rest/api/v1/epoch_params?limit=1",
  testnet: "https://preprod.koios.rest/api/v1/epoch_params?limit=1",
  preview: "https://preview.koios.rest/api/v1/epoch_params?limit=1",
  mainnet: "https://api.koios.rest/api/v1/epoch_params?limit=1",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function plutusV3Length(params: unknown): number {
  const p = asRecord(params);
  if (!p) return 0;
  const raw = asRecord(p.cost_models_raw)?.PlutusV3 ?? asRecord(p.cost_models)?.PlutusV3;
  if (Array.isArray(raw)) return raw.length;
  const rec = asRecord(raw);
  return rec ? Object.keys(rec).length : 0;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

/** Map a Koios epoch_params row to Blockfrost /epochs/latest/parameters JSON. */
export function koiosRowToBlockfrostParams(row: Record<string, unknown>): Record<string, unknown> {
  const models = asRecord(row.cost_models) ?? {};
  const v1 = models.PlutusV1;
  const v2 = models.PlutusV2;
  const v3 = models.PlutusV3;
  return {
    epoch: num(row.epoch_no),
    min_fee_a: num(row.min_fee_a),
    min_fee_b: num(row.min_fee_b),
    max_block_size: num(row.max_block_size),
    max_tx_size: num(row.max_tx_size),
    max_block_header_size: num(row.max_bh_size),
    key_deposit: str(row.key_deposit),
    pool_deposit: str(row.pool_deposit),
    e_max: num(row.max_epoch),
    n_opt: num(row.optimal_pool_count),
    a0: num(row.influence),
    rho: num(row.monetary_expand_rate),
    tau: num(row.treasury_growth_rate),
    decentralisation_param: num(row.decentralisation),
    extra_entropy: row.extra_entropy ?? null,
    protocol_major_ver: num(row.protocol_major),
    protocol_minor_ver: num(row.protocol_minor),
    min_pool_cost: str(row.min_pool_cost),
    min_utxo: str(row.min_utxo_value),
    nonce: str(row.nonce),
    price_mem: num(row.price_mem),
    price_step: num(row.price_step),
    max_tx_ex_mem: str(row.max_tx_ex_mem),
    max_tx_ex_steps: str(row.max_tx_ex_steps),
    max_block_ex_mem: str(row.max_block_ex_mem),
    max_block_ex_steps: str(row.max_block_ex_steps),
    max_val_size: str(row.max_val_size),
    collateral_percent: num(row.collateral_percent),
    max_collateral_inputs: num(row.max_collateral_inputs),
    coins_per_utxo_size: str(row.coins_per_utxo_size),
    coins_per_utxo_word: str(row.coins_per_utxo_size),
    cost_models: { PlutusV1: v1, PlutusV2: v2, PlutusV3: v3 },
    cost_models_raw: { PlutusV1: v1, PlutusV2: v2, PlutusV3: v3 },
    min_fee_ref_script_cost_per_byte: num(row.min_fee_ref_script_cost_per_byte),
    drep_deposit: str(row.drep_deposit),
    drep_activity: num(row.drep_activity),
    gov_action_deposit: str(row.gov_action_deposit),
    gov_action_lifetime: num(row.gov_action_lifetime),
    source: "koios-live",
  };
}

export async function fetchKoiosEpochParams(network: string): Promise<Record<string, unknown>> {
  const url = KOIOS[network] ?? KOIOS.preprod;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Koios epoch_params ${res.status} from ${url}`);
  const rows = (await res.json()) as unknown;
  const row = Array.isArray(rows) ? asRecord(rows[0]) : asRecord(rows);
  if (!row) throw new Error("Koios epoch_params returned no row");
  const mapped = koiosRowToBlockfrostParams(row);
  if (plutusV3Length(mapped) < EXPECTED_PLUTUS_V3_COST_MODEL_LENGTH) {
    throw new Error(
      `Koios PlutusV3 length ${plutusV3Length(mapped)} < ${EXPECTED_PLUTUS_V3_COST_MODEL_LENGTH}`,
    );
  }
  return mapped;
}

/** Return cached params, or fetch+store live Koios params. */
export async function ensureLiveProtocolParams(network: string): Promise<unknown> {
  const existing = await getLatestProtocolParams();
  if (plutusV3Length(existing) >= EXPECTED_PLUTUS_V3_COST_MODEL_LENGTH) return existing;
  const mapped = await fetchKoiosEpochParams(network);
  await populateProtocolParams(mapped);
  return mapped;
}

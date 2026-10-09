import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { toHex } from "@harmoniclabs/uint8array-utils";
/**
 * Local protocol parameters, Shelley → Babbage (Phase 4b).
 *
 * The first Shelley epoch's parameters come from the Shelley genesis. During an
 * epoch, genesis delegates submit update proposals in transaction bodies
 * (`protocolUpdate`); at the boundary a change proposed by at least
 * `updateQuorum` genesis keys for the ending epoch becomes the next epoch's
 * parameters (cardano-ledger PPUP / NEWPP). Records are kept in the
 * Blockfrost-shaped form the rules already read (`epoch_params`).
 *
 * Conway parameter changes are governance actions (Phase 4d); until then a
 * Conway epoch without a local record is fetched externally and reported.
 */
import { sql } from "../sql";
import { ledgerGov, ledgerGovReads, sqlLedgerWrites } from "../ledger/nodeLedgerStore";
import { storeEpochParams } from "./epochParams";
import type { SqlClient } from "../db";
import { logger } from "../utils/logger";
import { costModelsToJson } from "@harmoniclabs/cardano-costmodels-ts";

/** ledger-ts partial ProtocolParameters field → Blockfrost-shaped key + value mapping */
const FIELD_MAP: Record<string, string> = {
    txFeePerByte: "min_fee_a",
    txFeeFixed: "min_fee_b",
    maxBlockBodySize: "max_block_size",
    maxTxSize: "max_tx_size",
    maxBlockHeaderSize: "max_block_header_size",
    stakeAddressDeposit: "key_deposit",
    stakePoolDeposit: "pool_deposit",
    poolRetireMaxEpoch: "e_max",
    stakePoolTargetNum: "n_opt",
    poolPledgeInfluence: "a0",
    monetaryExpansion: "rho",
    treasuryCut: "tau",
    decentralization: "decentralisation_param",
    decentralisation: "decentralisation_param",
    minPoolCost: "min_pool_cost",
    minUtxoValue: "min_utxo",
    utxoCostPerByte: "coins_per_utxo_size",
    maxValueSize: "max_val_size",
    collateralPercentage: "collateral_percent",
    maxCollateralInputs: "max_collateral_inputs",
};

function num(v: any): string | number | null {
    if (v == null) return null;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return v;
    if (typeof v === "string") return v;
    // rationals (CborPositiveRational / Rational): num/den
    const n = v.num ?? v.numerator, d = v.den ?? v.denominator;
    if (n != null && d != null) return Number(n) / Number(d);
    if (typeof v.toString === "function" && /^\d+$/.test(String(v))) return String(v);
    return null;
}

/** Turn a ledger-ts partial ProtocolParameters into Blockfrost-shaped raw keys. */
export function updateToRaw(changes: Record<string, any>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(changes ?? {})) {
        if (value === undefined) continue;
        const key = FIELD_MAP[field];
        if (key) {
            const v = num(value);
            if (v != null) out[key] = v;
            continue;
        }
        switch (field) {
            case "protocolVersion": {
                const major = value?.major ?? value?.[0], minor = value?.minor ?? value?.[1];
                if (major != null) out.protocol_major_ver = Number(major);
                if (minor != null) out.protocol_minor_ver = Number(minor);
                break;
            }
            case "extraEntropy":
                out.extra_entropy = value?.nonce ?? value ?? null;
                break;
            case "costModels":
                try {
                    out.cost_models = costModelsToJson(value);
                } catch {
                    /* keep previous cost models */
                }
                break;
            case "executionUnitPrices": {
                const [mem, step] = Array.isArray(value) ? value : [value?.priceMemory ?? value?.mem, value?.priceSteps ?? value?.step];
                const pm = num(mem), ps = num(step);
                if (pm != null) out.price_mem = Number(pm);
                if (ps != null) out.price_step = Number(ps);
                break;
            }
            case "maxTxExecutionUnits":
                if (value?.mem != null) out.max_tx_ex_mem = String(value.mem);
                if ((value?.cpu ?? value?.steps) != null) out.max_tx_ex_steps = String(value.cpu ?? value.steps);
                break;
            case "maxBlockExecutionUnits":
                if (value?.mem != null) out.max_block_ex_mem = String(value.mem);
                if ((value?.cpu ?? value?.steps) != null) out.max_block_ex_steps = String(value.cpu ?? value.steps);
                break;
            default:
                break;
        }
    }
    return out;
}

export async function ensurePParamsTables(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS pparam_proposals (
        epoch INTEGER NOT NULL,
        genesis_key TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        slot INTEGER NOT NULL,
        PRIMARY KEY (epoch, genesis_key)
    )`;
}

/** Record a Shelley…Babbage update proposal (`[ {genesisHash → changes}, epoch ]`); a later proposal by the same key replaces the earlier. */
export async function recordUpdateProposal(db: SqlClient, proposal: any, slot: number, bodyBytes?: Uint8Array | null, protocolMajor = 0): Promise<number> {
    if (!Array.isArray(proposal) || proposal.length < 2) return 0;
    const [entries, epoch] = proposal as [any[], any];
    const fromBytes = bodyBytes ? updateProposalsFromBodyBytes(bodyBytes, protocolMajor) : null;
    let n = 0;
    for (const e of entries ?? []) {
        const gk = String(e?.genesisHash?.toString?.() ?? e?.genesisHash ?? "").toLowerCase();
        if (!gk) continue;
        const raw = fromBytes?.entries.get(gk) ?? updateToRaw(e?.changes ?? {});
        ledgerGov()?.putPParamProposal(Number(epoch), gk, canonicalJson(raw), slot);
        if (sqlLedgerWrites()) await db`INSERT OR REPLACE INTO pparam_proposals (epoch, genesis_key, changes_json, slot) VALUES (${Number(epoch)}, ${gk}, ${canonicalJson(raw)}, ${slot})`;
        n++;
    }
    return n;
}

/** Changes that reached the quorum among proposals for `epoch`, merged in key order; null when none. */
export async function quorumUpdateFor(epoch: number, quorum: number): Promise<Record<string, unknown> | null> {
    const gr = ledgerGovReads();
    let rows: unknown[][];
    if (gr) { const counts = new Map<string, number>(); for (const r of gr.pparamProposals(epoch)) counts.set(r.changes, (counts.get(r.changes) ?? 0) + 1); rows = [...counts].map(([c, n]) => [c, n]); }
    else rows = (await sql`SELECT changes_json, COUNT(*) FROM pparam_proposals WHERE epoch = ${epoch} GROUP BY changes_json`.values()) as unknown[][];
    let merged: Record<string, unknown> | null = null;
    for (const r of rows) {
        if (Number(r[1]) >= quorum) {
            const c = JSON.parse(String(r[0])) as Record<string, unknown>;
            merged = { ...(merged ?? {}), ...c };
        }
    }
    return merged;
}

/**
 * Parameters for `epoch` derived from `epoch − 1` plus any quorum update that
 * targeted `epoch − 1`. Returns the new raw record, or null when the previous
 * epoch is unknown locally.
 */
export async function deriveNextEpochParams(prev: Record<string, unknown>, epoch: number, quorum: number): Promise<{ raw: Record<string, unknown>; changed: string[] }> {
    const update = await quorumUpdateFor(epoch - 1, quorum);
    const raw = { ...prev, epoch, source: "local" };
    if (!update) return { raw, changed: [] };
    Object.assign(raw, update);
    logger.info(`Protocol parameters for epoch ${epoch}: quorum update applied (${Object.keys(update).join(", ")})`);
    return { raw, changed: Object.keys(update) };
}

export interface EraGenesisFiles {
    alonzo?: string | null;
    conway?: string | null;
    /** Dijkstra genesis (`DijkstraGenesisFile`), read only when the ledger crosses into protocol 12. */
    dijkstra?: string | null;
}

/** Genesis file paths: explicit config keys, else siblings of the Shelley genesis file. */
export function eraGenesisFilesFor(config: any): EraGenesisFiles {
    const shelley = String(config?.shelleyGenesisFile ?? "");
    const dir = shelley ? shelley.slice(0, shelley.lastIndexOf("/") + 1) : "";
    return {
        alonzo: config?.alonzoGenesisFile ?? (dir ? `${dir}alonzo-genesis.json` : null),
        conway: config?.conwayGenesisFile ?? (dir ? `${dir}conway-genesis.json` : null),
        dijkstra: config?.dijkstraGenesisFile ?? config?.DijkstraGenesisFile ?? (dir ? `${dir}dijkstra-genesis.json` : null),
    };
}

function ratio(v: any): number | null {
    if (v == null) return null;
    if (typeof v === "number") return v;
    const n = v.numerator ?? v.num, d = v.denominator ?? v.den;
    return n != null && d != null ? Number(n) / Number(d) : null;
}

/** Blockfrost-shaped keys introduced by the Alonzo genesis. */
export function alonzoGenesisRaw(g: any): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (g.lovelacePerUTxOWord != null) {
        out.coins_per_utxo_word = String(g.lovelacePerUTxOWord);
        out.coins_per_utxo_size = String(g.lovelacePerUTxOWord); // Blockfrost/Koios carry the per-word value here in Alonzo
    }
    out.min_utxo = "0"; // minUTxOValue is gone from Alonzo on (per-word pricing replaces it)
    const pm = ratio(g.executionPrices?.prMem), ps = ratio(g.executionPrices?.prSteps);
    if (pm != null) out.price_mem = pm;
    if (ps != null) out.price_step = ps;
    if (g.maxTxExUnits) {
        out.max_tx_ex_mem = String(g.maxTxExUnits.exUnitsMem);
        out.max_tx_ex_steps = String(g.maxTxExUnits.exUnitsSteps);
    }
    if (g.maxBlockExUnits) {
        out.max_block_ex_mem = String(g.maxBlockExUnits.exUnitsMem);
        out.max_block_ex_steps = String(g.maxBlockExUnits.exUnitsSteps);
    }
    if (g.maxValueSize != null) out.max_val_size = String(g.maxValueSize);
    if (g.collateralPercentage != null) out.collateral_percent = Number(g.collateralPercentage);
    if (g.maxCollateralInputs != null) out.max_collateral_inputs = Number(g.maxCollateralInputs);
    if (g.costModels) out.cost_models = { ...g.costModels };
    return out;
}

/** Blockfrost-shaped keys introduced by the Conway genesis. */
export function conwayGenesisRaw(g: any, prevCostModels: any): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const pv = g.poolVotingThresholds ?? {}, dv = g.dRepVotingThresholds ?? {};
    const set = (k: string, v: any) => { if (v != null) out[k] = typeof v === "object" ? ratio(v) : v; };
    set("pvt_motion_no_confidence", pv.motionNoConfidence);
    set("pvt_committee_normal", pv.committeeNormal);
    set("pvt_committee_no_confidence", pv.committeeNoConfidence);
    set("pvt_hard_fork_initiation", pv.hardForkInitiation);
    set("pvt_p_p_security_group", pv.ppSecurityGroup);
    set("dvt_motion_no_confidence", dv.motionNoConfidence);
    set("dvt_committee_normal", dv.committeeNormal);
    set("dvt_committee_no_confidence", dv.committeeNoConfidence);
    set("dvt_update_to_constitution", dv.updateToConstitution);
    set("dvt_hard_fork_initiation", dv.hardForkInitiation);
    set("dvt_p_p_network_group", dv.ppNetworkGroup);
    set("dvt_p_p_economic_group", dv.ppEconomicGroup);
    set("dvt_p_p_technical_group", dv.ppTechnicalGroup);
    set("dvt_p_p_gov_group", dv.ppGovGroup);
    set("dvt_treasury_withdrawal", dv.treasuryWithdrawal);
    set("committee_min_size", g.committeeMinSize);
    set("committee_max_term_length", g.committeeMaxTermLength);
    set("gov_action_lifetime", g.govActionLifetime);
    if (g.govActionDeposit != null) out.gov_action_deposit = String(g.govActionDeposit);
    if (g.dRepDeposit != null) out.drep_deposit = String(g.dRepDeposit);
    set("drep_activity", g.dRepActivity);
    set("min_fee_ref_script_cost_per_byte", g.minFeeRefScriptCostPerByte);
    if (g.plutusV3CostModel) out.cost_models = { ...(prevCostModels ?? {}), PlutusV3: g.plutusV3CostModel };
    return out;
}

/**
 * Keys introduced by the Dijkstra genesis (`UpgradeDijkstraPParams`, cardano-ledger eras/dijkstra
 * PParams.hs; bug 430). Rationals are kept as exact "n/d" strings when the file gives a fraction,
 * as decimals otherwise. Missing keys (an older genesis such as cardano-node 11's built-in one,
 * which only has the four reference-script fields) are simply absent.
 */
export function dijkstraGenesisRaw(g: any, prevCostModels: any): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const exact = (v: any): unknown => v == null ? null : typeof v === "object" && (v.numerator ?? v.num) != null ? `${v.numerator ?? v.num}/${v.denominator ?? v.den}` : v;
    const set = (k: string, v: any) => { if (v !== undefined) out[k] = exact(v); };
    set("max_ref_script_size_per_block", g.maxRefScriptSizePerBlock);
    set("max_ref_script_size_per_tx", g.maxRefScriptSizePerTx);
    set("ref_script_cost_stride", g.refScriptCostStride);
    set("ref_script_cost_multiplier", g.refScriptCostMultiplier);
    set("max_pledge_leverage", g.maxPledgeLeverage);
    set("min_pool_margin", g.minPoolMargin);
    set("leios_announcement_period_ms", g.leiosAnnouncementPeriodLength);
    set("leios_vote_period_ms", g.leiosVotePeriodLength);
    set("leios_diffusion_period_ms", g.leiosDiffusionPeriodLength);
    set("leios_committee_size", g.leiosCommitteeSize);
    set("leios_quorum_stake_threshold", g.leiosQuorumStakeThreshold);
    set("max_eb_references_size", g.maxEndorserBlockReferencesSize);
    set("max_eb_txs_size", g.maxEndorserBlockTxsSize);
    if (g.maxEndorserBlockExecutionUnits) {
        out.max_eb_ex_mem = String(g.maxEndorserBlockExecutionUnits.memory ?? g.maxEndorserBlockExecutionUnits.exUnitsMem);
        out.max_eb_ex_steps = String(g.maxEndorserBlockExecutionUnits.steps ?? g.maxEndorserBlockExecutionUnits.exUnitsSteps);
    }
    set("max_ref_script_size_per_eb", g.maxRefScriptSizePerEndorserBlock);
    set("peras_min_candidate_block_age", g.perasMinCandidateBlockAge);
    set("peras_healing_factor", g.perasHealingFactor);
    set("peras_cert_boost", g.perasCertBoost);
    set("peras_target_committee_size", g.perasTargetCommitteeSize);
    set("peras_bootstrap_round", g.perasBootstrapRound);
    set("peras_quorum_threshold_safety_margin", g.perasQuorumThresholdSafetyMargin);
    set("ref_inputs_cost_per_multi_asset_policy", g.refInputsCostPerMultiAssetPolicy);
    set("ref_inputs_cost_per_datum_byte", g.refInputsCostPerDatumByte);
    if (g.plutusV4CostModel) out.cost_models = { ...(prevCostModels ?? {}), PlutusV4: g.plutusV4CostModel };
    return out;
}

/**
 * Hard-fork parameter introductions: when the protocol major version crosses
 * into Alonzo (5), Babbage (7) or Conway (9) the new era's genesis supplies
 * the parameters that no update proposal carries. Explicit values already in
 * `raw` (from the same update proposal) win.
 */
export async function applyEraGenesis(raw: Record<string, unknown>, prevMajor: number, files: EraGenesisFiles): Promise<string[]> {
    const major = Number(raw.protocol_major_ver ?? prevMajor);
    const merged: string[] = [];
    const merge = (from: Record<string, unknown>, label: string) => {
        for (const [k, v] of Object.entries(from)) {
            if (k === "cost_models" && raw.cost_models && typeof raw.cost_models === "object") {
                // Genesis fills languages the record lacks; a language the record already carries
                // (an applied update) wins. The other order let the startup repair revert preview's
                // epoch-8 V1 update to the Alonzo genesis model (bug 86, halt at slot 894 594).
                const before = Object.keys(raw.cost_models as object).length;
                raw.cost_models = { ...(v as object), ...(raw.cost_models as object) };
                if (Object.keys(raw.cost_models as object).length > before) merged.push(k);
            } else if (raw[k] == null || (k === "min_utxo" && label === "Alonzo")) {
                raw[k] = v;
                merged.push(k);
            }
        }
        if (merged.length) logger.info(`Protocol parameters: ${label} genesis merged (${merged.join(", ")})`);
    };
    if (prevMajor < 5 && major >= 5 && files.alonzo) {
        const g = await Bun.file(files.alonzo).json().catch(() => null);
        if (g) merge(alonzoGenesisRaw(g), "Alonzo");
    }
    if (prevMajor < 7 && major >= 7) {
        // Babbage prices UTxO entries per byte: coinsPerUTxOByte = coinsPerUTxOWord div 8
        const carriedAlonzo = raw.coins_per_utxo_size == null || String(raw.coins_per_utxo_size) === String(raw.coins_per_utxo_word);
        if (carriedAlonzo && raw.coins_per_utxo_word != null) {
            raw.coins_per_utxo_size = String(BigInt(String(raw.coins_per_utxo_word)) / 8n);
            merged.push("coins_per_utxo_size");
        }
        // Blockfrost convention for Babbage+: the per-byte price is reported under all
        // three names (the per-word and min-UTxO fields no longer exist in the ledger).
        raw.coins_per_utxo_word = raw.coins_per_utxo_size;
        raw.min_utxo = raw.coins_per_utxo_size;
        raw.decentralisation_param = 0;
        raw.extra_entropy = null;
    }
    if (prevMajor < 9 && major >= 9 && files.conway) {
        const g = await Bun.file(files.conway).json().catch(() => null);
        if (g) merge(conwayGenesisRaw(g, raw.cost_models), "Conway");
    }
    if (prevMajor < 12 && major >= 12 && files.dijkstra) {
        const g = await Bun.file(files.dijkstra).json().catch(() => null);
        if (g) merge(dijkstraGenesisRaw(g, raw.cost_models), "Dijkstra");
    }
    return merged;
}

/** Keys whose values differ between two raw records (numeric strings compared as numbers, cost models ignored). */
export function diffRawParams(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
    const skip = new Set(["epoch", "source", "nonce", "cost_models", "cost_models_raw", "block_id", "extra_entropy"]);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: string[] = [];
    for (const k of keys) {
        if (skip.has(k)) continue;
        const x = a[k], y = b[k];
        if (x == null && y == null) continue;
        const nx = Number(x), ny = Number(y);
        if (Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== "") {
            if (Math.abs(nx - ny) > 1e-9 * Math.max(1, Math.abs(nx))) out.push(`${k}: local ${x} vs external ${y}`);
        } else if (String(x ?? "") !== String(y ?? "")) out.push(`${k}: local ${x} vs external ${y}`);
    }
    return out;
}

/**
 * Records derived before the era-genesis merges existed lack the Alonzo /
 * Conway parameters (cost models, execution prices, collateral, governance).
 * Re-merge them in place once at startup; values already present are kept.
 */
export async function repairLocalEpochParams(files: EraGenesisFiles, shelleyGenesis?: any): Promise<number> {
    if (!sqlLedgerWrites()) return 0; // SQLite rows only; the LMDB store's records are written complete
    const rows = (await sql`SELECT epoch, params FROM epoch_params WHERE source IN ('local', 'genesis') ORDER BY epoch`.values()) as unknown[][];
    const spp = shelleyGenesis?.protocolParams ?? {};
    const shelleyKeys: Array<[string, string]> = [["e_max", "eMax"], ["n_opt", "nOpt"], ["a0", "a0"], ["rho", "rho"], ["tau", "tau"], ["min_pool_cost", "minPoolCost"]];
    let fixed = 0;
    for (const r of rows) {
        const epoch = Number(r[0]);
        let raw: Record<string, unknown>;
        try {
            raw = JSON.parse(String(r[1]));
        } catch {
            continue;
        }
        const major = Number(raw.protocol_major_ver ?? 0);
        let merged: string[] = [];
        for (const [k, gk] of shelleyKeys) {
            if (raw[k] == null && spp[gk] != null) {
                raw[k] = spp[gk];
                merged.push(k);
            }
        }
        const missing = (major >= 5 && (raw.cost_models == null || raw.coins_per_utxo_word == null || raw.price_mem == null))
            || (major >= 9 && raw.gov_action_lifetime == null);
        if (missing) merged = merged.concat(await applyEraGenesis(raw, 0, files));
        if (!merged.length) continue;
        await storeEpochParams(epoch, raw, "local"); // also drops the in-memory cache entry
        fixed++;
    }
    if (fixed) logger.info(`Protocol parameters: ${fixed} local epoch record(s) completed from the era genesis files`);
    return fixed;
}

/**
 * Decode a Shelley…Babbage `protocol_param_update` map straight from the
 * transaction body bytes (body key 6 = `[{genesis_hash: update}, epoch]`),
 * keyed by genesis key hash. ledger-ts's partial decoder drops fields it has no
 * model for (decentralisation, extra entropy), which is how preprod's epoch-5
 * proposal (d := 0) was recorded without its d.
 */
export function updateProposalsFromBodyBytes(bodyBytes: Uint8Array, protocolMajor: number): { epoch: number; entries: Map<string, Record<string, unknown>> } | null {
    let root: any;
    try {
        root = Cbor.parse(bodyBytes);
    } catch {
        return null;
    }
    if (!(root instanceof CborMap)) return null;
    let update: any = null;
    for (const { k, v } of root.map) if (k instanceof CborUInt && Number(k.num) === 6) update = v;
    if (!(update instanceof CborArray) || update.array.length < 2) return null;
    const [proposals, epochObj] = update.array;
    if (!(proposals instanceof CborMap) || !(epochObj instanceof CborUInt)) return null;
    const entries = new Map<string, Record<string, unknown>>();
    for (const { k, v } of proposals.map) {
        if (!(k instanceof CborBytes) || !(v instanceof CborMap)) continue;
        entries.set(toHex(k.bytes).toLowerCase(), updateMapToRaw(v, protocolMajor));
    }
    return { epoch: Number(epochObj.num), entries };
}

function cborNum(v: any): number | null {
    if (v instanceof CborUInt) return Number(v.num);
    if (v instanceof CborNegInt) return Number(v.num);
    return null;
}
function cborBig(v: any): string | null {
    if (v instanceof CborUInt || v instanceof CborNegInt) return String(v.num);
    return null;
}
/** tag 30 [num, den] → decimal number (Blockfrost style). */
function cborRational(v: any): number | null {
    const arr = v instanceof CborTag ? v.data : v;
    if (!(arr instanceof CborArray) || arr.array.length !== 2) return null;
    const n = cborNum(arr.array[0]), d = cborNum(arr.array[1]);
    return n == null || d == null || d === 0 ? null : n / d;
}

/** Blockfrost-shaped keys for one `protocol_param_update` map (Shelley…Babbage key numbering). */
export function updateMapToRaw(m: CborMap, protocolMajor: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const { k, v } of m.map) {
        if (!(k instanceof CborUInt)) continue;
        switch (Number(k.num)) {
            case 0: out.min_fee_a = cborBig(v); break;
            case 1: out.min_fee_b = cborBig(v); break;
            case 2: out.max_block_size = cborNum(v); break;
            case 3: out.max_tx_size = cborNum(v); break;
            case 4: out.max_block_header_size = cborNum(v); break;
            case 5: out.key_deposit = cborBig(v); break;
            case 6: out.pool_deposit = cborBig(v); break;
            case 7: out.e_max = cborNum(v); break;
            case 8: out.n_opt = cborNum(v); break;
            case 9: out.a0 = cborRational(v); break;
            case 10: out.rho = cborRational(v); break;
            case 11: out.tau = cborRational(v); break;
            case 12: out.decentralisation_param = cborRational(v); break;
            case 13: {
                // nonce = [0] (neutral) | [1, bytes]
                const arr = v instanceof CborArray ? v.array : [];
                out.extra_entropy = arr.length >= 2 && arr[1] instanceof CborBytes ? toHex(arr[1].bytes) : null;
                break;
            }
            case 14: {
                const arr = v instanceof CborArray ? v.array : [];
                if (arr.length >= 2) {
                    out.protocol_major_ver = cborNum(arr[0]);
                    out.protocol_minor_ver = cborNum(arr[1]);
                }
                break;
            }
            case 15: out.min_utxo = cborBig(v); break;
            case 16: out.min_pool_cost = cborBig(v); break;
            case 17:
                if (protocolMajor >= 7) out.coins_per_utxo_size = cborBig(v);
                else out.coins_per_utxo_word = cborBig(v);
                break;
            case 18: {
                const cm: Record<string, number[]> = {};
                if (v instanceof CborMap) for (const e of v.map) {
                    const lang = cborNum(e.k);
                    if (lang == null || !(e.v instanceof CborArray)) continue;
                    cm[`PlutusV${lang + 1}`] = e.v.array.map((x: any) => cborNum(x) ?? 0);
                }
                out.cost_models = cm;
                break;
            }
            case 19: {
                const arr = v instanceof CborArray ? v.array : [];
                if (arr.length >= 2) {
                    out.price_mem = cborRational(arr[0]);
                    out.price_step = cborRational(arr[1]);
                }
                break;
            }
            case 20: {
                const arr = v instanceof CborArray ? v.array : [];
                if (arr.length >= 2) { out.max_tx_ex_mem = cborBig(arr[0]); out.max_tx_ex_steps = cborBig(arr[1]); }
                break;
            }
            case 21: {
                const arr = v instanceof CborArray ? v.array : [];
                if (arr.length >= 2) { out.max_block_ex_mem = cborBig(arr[0]); out.max_block_ex_steps = cborBig(arr[1]); }
                break;
            }
            case 22: out.max_val_size = cborBig(v); break;
            case 23: out.collateral_percent = cborNum(v); break;
            case 24: out.max_collateral_inputs = cborNum(v); break;
            default: break;
        }
    }
    for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
    return out;
}

/**
 * Stable JSON for grouping identical proposals: top-level keys sorted. (A
 * `JSON.stringify` replacer array whitelists keys at *every* level and silently
 * emptied the nested cost-model maps of the Vasil proposal.)
 */
export function canonicalJson(raw: Record<string, unknown>): string {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(raw).sort()) sorted[k] = raw[k];
    return JSON.stringify(sorted);
}

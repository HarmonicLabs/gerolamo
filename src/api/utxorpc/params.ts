/**
 * Protocol parameters, genesis and era history as UTxO RPC v1alpha messages.
 *
 * Parameters come from the node's stored record per epoch (the Blockfrost-shaped record the
 * LocalStateQuery `GetCurrentPParams` answer is built from, see `pparamsCbor.ts`). Genesis
 * comes from the network's genesis files; its hash is the Shelley genesis file's blake2b-256
 * (what Dolos returns).
 */
import { readFileSync } from "node:fs";
import { cardano } from "@utxorpc/spec";
import { bigIntMsg, blake256, rationalMsg } from "./mapper";
import type { EraSummary as HfcEraSummary } from "../../consensus/hfc/hfc";

const big = (v: unknown): bigint | undefined => {
    if (v == null || v === "") return undefined;
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : undefined;
    const s = String(v).trim();
    return /^-?\d+$/.test(s) ? BigInt(s) : undefined;
};
const u64 = (v: unknown): bigint => { const b = big(v); return b != null && b >= 0n ? b : 0n; };

/** Cost model values: an array (canonical order) or `cost_models_raw`; named objects keep their stored order. */
function costModel(v: unknown): cardano.CostModel | undefined {
    if (Array.isArray(v)) return new cardano.CostModel({ values: v.map((x) => BigInt.asIntN(64, big(x) ?? 0n)) });
    if (v && typeof v === "object") return new cardano.CostModel({ values: Object.values(v as Record<string, unknown>).map((x) => BigInt.asIntN(64, big(x) ?? 0n)) });
    return undefined;
}

export function costModelsMsg(raw: Record<string, unknown>): cardano.CostModels | undefined {
    const src = (raw.cost_models_raw && typeof raw.cost_models_raw === "object" ? raw.cost_models_raw : raw.cost_models) as Record<string, unknown> | undefined;
    if (!src || typeof src !== "object") return undefined;
    const pick = (lang: number) => costModel(src[`PlutusV${lang}`] ?? src[`plutus:v${lang}`] ?? src[String(lang - 1)]);
    const m = new cardano.CostModels({ plutusV1: pick(1), plutusV2: pick(2), plutusV3: pick(3), plutusV4: pick(4) });
    return m.plutusV1 || m.plutusV2 || m.plutusV3 || m.plutusV4 ? m : undefined;
}

/** The stored parameter record (Blockfrost field names) as `PParams`. */
export function pparamsFromRecord(raw: Record<string, unknown>): cardano.PParams {
    const r = (k: string) => rationalMsg(raw[k]);
    const th = (keys: string[]) => (keys.some((k) => raw[k] != null) ? new cardano.VotingThresholds({ thresholds: keys.map((k) => rationalMsg(raw[k]) ?? new cardano.RationalNumber({ numerator: 0, denominator: 1 })) }) : undefined);
    return new cardano.PParams({
        coinsPerUtxoByte: bigIntMsg(big(raw.coins_per_utxo_size ?? raw.coins_per_utxo_byte)),
        maxTxSize: u64(raw.max_tx_size),
        minFeeCoefficient: bigIntMsg(big(raw.min_fee_a)),
        minFeeConstant: bigIntMsg(big(raw.min_fee_b)),
        maxBlockBodySize: u64(raw.max_block_size),
        maxBlockHeaderSize: u64(raw.max_block_header_size),
        stakeKeyDeposit: bigIntMsg(big(raw.key_deposit)),
        poolDeposit: bigIntMsg(big(raw.pool_deposit)),
        poolRetirementEpochBound: u64(raw.e_max),
        desiredNumberOfPools: u64(raw.n_opt),
        poolInfluence: r("a0"),
        monetaryExpansion: r("rho"),
        treasuryExpansion: r("tau"),
        minPoolCost: bigIntMsg(big(raw.min_pool_cost)),
        protocolVersion: new cardano.ProtocolVersion({ major: Number(u64(raw.protocol_major_ver)), minor: Number(u64(raw.protocol_minor_ver)) }),
        maxValueSize: u64(raw.max_val_size),
        collateralPercentage: u64(raw.collateral_percent),
        maxCollateralInputs: u64(raw.max_collateral_inputs),
        costModels: costModelsMsg(raw),
        prices: raw.price_mem != null || raw.price_step != null ? new cardano.ExPrices({ memory: r("price_mem"), steps: r("price_step") }) : undefined,
        maxExecutionUnitsPerTransaction: raw.max_tx_ex_mem != null ? new cardano.ExUnits({ memory: u64(raw.max_tx_ex_mem), steps: u64(raw.max_tx_ex_steps) }) : undefined,
        maxExecutionUnitsPerBlock: raw.max_block_ex_mem != null ? new cardano.ExUnits({ memory: u64(raw.max_block_ex_mem), steps: u64(raw.max_block_ex_steps) }) : undefined,
        minFeeScriptRefCostPerByte: r("min_fee_ref_script_cost_per_byte"),
        poolVotingThresholds: th(["pvt_motion_no_confidence", "pvt_committee_normal", "pvt_committee_no_confidence", "pvt_hard_fork_initiation", "pvt_p_p_security_group"]),
        drepVotingThresholds: th([
            "dvt_motion_no_confidence", "dvt_committee_normal", "dvt_committee_no_confidence", "dvt_update_to_constitution", "dvt_hard_fork_initiation",
            "dvt_p_p_network_group", "dvt_p_p_economic_group", "dvt_p_p_technical_group", "dvt_p_p_gov_group", "dvt_treasury_withdrawal",
        ]),
        minCommitteeSize: Number(u64(raw.committee_min_size)),
        committeeTermLimit: u64(raw.committee_max_term_length),
        governanceActionValidityPeriod: u64(raw.gov_action_lifetime),
        governanceActionDeposit: bigIntMsg(big(raw.gov_action_deposit)),
        drepDeposit: bigIntMsg(big(raw.drep_deposit)),
        drepInactivityPeriod: u64(raw.drep_activity),
    });
}

// ---------------------------------------------------------------- genesis

export interface GenesisFiles {
    byron?: string | null;
    shelley?: string | null;
    alonzo?: string | null;
    conway?: string | null;
}

const readJson = (p: string | null | undefined): { json: any; bytes: Uint8Array } | null => {
    if (!p) return null;
    try { const bytes = new Uint8Array(readFileSync(p)); return { json: JSON.parse(new TextDecoder().decode(bytes)), bytes }; } catch { return null; }
};

/** CAIP-2 chain id: cardano:mainnet / preprod / preview, else cardano:<magic>. */
export function caip2(networkMagic: number): string {
    return networkMagic === 764824073 ? "cardano:mainnet" : networkMagic === 1 ? "cardano:preprod" : networkMagic === 2 ? "cardano:preview" : `cardano:${networkMagic}`;
}

const strMap = (o: unknown): Record<string, string> => Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));

/** The genesis hash (Shelley genesis file, blake2b-256), the CAIP-2 id and the `Genesis` message. */
export function genesisMsg(files: GenesisFiles): { hash: Uint8Array; caip2: string; genesis: cardano.Genesis } {
    const by = readJson(files.byron)?.json ?? {};
    const sh = readJson(files.shelley);
    const s = sh?.json ?? {};
    const al = readJson(files.alonzo)?.json ?? {};
    const co = readJson(files.conway)?.json ?? {};
    const bvd = by.blockVersionData ?? {};
    const pp = s.protocolParams ?? {};
    const exUnits = (o: any) => (o ? new cardano.ExUnits({ memory: u64(o.exUnitsMem ?? o.memory), steps: u64(o.exUnitsSteps ?? o.steps) }) : undefined);
    const prices = al.executionPrices ? new cardano.ExPrices({ memory: priceOf(al.executionPrices.prMem), steps: priceOf(al.executionPrices.prSteps) }) : undefined;
    const alonzoCm = al.costModels ?? {};
    const cm = new cardano.CostModelMap({ plutusV1: costModel(alonzoCm.PlutusV1), plutusV2: costModel(alonzoCm.PlutusV2), plutusV3: costModel(co.plutusV3CostModel) });
    const pvt = co.poolVotingThresholds ?? {}, dvt = co.dRepVotingThresholds ?? {};
    const magic = Number(s.networkMagic ?? by.protocolConsts?.protocolMagic ?? 0);
    const committeeThreshold = co.committee?.threshold;
    const genesis = new cardano.Genesis({
        avvmDistr: strMap(by.avvmDistr),
        blockVersionData: by.blockVersionData ? new cardano.BlockVersionData({
            scriptVersion: Number(bvd.scriptVersion ?? 0), slotDuration: String(bvd.slotDuration ?? ""), maxBlockSize: String(bvd.maxBlockSize ?? ""),
            maxHeaderSize: String(bvd.maxHeaderSize ?? ""), maxTxSize: String(bvd.maxTxSize ?? ""), maxProposalSize: String(bvd.maxProposalSize ?? ""),
            mpcThd: String(bvd.mpcThd ?? ""), heavyDelThd: String(bvd.heavyDelThd ?? ""), updateVoteThd: String(bvd.updateVoteThd ?? ""),
            updateProposalThd: String(bvd.updateProposalThd ?? ""), updateImplicit: String(bvd.updateImplicit ?? ""),
            softforkRule: bvd.softforkRule ? new cardano.SoftforkRule({ initThd: String(bvd.softforkRule.initThd), minThd: String(bvd.softforkRule.minThd), thdDecrement: String(bvd.softforkRule.thdDecrement) }) : undefined,
            txFeePolicy: bvd.txFeePolicy ? new cardano.TxFeePolicy({ multiplier: String(bvd.txFeePolicy.multiplier), summand: String(bvd.txFeePolicy.summand) }) : undefined,
            unlockStakeEpoch: String(bvd.unlockStakeEpoch ?? ""),
        }) : undefined,
        ftsSeed: String(by.ftsSeed ?? ""),
        protocolConsts: by.protocolConsts ? new cardano.ProtocolConsts({ k: Number(by.protocolConsts.k ?? 0), protocolMagic: Number(by.protocolConsts.protocolMagic ?? 0), vssMaxTtl: Number(by.protocolConsts.vssMaxTTL ?? 0), vssMinTtl: Number(by.protocolConsts.vssMinTTL ?? 0) }) : undefined,
        startTime: u64(by.startTime),
        bootStakeholders: Object.fromEntries(Object.entries(by.bootStakeholders ?? {}).map(([k, v]) => [k, u64(v)])),
        heavyDelegation: Object.fromEntries(Object.entries(by.heavyDelegation ?? {}).map(([k, v]: [string, any]) => [k, new cardano.HeavyDelegation({ cert: String(v?.cert ?? ""), delegatePk: String(v?.delegatePk ?? ""), issuerPk: String(v?.issuerPk ?? ""), omega: Number(v?.omega ?? 0) })])),
        nonAvvmBalances: strMap(by.nonAvvmBalances),
        vssCerts: Object.fromEntries(Object.entries(by.vssCerts ?? {}).map(([k, v]: [string, any]) => [k, new cardano.VssCert({ expiryEpoch: Number(v?.expiryEpoch ?? 0), signature: String(v?.signature ?? ""), signingKey: String(v?.signingKey ?? ""), vssKey: String(v?.vssKey ?? "") })])),
        activeSlotsCoeff: rationalMsg(s.activeSlotsCoeff),
        epochLength: Number(s.epochLength ?? 0),
        genDelegs: Object.fromEntries(Object.entries(s.genDelegs ?? {}).map(([k, v]: [string, any]) => [k, new cardano.GenDelegs({ delegate: String(v?.delegate ?? ""), vrf: String(v?.vrf ?? "") })])),
        initialFunds: Object.fromEntries(Object.entries(s.initialFunds ?? {}).map(([k, v]) => [k, bigIntMsg(u64(v))!])),
        maxKesEvolutions: Number(s.maxKESEvolutions ?? 0),
        maxLovelaceSupply: bigIntMsg(big(s.maxLovelaceSupply)),
        networkId: String(s.networkId ?? ""),
        networkMagic: magic,
        protocolParams: new cardano.PParams({
            maxTxSize: u64(pp.maxTxSize), minFeeCoefficient: bigIntMsg(big(pp.minFeeA)), minFeeConstant: bigIntMsg(big(pp.minFeeB)),
            maxBlockBodySize: u64(pp.maxBlockBodySize), maxBlockHeaderSize: u64(pp.maxBlockHeaderSize), stakeKeyDeposit: bigIntMsg(big(pp.keyDeposit)),
            poolDeposit: bigIntMsg(big(pp.poolDeposit)), poolRetirementEpochBound: u64(pp.eMax), desiredNumberOfPools: u64(pp.nOpt),
            poolInfluence: rationalMsg(pp.a0), monetaryExpansion: rationalMsg(pp.rho), treasuryExpansion: rationalMsg(pp.tau), minPoolCost: bigIntMsg(big(pp.minPoolCost)),
            protocolVersion: pp.protocolVersion ? new cardano.ProtocolVersion({ major: Number(pp.protocolVersion.major ?? 0), minor: Number(pp.protocolVersion.minor ?? 0) }) : undefined,
            coinsPerUtxoByte: bigIntMsg(big(al.lovelacePerUTxOWord)), maxValueSize: u64(al.maxValueSize), collateralPercentage: u64(al.collateralPercentage),
            maxCollateralInputs: u64(al.maxCollateralInputs), prices, maxExecutionUnitsPerTransaction: exUnits(al.maxTxExUnits), maxExecutionUnitsPerBlock: exUnits(al.maxBlockExUnits),
            costModels: new cardano.CostModels({ plutusV1: cm.plutusV1, plutusV2: cm.plutusV2, plutusV3: cm.plutusV3 }),
            minFeeScriptRefCostPerByte: rationalMsg(co.minFeeRefScriptCostPerByte),
            poolVotingThresholds: co.poolVotingThresholds ? new cardano.VotingThresholds({ thresholds: [pvt.motionNoConfidence, pvt.committeeNormal, pvt.committeeNoConfidence, pvt.hardForkInitiation, pvt.ppSecurityGroup].map((x) => rationalMsg(x)!) }) : undefined,
            drepVotingThresholds: co.dRepVotingThresholds ? new cardano.VotingThresholds({ thresholds: [dvt.motionNoConfidence, dvt.committeeNormal, dvt.committeeNoConfidence, dvt.updateToConstitution, dvt.hardForkInitiation, dvt.ppNetworkGroup, dvt.ppEconomicGroup, dvt.ppTechnicalGroup, dvt.ppGovGroup, dvt.treasuryWithdrawal].map((x) => rationalMsg(x)!) }) : undefined,
            minCommitteeSize: Number(co.committeeMinSize ?? 0), committeeTermLimit: u64(co.committeeMaxTermLength), governanceActionValidityPeriod: u64(co.govActionLifetime),
            governanceActionDeposit: bigIntMsg(big(co.govActionDeposit)), drepDeposit: bigIntMsg(big(co.dRepDeposit)), drepInactivityPeriod: u64(co.dRepActivity),
        }),
        securityParam: Number(s.securityParam ?? 0),
        slotLength: Number(s.slotLength ?? 0),
        slotsPerKesPeriod: Number(s.slotsPerKESPeriod ?? 0),
        systemStart: String(s.systemStart ?? ""),
        updateQuorum: Number(s.updateQuorum ?? 0),
        lovelacePerUtxoWord: bigIntMsg(big(al.lovelacePerUTxOWord)),
        executionPrices: prices,
        maxTxExUnits: exUnits(al.maxTxExUnits),
        maxBlockExUnits: exUnits(al.maxBlockExUnits),
        maxValueSize: Number(al.maxValueSize ?? 0),
        collateralPercentage: Number(al.collateralPercentage ?? 0),
        maxCollateralInputs: Number(al.maxCollateralInputs ?? 0),
        costModels: cm,
        committee: co.committee ? new cardano.Committee({
            members: Object.fromEntries(Object.entries(co.committee.members ?? {}).map(([k, v]) => [k, u64(v)])),
            threshold: committeeThreshold && typeof committeeThreshold === "object" ? new cardano.RationalNumber({ numerator: Number(committeeThreshold.numerator ?? 0), denominator: Number(committeeThreshold.denominator ?? 1) }) : rationalMsg(committeeThreshold),
        }) : undefined,
        constitution: co.constitution ? new cardano.Constitution({
            anchor: new cardano.Anchor({ url: String(co.constitution.anchor?.url ?? ""), contentHash: hexBytes(co.constitution.anchor?.dataHash) }),
            hash: hexBytes(co.constitution.script),
        }) : undefined,
        committeeMinSize: u64(co.committeeMinSize),
        committeeMaxTermLength: u64(co.committeeMaxTermLength),
        govActionLifetime: u64(co.govActionLifetime),
        govActionDeposit: bigIntMsg(big(co.govActionDeposit)),
        drepDeposit: bigIntMsg(big(co.dRepDeposit)),
        drepActivity: u64(co.dRepActivity),
        minFeeRefScriptCostPerByte: rationalMsg(co.minFeeRefScriptCostPerByte),
        drepVotingThresholds: co.dRepVotingThresholds ? new cardano.DRepVotingThresholds({
            motionNoConfidence: rationalMsg(dvt.motionNoConfidence), committeeNormal: rationalMsg(dvt.committeeNormal), committeeNoConfidence: rationalMsg(dvt.committeeNoConfidence),
            updateToConstitution: rationalMsg(dvt.updateToConstitution), hardForkInitiation: rationalMsg(dvt.hardForkInitiation), ppNetworkGroup: rationalMsg(dvt.ppNetworkGroup),
            ppEconomicGroup: rationalMsg(dvt.ppEconomicGroup), ppTechnicalGroup: rationalMsg(dvt.ppTechnicalGroup), ppGovGroup: rationalMsg(dvt.ppGovGroup), treasuryWithdrawal: rationalMsg(dvt.treasuryWithdrawal),
        }) : undefined,
        poolVotingThresholds: co.poolVotingThresholds ? new cardano.PoolVotingThresholds({
            motionNoConfidence: rationalMsg(pvt.motionNoConfidence), committeeNormal: rationalMsg(pvt.committeeNormal), committeeNoConfidence: rationalMsg(pvt.committeeNoConfidence),
            hardForkInitiation: rationalMsg(pvt.hardForkInitiation), ppSecurityGroup: rationalMsg(pvt.ppSecurityGroup),
        }) : undefined,
    });
    return { hash: sh ? blake256(sh.bytes) : new Uint8Array(0), caip2: caip2(magic), genesis };
}

function hexBytes(h: unknown): Uint8Array<ArrayBuffer> | undefined {
    return typeof h === "string" && /^[0-9a-fA-F]*$/.test(h) && h.length % 2 === 0 && h.length ? (new Uint8Array(Buffer.from(h, "hex")) as Uint8Array<ArrayBuffer>) : undefined;
}

/** Alonzo genesis prices: a decimal, or `{ numerator, denominator }`. */
function priceOf(v: unknown): cardano.RationalNumber | undefined {
    if (v && typeof v === "object" && "numerator" in (v as any)) return new cardano.RationalNumber({ numerator: Number((v as any).numerator), denominator: Number((v as any).denominator) });
    return rationalMsg(v);
}

// ---------------------------------------------------------------- era summaries

const ERA_NAMES = ["byron", "shelley", "allegra", "mary", "alonzo", "babbage", "conway", "dijkstra"];

/**
 * The hard-fork history as `EraSummary` messages: boundary times in Unix ms (system start plus the
 * consensus picoseconds / 10⁹, like Dolos and Dingo), the current era carrying the active parameters.
 */
export function eraSummariesMsg(summary: HfcEraSummary[], systemStartMs: bigint, currentParams: cardano.PParams | undefined): cardano.EraSummaries {
    const bound = (b: { timePicos: bigint; slot: bigint; epoch: bigint }) => new cardano.EraBoundary({ time: systemStartMs + b.timePicos / 1_000_000_000n, slot: b.slot, epoch: b.epoch });
    return new cardano.EraSummaries({
        summaries: summary.map((e, i) => new cardano.EraSummary({
            name: ERA_NAMES[i] ?? `era${i}`,
            start: bound(e.start),
            end: e.end ? bound(e.end) : undefined,
            protocolParams: i === summary.length - 1 ? currentParams : undefined,
        })),
    });
}

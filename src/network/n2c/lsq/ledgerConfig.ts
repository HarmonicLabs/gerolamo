/**
 * `DebugLedgerConfig` (top-level query [4], QueryVersion3): the hard-fork combinator's ledger config as
 * cardano-node 11.0.1 encodes it (ouroboros-consensus 3.0.1 `SerialiseNodeToClient` for
 * `HardForkLedgerConfig`, `ShelleyPartialLedgerConfig`, `ByronPartialLedgerConfig`, `TriggerHardFork`;
 * cardano-ledger-byron `Genesis.Config` / `GenesisData`; the eras' genesis `EncCBOR`). A function of the
 * network's genesis files and its node config's hard-fork triggers only:
 *   [[EraParams × 8], [Byron, Shelley, Allegra, Mary, Alonzo, Babbage, Conway, Dijkstra]]
 *   EraParams      [epoch size, slot length (ms), StandardSafeZone [0, n, [0]], genesis window]
 *   Byron          [[GenesisData, genesis hash, RequiresNetworkMagic, UTxOConfiguration], trigger]
 *   GenesisData    [[{boot stakeholders}], [{stakeholder → [epoch, issuer, delegate, signature]}], start time,
 *                   [{address → lovelace}], protocol parameters (14), k, protocol magic, [{AVVM key → lovelace}]]
 *   Shelley-based  [CompactGenesis (GetGenesisConfig), slotsPerKESPeriod, 3k/f, 4k/f, k, maxKESEvolutions,
 *                   updateQuorum, maxLovelaceSupply, f, network, system start, translation context, trigger]
 *   contexts       Shelley [genDelegs, genesis parameters, maxLovelaceSupply]; Alonzo AlonzoGenesis;
 *                   Conway ConwayGenesis; Dijkstra the built-in DijkstraGenesis; the others none (null)
 *   trigger        [0, major] at a protocol version | [1, epoch] at an epoch | [2] not during this execution
 * Verified byte-identical with the preview relay (bug 265). Preview's config moves Shelley…Alonzo to
 * epoch 0 (`Test*HardForkAtEpoch`); preprod and mainnet follow the protocol versions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cbor, CborArray, CborBytes, CborTag } from "@harmoniclabs/cbor";
import { base58Decode, base64urlDecode } from "../../../consensus/byron/genesisUtxo";
import { PARAM_NAMES_V1 } from "../../../consensus/plutus/paramNames";
import { cborItemLength } from "../../../storage/chunkFormat";
import { experimentalHardForksEnabled } from "../../../consensus/hfc/experimental";
import { encodeUtcTime, type EraHistoryNetwork } from "../eraHistory";
import { toFraction } from "../pparamsCbor";
import { CborWriter, reduced } from "./cborWriter";
import { genesis, genesisConfig, LsqUnanswerable, type QueryEnv } from "./queries";

const BYRON_GENESIS_HASH: Record<EraHistoryNetwork, string> = {
    preview: "83de1d7302569ad56cf9139a41e2e11346d4cb4a31c00142557b6ab3fa550761",
    preprod: "d4b8de7a11d929a323373cbab6c1a9bdc931beffff11db111cf9d57356ee1937",
    mainnet: "5f20df933584822601f9e3f8c024eb5eb252fe8cefb24d1317dc3d432e940ebb",
};
type Trigger = { atVersion: number } | { atEpoch: number } | "never";
/** The trigger leaving each era: preview's node config moves Shelley, Allegra, Mary and Alonzo to epoch 0. */
function triggers(network: EraHistoryNetwork): Trigger[] {
    const v = [2, 3, 4, 5, 7, 9].map((atVersion) => ({ atVersion }) as Trigger);
    if (network === "preview") for (let i = 0; i < 4; i++) v[i] = { atEpoch: 0 };
    // Conway → Dijkstra only with ExperimentalHardForksEnabled (protocol 12; bug 421)
    return [...v, experimentalHardForksEnabled() ? { atVersion: 12 } : "never", "never"];
}
const wTrigger = (w: CborWriter, t: Trigger) => { if (t === "never") w.array(1).uint(2); else if ("atVersion" in t) w.array(2).uint(0).uint(t.atVersion); else w.array(2).uint(1).uint(t.atEpoch); };
const wRat = (w: CborWriter, v: unknown) => { const [n, d] = toFraction(v); const [rn, rd] = reduced(n, d); w.rational(rn, rd); };

function readGenesis(network: EraHistoryNetwork, era: "byron" | "alonzo"): any {
    return JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "config", network, `${era}-genesis.json`), "utf8"));
}

/** The nine items of the CompactGenesis (GetGenesisConfig's answer), by index. */
function genesisItems(compact: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let p = 1;
    for (let i = 0; i < 15; i++) { const n = cborItemLength(compact, p); out.push(compact.subarray(p, p + n)); p += n; }
    return out;
}

export function debugLedgerConfig(network: EraHistoryNetwork | null, magic: number): Uint8Array {
    if (!network) throw new LsqUnanswerable(`no ledger config for network magic ${magic}`);
    const byron = readGenesis(network, "byron"), sh = genesis(network, "shelley"), alonzo = readGenesis(network, "alonzo"), conway = genesis(network, "conway");
    const k = Number(sh.securityParam), f = toFraction(sh.activeSlotsCoeff);
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    const stability = Number(ceilDiv(3n * BigInt(k) * f[1], f[0])), randomness = Number(ceilDiv(4n * BigInt(k) * f[1], f[0]));
    const byronK = Number(byron.protocolConsts.k);
    const trig = triggers(network);
    const w = new CborWriter(1 << 16);
    w.array(2);
    // Shape
    w.array(8);
    w.array(4).uint(10 * byronK).uint(Number(byron.blockVersionData.slotDuration)).array(3).uint(0).uint(2 * byronK).array(1).uint(0).uint(2 * byronK);
    for (let i = 0; i < 7; i++) w.array(4).uint(Number(sh.epochLength)).uint(Math.round(Number(sh.slotLength) * 1000)).array(3).uint(0).uint(stability).array(1).uint(0).uint(stability);
    // PerEraLedgerConfig
    w.array(8);
    w.array(2);
    writeByronConfig(w, network, byron);
    wTrigger(w, trig[0]!);
    const compact = genesisConfig({ network, magic } satisfies QueryEnv);
    const items = genesisItems(compact);
    const systemStart = Cbor.encode(encodeUtcTime(sh.systemStart)).toBuffer();
    for (let era = 1; era <= 7; era++) {
        w.array(13).raw(compact).uint(sh.slotsPerKESPeriod).uint(stability).uint(randomness).uint(k).uint(sh.maxKESEvolutions).uint(sh.updateQuorum).uint(BigInt(sh.maxLovelaceSupply));
        w.rational(...reduced(f[0], f[1])).uint(sh.networkId === "Mainnet" ? 1 : 0).raw(systemStart);
        switch (era) {
            case 1: w.array(3).raw(items[12]!).raw(items[11]!).uint(BigInt(sh.maxLovelaceSupply)); break; // FromByronTranslationContext
            case 4: writeAlonzoGenesis(w, alonzo); break;
            case 6: writeConwayGenesis(w, conway); break;
            case 7: w.array(1).array(4).uint(1_048_576).uint(204_800).uint(25_600).rational(6n, 5n); break; // cardano-node 11's built-in DijkstraGenesis
            default: w.null();
        }
        wTrigger(w, trig[era]!);
    }
    return w.finish();
}

/**
 * cardano-ledger-byron `Genesis.Config`: GenesisData, its hash, RequiresNetworkMagic, UTxOConfiguration
 * (no locked addresses). Byron's encoding version: definite lengths throughout, sets tagged 258.
 */
function writeByronConfig(w: CborWriter, network: EraHistoryNetwork, g: any): void {
    const defMap = <K, V>(xs: ReadonlyArray<readonly [K, V]>, key: (k: K) => void, val: (v: V) => void) => { w.map(xs.length); for (const [k, v] of xs) { key(k); val(v); } };
    w.array(4).array(8);
    w.array(1).setDefinite(Object.keys(g.bootStakeholders ?? {}).map((x) => x.toLowerCase()).sort(), (x) => w.hex(x));
    const heavy = Object.entries((g.heavyDelegation ?? {}) as Record<string, any>).map(([id, c]) => [id.toLowerCase(), c] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    w.array(1); defMap(heavy, (id) => w.hex(id), (c) => { w.array(4).uint(Number(c.omega)).bytes(base64urlDecode(c.issuerPk)).bytes(base64urlDecode(c.delegatePk)).hex(c.cert); });
    w.raw(Cbor.encode(encodeUtcTime(new Date(Number(g.startTime) * 1000).toISOString())).toBuffer());
    // an address's base58 bytes are its CBOR [24(bytes [root, attributes, type]), crc]; `Ord Address` compares the root first
    const rootOf = (a: Uint8Array) => { const inner = (((Cbor.parse(a) as CborArray).array[0] as CborTag).data as CborBytes).bytes; return Buffer.from(((Cbor.parse(inner) as CborArray).array[0] as CborBytes).bytes).toString("hex"); };
    const balances = Object.entries((g.nonAvvmBalances ?? {}) as Record<string, string>).map(([a, v]) => { const b = base58Decode(a); return { a: b, root: rootOf(b), v: BigInt(String(v)) }; }).sort((x, y) => (x.root < y.root ? -1 : x.root > y.root ? 1 : 0));
    w.array(1); defMap(balances.map((b) => [b.a, b.v] as const), (a) => w.raw(a), (v) => w.uint(v));
    const p = g.blockVersionData;
    const U = (x: unknown) => BigInt(String(x));
    w.array(14).uint(U(p.scriptVersion)).uint(U(p.slotDuration)).uint(U(p.maxBlockSize)).uint(U(p.maxHeaderSize)).uint(U(p.maxTxSize)).uint(U(p.maxProposalSize))
        .uint(U(p.mpcThd)).uint(U(p.heavyDelThd)).uint(U(p.updateVoteThd)).uint(U(p.updateProposalThd)).uint(U(p.updateImplicit));
    w.array(3).uint(U(p.softforkRule.initThd)).uint(U(p.softforkRule.minThd)).uint(U(p.softforkRule.thdDecrement));
    const fee = new CborWriter().array(2).uint(U(p.txFeePolicy.summand)).uint(U(p.txFeePolicy.multiplier)).finish();
    w.array(2).uint(0).tag(24).bytes(fee); // TxFeePolicyTxSizeLinear, CBOR-in-CBOR
    w.uint(U(p.unlockStakeEpoch));
    w.uint(Number(g.protocolConsts.k)).uint(Number(g.protocolConsts.protocolMagic));
    const avvm = Object.entries((g.avvmDistr ?? {}) as Record<string, string>).map(([key, v]) => ({ key: base64urlDecode(key), v: BigInt(String(v)) })).sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
    w.array(1); defMap(avvm.map((x) => [x.key, x.v] as const), (key) => w.bytes(key), (v) => w.uint(v));
    w.hex(BYRON_GENESIS_HASH[network]).uint(network === "mainnet" ? 0 : 1).array(1).setDefinite([], () => {});
}

/** `AlonzoGenesis`: coins per UTxO word, the PlutusV1 cost model (parameter order), prices, ex-unit limits, value size, collateral, no extra config. */
function writeAlonzoGenesis(w: CborWriter, g: any): void {
    // the genesis names a few V1 parameters by their Alonzo-era names (blake2b, verifySignature)
    const legacy = (n: string) => n.replace(/^blake2b-/, "blake2b_256-").replace(/^verifySignature-/, "verifyEd25519Signature-");
    const raw = g.costModels?.PlutusV1 ?? {};
    const v1: Record<string, number> = Array.isArray(raw) ? {} : Object.fromEntries(Object.entries(raw as Record<string, number>).map(([n, c]) => [legacy(n), c]));
    const costs: number[] = Array.isArray(raw) ? raw : PARAM_NAMES_V1.filter((n) => n in v1).map((n) => v1[n]!);
    const ratio = (r: any) => (typeof r === "object" && r && "numerator" in r ? `${r.numerator}/${r.denominator}` : r);
    w.array(9).uint(g.lovelacePerUTxOWord ?? g.coinsPerUTxOWord).array(costs.length); // a cost model is a definite list
    for (const c of costs) w.int(c);
    w.array(2); wRat(w, ratio(g.executionPrices.prMem)); wRat(w, ratio(g.executionPrices.prSteps));
    w.array(2).uint(g.maxTxExUnits.exUnitsMem).uint(g.maxTxExUnits.exUnitsSteps).array(2).uint(g.maxBlockExUnits.exUnitsMem).uint(g.maxBlockExUnits.exUnitsSteps);
    w.uint(g.maxValueSize).uint(g.collateralPercentage).uint(g.maxCollateralInputs).array(0);
}

/** `ConwayGenesis`: the upgrade parameters, constitution, committee, initial delegations and DReps. */
function writeConwayGenesis(w: CborWriter, g: any): void {
    const pv = g.poolVotingThresholds, dv = g.dRepVotingThresholds;
    w.array(5).array(10);
    w.array(5); for (const x of [pv.motionNoConfidence, pv.committeeNormal, pv.committeeNoConfidence, pv.hardForkInitiation, pv.ppSecurityGroup]) wRat(w, x);
    w.array(10); for (const x of [dv.motionNoConfidence, dv.committeeNormal, dv.committeeNoConfidence, dv.updateToConstitution, dv.hardForkInitiation, dv.ppNetworkGroup, dv.ppEconomicGroup, dv.ppTechnicalGroup, dv.ppGovGroup, dv.treasuryWithdrawal]) wRat(w, x);
    w.uint(g.committeeMinSize).uint(g.committeeMaxTermLength).uint(g.govActionLifetime).uint(BigInt(g.govActionDeposit)).uint(BigInt(g.dRepDeposit)).uint(g.dRepActivity);
    wRat(w, g.minFeeRefScriptCostPerByte);
    w.array(g.plutusV3CostModel.length); for (const c of g.plutusV3CostModel as number[]) w.int(c);
    const a = g.constitution.anchor;
    w.array(2).array(2).text(a.url).hex(a.dataHash);
    if (g.constitution.script) w.hex(g.constitution.script); else w.null();
    // committee members "keyHash-…" / "scriptHash-…" → expiry, in credential order (script first)
    const members = Object.entries(g.committee?.members ?? {} as Record<string, number>).map(([key, e]) => { const script = key.startsWith("scriptHash-"); return { type: script ? 1 : 0, hash: key.slice(key.indexOf("-") + 1).toLowerCase(), e: Number(e) }; })
        .sort((x, y) => (x.type !== y.type ? y.type - x.type : x.hash < y.hash ? -1 : 1));
    w.array(2).mapOf(members.map((m) => [m, m.e] as const), (m) => w.array(2).uint(m.type).hex(m.hash), (e) => w.uint(e));
    const t = g.committee?.threshold ?? { numerator: 0, denominator: 1 };
    wRat(w, typeof t === "object" ? `${t.numerator}/${t.denominator}` : t);
    if (Object.keys(g.delegs ?? {}).length || Object.keys(g.initialDReps ?? {}).length) throw new LsqUnanswerable("Conway genesis delegations / initial DReps are not encoded");
    w.map(0).map(0);
}

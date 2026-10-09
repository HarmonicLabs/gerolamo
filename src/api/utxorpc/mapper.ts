/**
 * Cardano CBOR → UTxO RPC v1alpha Cardano messages (`utxorpc.v1alpha.cardano`), following
 * pallas-utxorpc's mapper (the reference Dolos serves) field by field:
 *   - inputs, withdrawals and mint are listed in ledger order (sorted), so a redeemer's index
 *     points at the item it belongs to;
 *   - `Redeemer.original_cbor` is `[tag, index, data, ex_units]` (map-form Conway redeemers too);
 *   - `Constr.tag` is the CBOR tag (121…127, 1280…1400, or 102 with `any_constructor`);
 *   - amounts are `BigInt.int` while they fit an int64, else `big_u_int` / `big_n_int` bytes.
 * Byron blocks map to their header and their transactions' inputs and outputs.
 *
 * The reader is the offset-keeping CBOR parser of the Plutus evaluator, so every `original_cbor`
 * and hash is taken over the bytes as carried.
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { cardano } from "@utxorpc/spec";
import { parseCbor, type CNode } from "../../consensus/plutus/cbor";
import { toFraction } from "../../network/n2c/pparamsCbor";

export type Bytes = Uint8Array<ArrayBuffer>;

const INT64_MAX = (1n << 63n) - 1n, INT64_MIN = -(1n << 63n);

export function u8(b: Uint8Array): Bytes {
    // protobuf-es wants Uint8Array<ArrayBuffer>; subarrays of a Buffer pool are copied so the message owns its bytes
    return new Uint8Array(b) as Bytes;
}
export function hexOf(b: Uint8Array): string { return Buffer.from(b).toString("hex"); }
export function fromHexBytes(h: string): Bytes { return new Uint8Array(Buffer.from(h, "hex")) as Bytes; }
export function blake256(b: Uint8Array): Bytes { return u8(blake2b_256(b)); }

function bigBytes(v: bigint): Bytes {
    let h = v.toString(16);
    if (h.length % 2) h = "0" + h;
    return fromHexBytes(h);
}

/** `BigInt` message: int64 when it fits, else the magnitude as big-endian bytes (u: v, n: -1 - v like CBOR tag 3). */
export function bigIntMsg(v: bigint | number | null | undefined): cardano.BigInt | undefined {
    if (v == null) return undefined;
    const x = BigInt(v);
    if (x >= INT64_MIN && x <= INT64_MAX) return new cardano.BigInt({ bigInt: { case: "int", value: x } });
    if (x > 0n) return new cardano.BigInt({ bigInt: { case: "bigUInt", value: bigBytes(x) } });
    return new cardano.BigInt({ bigInt: { case: "bigNInt", value: bigBytes(-1n - x) } });
}

/** The value a `BigInt` message carries (tests, predicates). */
export function bigIntValue(m: cardano.BigInt | undefined): bigint {
    const b = m?.bigInt;
    if (!b || b.case === undefined) return 0n;
    if (b.case === "int") return b.value;
    const mag = BigInt("0x" + (hexOf(b.value) || "0"));
    return b.case === "bigUInt" ? mag : -1n - mag;
}

export function rationalMsg(v: unknown): cardano.RationalNumber | undefined {
    if (v == null || v === "") return undefined;
    try {
        const [n, d] = toFraction(v);
        return new cardano.RationalNumber({ numerator: Number(n), denominator: Number(d) });
    } catch { return undefined; }
}

// ---------------------------------------------------------------- CBOR access helpers

const items = (n: CNode | undefined): CNode[] => {
    if (!n) return [];
    if (n.t === "tag") return items(n.v);
    return n.t === "a" ? n.v : [];
};
const entries = (n: CNode | undefined): Array<[CNode, CNode]> => {
    if (!n) return [];
    if (n.t === "tag") return entries(n.v);
    return n.t === "m" ? n.v : [];
};
const num = (n: CNode | undefined): bigint => (n && (n.t === "u" || n.t === "n") ? n.v : 0n);
const bytes = (n: CNode | undefined): Bytes => (n && n.t === "b" ? u8(n.v) : (new Uint8Array(0) as Bytes));
const text = (n: CNode | undefined): string => (n && n.t === "s" ? n.v : "");
const isNullNode = (n: CNode | undefined) => !n || (n.t === "simple" && (n.v === null || n.v === undefined));
function fieldOf(n: CNode | undefined, k: number): CNode | undefined {
    for (const [key, v] of entries(n)) if (key.t === "u" && key.v === BigInt(k)) return v;
    return undefined;
}
const slice = (src: Uint8Array, n: CNode): Uint8Array => src.subarray(n.s, n.e);
const cmpBytes = (a: Uint8Array, b: Uint8Array): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---------------------------------------------------------------- Plutus data, metadata, scripts

/** Plutus data (any depth); bignums keep their bytes. */
export function plutusData(n: CNode): cardano.PlutusData {
    if (n.t === "tag") {
        const tag = n.tag;
        if ((tag >= 121 && tag <= 127) || (tag >= 1280 && tag <= 1400)) {
            return new cardano.PlutusData({ plutusData: { case: "constr", value: new cardano.Constr({ tag, fields: items(n.v).map(plutusData) }) } });
        }
        if (tag === 102) {
            const [alt, fields] = items(n.v);
            return new cardano.PlutusData({ plutusData: { case: "constr", value: new cardano.Constr({ tag, anyConstructor: num(alt), fields: items(fields).map(plutusData) }) } });
        }
        if (tag === 2 || tag === 3) {
            const b = bytes(n.v);
            return new cardano.PlutusData({ plutusData: { case: "bigInt", value: new cardano.BigInt({ bigInt: { case: tag === 2 ? "bigUInt" : "bigNInt", value: b } }) } });
        }
        return plutusData(n.v);
    }
    switch (n.t) {
        case "u": case "n": return new cardano.PlutusData({ plutusData: { case: "bigInt", value: bigIntMsg(n.v)! } });
        case "b": return new cardano.PlutusData({ plutusData: { case: "boundedBytes", value: u8(n.v) } });
        case "a": return new cardano.PlutusData({ plutusData: { case: "array", value: new cardano.PlutusDataArray({ items: n.v.map(plutusData) }) } });
        case "m": return new cardano.PlutusData({ plutusData: { case: "map", value: new cardano.PlutusDataMap({ pairs: n.v.map(([k, v]) => new cardano.PlutusDataPair({ key: plutusData(k), value: plutusData(v) })) }) } });
        default: return new cardano.PlutusData();
    }
}

export function plutusDataFromBytes(b: Uint8Array): cardano.PlutusData { return plutusData(parseCbor(b)); }

export function metadatum(n: CNode): cardano.Metadatum {
    switch (n.t) {
        case "u": case "n": return new cardano.Metadatum({ metadatum: { case: "int", value: BigInt.asIntN(64, n.v) } });
        case "b": return new cardano.Metadatum({ metadatum: { case: "bytes", value: u8(n.v) } });
        case "s": return new cardano.Metadatum({ metadatum: { case: "text", value: n.v } });
        case "a": return new cardano.Metadatum({ metadatum: { case: "array", value: new cardano.MetadatumArray({ items: n.v.map(metadatum) }) } });
        case "m": return new cardano.Metadatum({ metadatum: { case: "map", value: new cardano.MetadatumMap({ pairs: n.v.map(([k, v]) => new cardano.MetadatumPair({ key: metadatum(k), value: metadatum(v) })) }) } });
        case "tag": return metadatum(n.v);
        default: return new cardano.Metadatum();
    }
}

export function nativeScript(n: CNode): cardano.NativeScript {
    const [kind, a, b] = items(n);
    switch (Number(num(kind))) {
        case 0: return new cardano.NativeScript({ nativeScript: { case: "scriptPubkey", value: bytes(a) } });
        case 1: return new cardano.NativeScript({ nativeScript: { case: "scriptAll", value: new cardano.NativeScriptList({ items: items(a).map(nativeScript) }) } });
        case 2: return new cardano.NativeScript({ nativeScript: { case: "scriptAny", value: new cardano.NativeScriptList({ items: items(a).map(nativeScript) }) } });
        case 3: {
            const k = num(a);
            return new cardano.NativeScript({ nativeScript: { case: "scriptNOfK", value: new cardano.ScriptNOfK({ k: Number(k < 0n ? 0n : k > 0xffffffffn ? 0xffffffffn : k), scripts: items(b).map(nativeScript) }) } });
        }
        case 4: return new cardano.NativeScript({ nativeScript: { case: "invalidBefore", value: num(a) } });
        case 5: return new cardano.NativeScript({ nativeScript: { case: "invalidHereafter", value: num(a) } });
        default: return new cardano.NativeScript();
    }
}

/** `[lang, script]` (a script reference's payload): 0 native, 1–4 Plutus V1–V4 (the flat program's bytestring content). */
export function scriptFromRef(n: CNode): cardano.Script {
    const [lang, body] = items(n);
    switch (Number(num(lang))) {
        case 0: return new cardano.Script({ script: { case: "native", value: nativeScript(body!) } });
        case 1: return new cardano.Script({ script: { case: "plutusV1", value: bytes(body) } });
        case 2: return new cardano.Script({ script: { case: "plutusV2", value: bytes(body) } });
        case 3: return new cardano.Script({ script: { case: "plutusV3", value: bytes(body) } });
        case 4: return new cardano.Script({ script: { case: "plutusV4", value: bytes(body) } });
        default: return new cardano.Script();
    }
}
const plutusScript = (lang: 1 | 2 | 3 | 4, n: CNode) => new cardano.Script({ script: { case: lang === 1 ? "plutusV1" : lang === 2 ? "plutusV2" : lang === 3 ? "plutusV3" : "plutusV4", value: bytes(n) } });

// ---------------------------------------------------------------- values, outputs

export interface MapContext {
    /** Witness datums of the transaction by hash (hex), to fill a datum-hash output's payload. */
    datums?: Map<string, CNode>;
    /** Source bytes the nodes point into. */
    src: Uint8Array;
}

function multiassets(n: CNode | undefined, mint: boolean): cardano.Multiasset[] {
    const out: cardano.Multiasset[] = [];
    const pols = entries(n).slice().sort((x, y) => cmpBytes(bytes(x[0]), bytes(y[0])));
    for (const [policy, assets] of pols) {
        out.push(new cardano.Multiasset({
            policyId: bytes(policy),
            assets: entries(assets).map(([name, q]) => new cardano.Asset({ name: bytes(name), quantity: { case: mint ? "mintCoin" : "outputCoin", value: bigIntMsg(num(q))! } })),
        }));
    }
    return out;
}

function datumMsg(opt: CNode | undefined, legacyHash: CNode | undefined, ctx: MapContext): cardano.Datum | undefined {
    if (legacyHash && legacyHash.t === "b") return datumByHash(legacyHash.v, ctx);
    const [kind, v] = items(opt);
    if (!opt || kind === undefined) return undefined;
    if (num(kind) === 0n) return datumByHash(bytes(v), ctx);
    // inline: #6.24(bytes .cbor plutus_data)
    const inner = v && v.t === "tag" ? v.v : v;
    const raw = bytes(inner);
    if (!raw.length) return undefined;
    let payload: cardano.PlutusData | undefined;
    try { payload = plutusDataFromBytes(raw); } catch { payload = undefined; }
    return new cardano.Datum({ hash: blake256(raw), payload, originalCbor: raw });
}

function datumByHash(hash: Uint8Array, ctx: MapContext): cardano.Datum {
    const d = ctx.datums?.get(hexOf(hash));
    return new cardano.Datum({ hash: u8(hash), payload: d ? plutusData(d) : undefined, originalCbor: d ? u8(slice(ctx.src, d)) : undefined });
}

/** One output (Byron `[address, coin]`, Shelley–Alonzo arrays, Babbage+ maps). */
export function txOutput(n: CNode, ctx: MapContext): cardano.TxOutput {
    if (n.t === "m") {
        const addr = fieldOf(n, 0), value = fieldOf(n, 1), datum = fieldOf(n, 2), script = fieldOf(n, 3);
        const { coin, assets } = valueOf(value);
        let scriptMsg: cardano.Script | undefined;
        if (script) {
            try { const raw = script.t === "tag" ? bytes(script.v) : bytes(script); scriptMsg = scriptFromRef(parseCbor(raw)); } catch { scriptMsg = undefined; }
        }
        return new cardano.TxOutput({ address: bytes(addr), coin: bigIntMsg(coin), assets, datum: datumMsg(datum, undefined, ctx), script: scriptMsg });
    }
    const [addr, value, legacyDatum] = items(n);
    // Byron: the address is the CBOR item itself ([#6.24(payload), crc])
    const address = addr && addr.t === "a" ? u8(slice(ctx.src, addr)) : bytes(addr);
    const { coin, assets } = valueOf(value);
    return new cardano.TxOutput({ address, coin: bigIntMsg(coin), assets, datum: datumMsg(undefined, legacyDatum, ctx) });
}

function valueOf(v: CNode | undefined): { coin: bigint; assets: cardano.Multiasset[] } {
    if (!v) return { coin: 0n, assets: [] };
    if (v.t === "a") return { coin: num(v.v[0]), assets: multiassets(v.v[1], false) };
    return { coin: num(v), assets: [] };
}

/** A standalone output's bytes (UTxO `native_bytes`) as a message. */
export function txOutputFromBytes(b: Uint8Array): cardano.TxOutput { return txOutput(parseCbor(b), { src: b }); }

// ---------------------------------------------------------------- certificates, governance

export function stakeCredential(n: CNode | undefined): cardano.StakeCredential {
    const [kind, hash] = items(n);
    return new cardano.StakeCredential({ stakeCredential: { case: num(kind) === 0n ? "addrKeyHash" : "scriptHash", value: bytes(hash) } });
}

function drep(n: CNode | undefined): cardano.DRep {
    const [kind, hash] = items(n);
    switch (Number(num(kind))) {
        case 0: return new cardano.DRep({ drep: { case: "addrKeyHash", value: bytes(hash) } });
        case 1: return new cardano.DRep({ drep: { case: "scriptHash", value: bytes(hash) } });
        case 2: return new cardano.DRep({ drep: { case: "abstain", value: true } });
        default: return new cardano.DRep({ drep: { case: "noConfidence", value: true } });
    }
}

function anchor(n: CNode | undefined): cardano.Anchor | undefined {
    if (isNullNode(n)) return undefined;
    const [url, hash] = items(n);
    return new cardano.Anchor({ url: text(url), contentHash: bytes(hash) });
}

function relay(n: CNode): cardano.Relay {
    const [kind, a, b, c] = items(n);
    switch (Number(num(kind))) {
        case 0: return new cardano.Relay({ port: isNullNode(a) ? 0 : Number(num(a)), ipV4: isNullNode(b) ? undefined : bytes(b), ipV6: isNullNode(c) ? undefined : bytes(c) });
        case 1: return new cardano.Relay({ port: isNullNode(a) ? 0 : Number(num(a)), dnsName: text(b) });
        default: return new cardano.Relay({ dnsName: text(a) });
    }
}

function unitInterval(n: CNode | undefined): cardano.RationalNumber | undefined {
    const [a, b] = items(n);
    if (!n) return undefined;
    return new cardano.RationalNumber({ numerator: Number(num(a)), denominator: Number(num(b)) });
}

/** One certificate (Shelley 0–6, Conway 7–18). */
export function certificate(n: CNode): cardano.Certificate | null {
    const f = items(n);
    const kind = Number(num(f[0]));
    const c = (value: cardano.Certificate["certificate"]) => new cardano.Certificate({ certificate: value });
    switch (kind) {
        case 0: return c({ case: "stakeRegistration", value: stakeCredential(f[1]) });
        case 1: return c({ case: "stakeDeregistration", value: stakeCredential(f[1]) });
        case 2: return c({ case: "stakeDelegation", value: new cardano.StakeDelegationCert({ stakeCredential: stakeCredential(f[1]), poolKeyhash: bytes(f[2]) }) });
        case 3: {
            const [, operator, vrf, pledge, cost, margin, rewardAccount, owners, relays, md] = f;
            const meta = items(md);
            return c({ case: "poolRegistration", value: new cardano.PoolRegistrationCert({
                operator: bytes(operator), vrfKeyhash: bytes(vrf), pledge: bigIntMsg(num(pledge)), cost: bigIntMsg(num(cost)), margin: unitInterval(margin),
                rewardAccount: bytes(rewardAccount), poolOwners: items(owners).map(bytes), relays: items(relays).map(relay),
                poolMetadata: isNullNode(md) ? undefined : new cardano.PoolMetadata({ url: text(meta[0]), hash: bytes(meta[1]) }),
            }) });
        }
        case 4: return c({ case: "poolRetirement", value: new cardano.PoolRetirementCert({ poolKeyhash: bytes(f[1]), epoch: num(f[2]) }) });
        case 5: return c({ case: "genesisKeyDelegation", value: new cardano.GenesisKeyDelegationCert({ genesisHash: bytes(f[1]), genesisDelegateHash: bytes(f[2]), vrfKeyhash: bytes(f[3]) }) });
        case 6: {
            const [source, target] = items(f[1]);
            const from = num(source) === 0n ? cardano.MirSource.RESERVES : cardano.MirSource.TREASURY;
            if (target && target.t === "m") {
                return c({ case: "mirCert", value: new cardano.MirCert({ from, to: target.v.map(([k, v]) => new cardano.MirTarget({ stakeCredential: stakeCredential(k), deltaCoin: bigIntMsg(num(v)) })) }) });
            }
            return c({ case: "mirCert", value: new cardano.MirCert({ from, otherPot: num(target) }) });
        }
        case 7: return c({ case: "regCert", value: new cardano.RegCert({ stakeCredential: stakeCredential(f[1]), coin: bigIntMsg(num(f[2])) }) });
        case 8: return c({ case: "unregCert", value: new cardano.UnRegCert({ stakeCredential: stakeCredential(f[1]), coin: bigIntMsg(num(f[2])) }) });
        case 9: return c({ case: "voteDelegCert", value: new cardano.VoteDelegCert({ stakeCredential: stakeCredential(f[1]), drep: drep(f[2]) }) });
        case 10: return c({ case: "stakeVoteDelegCert", value: new cardano.StakeVoteDelegCert({ stakeCredential: stakeCredential(f[1]), poolKeyhash: bytes(f[2]), drep: drep(f[3]) }) });
        case 11: return c({ case: "stakeRegDelegCert", value: new cardano.StakeRegDelegCert({ stakeCredential: stakeCredential(f[1]), poolKeyhash: bytes(f[2]), coin: bigIntMsg(num(f[3])) }) });
        case 12: return c({ case: "voteRegDelegCert", value: new cardano.VoteRegDelegCert({ stakeCredential: stakeCredential(f[1]), drep: drep(f[2]), coin: bigIntMsg(num(f[3])) }) });
        case 13: return c({ case: "stakeVoteRegDelegCert", value: new cardano.StakeVoteRegDelegCert({ stakeCredential: stakeCredential(f[1]), poolKeyhash: bytes(f[2]), drep: drep(f[3]), coin: bigIntMsg(num(f[4])) }) });
        case 14: return c({ case: "authCommitteeHotCert", value: new cardano.AuthCommitteeHotCert({ committeeColdCredential: stakeCredential(f[1]), committeeHotCredential: stakeCredential(f[2]) }) });
        case 15: return c({ case: "resignCommitteeColdCert", value: new cardano.ResignCommitteeColdCert({ committeeColdCredential: stakeCredential(f[1]), anchor: anchor(f[2]) }) });
        case 16: return c({ case: "regDrepCert", value: new cardano.RegDRepCert({ drepCredential: stakeCredential(f[1]), coin: bigIntMsg(num(f[2])), anchor: anchor(f[3]) }) });
        case 17: return c({ case: "unregDrepCert", value: new cardano.UnRegDRepCert({ drepCredential: stakeCredential(f[1]), coin: bigIntMsg(num(f[2])) }) });
        case 18: return c({ case: "updateDrepCert", value: new cardano.UpdateDRepCert({ drepCredential: stakeCredential(f[1]), anchor: anchor(f[2]) }) });
        default: return null;
    }
}

function govActionId(n: CNode | undefined): cardano.GovernanceActionId | undefined {
    if (isNullNode(n)) return undefined;
    const [tx, ix] = items(n);
    return new cardano.GovernanceActionId({ transactionId: bytes(tx), governanceActionIndex: Number(num(ix)) });
}

/** A Conway protocol-parameter update (the proposal's sparse map) as `PParams` (absent fields stay default). */
export function pparamsUpdate(n: CNode | undefined): cardano.PParams {
    const g = (k: number) => fieldOf(n, k);
    const has = (k: number) => g(k) !== undefined;
    const u = (k: number) => (has(k) ? num(g(k)) : undefined);
    const ex = (k: number) => { const [mem, steps] = items(g(k)); return has(k) ? new cardano.ExUnits({ memory: num(mem), steps: num(steps) }) : undefined; };
    const rat = (x: CNode | undefined) => (x ? unitInterval(x.t === "tag" ? x.v : x) : undefined);
    const thresholds = (k: number) => (has(k) ? new cardano.VotingThresholds({ thresholds: items(g(k)).map((x) => rat(x)!) }) : undefined);
    const models = g(18);
    let costModels: cardano.CostModels | undefined;
    if (models) {
        const cm = new cardano.CostModels();
        for (const [lang, vals] of entries(models)) {
            const m = new cardano.CostModel({ values: items(vals).map((x) => BigInt.asIntN(64, num(x))) });
            const l = Number(num(lang));
            if (l === 0) cm.plutusV1 = m; else if (l === 1) cm.plutusV2 = m; else if (l === 2) cm.plutusV3 = m; else if (l === 3) cm.plutusV4 = m;
        }
        costModels = cm;
    }
    const prices = g(19);
    const [pm, ps] = items(prices);
    return new cardano.PParams({
        minFeeCoefficient: bigIntMsg(u(0)), minFeeConstant: bigIntMsg(u(1)), maxBlockBodySize: u(2) ?? 0n, maxTxSize: u(3) ?? 0n, maxBlockHeaderSize: u(4) ?? 0n,
        stakeKeyDeposit: bigIntMsg(u(5)), poolDeposit: bigIntMsg(u(6)), poolRetirementEpochBound: u(7) ?? 0n, desiredNumberOfPools: u(8) ?? 0n,
        poolInfluence: rat(g(9)), monetaryExpansion: rat(g(10)), treasuryExpansion: rat(g(11)), minPoolCost: bigIntMsg(u(16)), coinsPerUtxoByte: bigIntMsg(u(17)),
        costModels, prices: prices ? new cardano.ExPrices({ memory: rat(pm), steps: rat(ps) }) : undefined,
        maxExecutionUnitsPerTransaction: ex(20), maxExecutionUnitsPerBlock: ex(21), maxValueSize: u(22) ?? 0n, collateralPercentage: u(23) ?? 0n, maxCollateralInputs: u(24) ?? 0n,
        poolVotingThresholds: thresholds(25), drepVotingThresholds: thresholds(26), minCommitteeSize: Number(u(27) ?? 0n), committeeTermLimit: u(28) ?? 0n,
        governanceActionValidityPeriod: u(29) ?? 0n, governanceActionDeposit: bigIntMsg(u(30)), drepDeposit: bigIntMsg(u(31)), drepInactivityPeriod: u(32) ?? 0n,
        minFeeScriptRefCostPerByte: rat(g(33)),
    });
}

function govAction(n: CNode | undefined): cardano.GovernanceAction {
    const f = items(n);
    const kind = Number(num(f[0]));
    const a = (value: cardano.GovernanceAction["governanceAction"]) => new cardano.GovernanceAction({ governanceAction: value });
    switch (kind) {
        case 0: return a({ case: "parameterChangeAction", value: new cardano.ParameterChangeAction({ govActionId: govActionId(f[1]), protocolParamUpdate: pparamsUpdate(f[2]), policyHash: isNullNode(f[3]) ? undefined : bytes(f[3]) }) });
        case 1: { const [maj, min] = items(f[2]); return a({ case: "hardForkInitiationAction", value: new cardano.HardForkInitiationAction({ govActionId: govActionId(f[1]), protocolVersion: new cardano.ProtocolVersion({ major: Number(num(maj)), minor: Number(num(min)) }) }) }); }
        case 2: return a({ case: "treasuryWithdrawalsAction", value: new cardano.TreasuryWithdrawalsAction({ withdrawals: entries(f[1]).map(([k, v]) => new cardano.WithdrawalAmount({ rewardAccount: bytes(k), coin: bigIntMsg(num(v)) })), policyHash: isNullNode(f[2]) ? undefined : bytes(f[2]) }) });
        case 3: return a({ case: "noConfidenceAction", value: new cardano.NoConfidenceAction({ govActionId: govActionId(f[1]) }) });
        case 4: return a({ case: "updateCommitteeAction", value: new cardano.UpdateCommitteeAction({
            govActionId: govActionId(f[1]), removeCommitteeCredentials: items(f[2]).map(stakeCredential),
            newCommitteeCredentials: entries(f[3]).map(([k, v]) => new cardano.NewCommitteeCredentials({ committeeColdCredential: stakeCredential(k), expiresEpoch: Number(num(v)) })),
            newCommitteeThreshold: f[4] ? unitInterval(f[4].t === "tag" ? f[4].v : f[4]) : undefined,
        }) });
        case 5: { const [anc, script] = items(f[2]); return a({ case: "newConstitutionAction", value: new cardano.NewConstitutionAction({ govActionId: govActionId(f[1]), constitution: new cardano.Constitution({ anchor: anchor(anc), hash: isNullNode(script) ? undefined : bytes(script) }) }) }); }
        default: return a({ case: "infoAction", value: 6 }); // pallas' placeholder: v1alpha carries Info as a uint32
    }
}

// ---------------------------------------------------------------- transactions

interface RedeemerNode { tag: number; index: number; data: CNode; mem: bigint; steps: bigint; original: Uint8Array }

function redeemerList(n: CNode | undefined, src: Uint8Array): RedeemerNode[] {
    if (!n) return [];
    const out: RedeemerNode[] = [];
    if ((n.t === "tag" ? n.v : n).t === "m") {
        for (const [k, v] of entries(n)) {
            const [tag, index] = items(k), [data, ex] = items(v);
            const [mem, steps] = items(ex);
            const original = new Uint8Array(1 + (tag!.e - tag!.s) + (index!.e - index!.s) + (data!.e - data!.s) + (ex!.e - ex!.s));
            original[0] = 0x84;
            let o = 1;
            for (const part of [tag!, index!, data!, ex!]) { original.set(slice(src, part), o); o += part.e - part.s; }
            out.push({ tag: Number(num(tag)), index: Number(num(index)), data: data!, mem: num(mem), steps: num(steps), original });
        }
        return out;
    }
    for (const r of items(n)) {
        const [tag, index, data, ex] = items(r);
        const [mem, steps] = items(ex);
        out.push({ tag: Number(num(tag)), index: Number(num(index)), data: data!, mem: num(mem), steps: num(steps), original: slice(src, r) });
    }
    return out;
}

function redeemerMsg(r: RedeemerNode): cardano.Redeemer {
    return new cardano.Redeemer({ purpose: (r.tag + 1) as cardano.RedeemerPurpose, payload: plutusData(r.data), index: r.index, exUnits: new cardano.ExUnits({ memory: r.mem, steps: r.steps }), originalCbor: u8(r.original) });
}

/** Spent outputs the caller could resolve (`txid:ix` → output bytes), to fill `TxInput.as_output`. */
export type InputResolver = (refs: string[]) => Map<string, Uint8Array>;

export interface TxParts {
    body: CNode;
    witnesses: CNode | undefined;
    isValid: boolean;
    aux: CNode | undefined;
    /** Bytes the nodes point into (block or transaction). */
    src: Uint8Array;
}

const refOf = (n: CNode) => { const [id, ix] = items(n); return { id: bytes(id), ix: Number(num(ix)) }; };
const refKey = (r: { id: Uint8Array; ix: number }) => `${hexOf(r.id)}:${r.ix}`;
const sortRefs = (rs: Array<{ id: Bytes; ix: number }>) => rs.slice().sort((a, b) => cmpBytes(a.id, b.id) || a.ix - b.ix);

/** All the spent / referenced inputs of a transaction body (`txid:ix`). */
export function referencedInputs(body: CNode): string[] {
    const all = [...items(fieldOf(body, 0)), ...items(fieldOf(body, 13)), ...items(fieldOf(body, 18))].map(refOf);
    return [...new Set(all.map(refKey))];
}

/** A Shelley-and-later transaction as a `Tx` message. */
export function txMsg(p: TxParts, resolve?: InputResolver): cardano.Tx {
    const { body, witnesses: w, src } = p;
    const datums = new Map<string, CNode>();
    for (const d of items(fieldOf(w, 4))) datums.set(hexOf(blake2b_256(slice(src, d))), d);
    const ctx: MapContext = { datums, src };
    const redeemers = redeemerList(fieldOf(w, 5), src);
    const findRedeemer = (tag: number, index: number) => { const r = redeemers.find((x) => x.tag === tag && x.index === index); return r ? redeemerMsg(r) : undefined; };

    const inputs = sortRefs(items(fieldOf(body, 0)).map(refOf));
    const collateral = items(fieldOf(body, 13)).map(refOf);
    const refInputs = items(fieldOf(body, 18)).map(refOf);
    const resolved = resolve ? resolve([...new Set([...inputs, ...collateral, ...refInputs].map(refKey))]) : new Map<string, Uint8Array>();
    const asOutput = (r: { id: Uint8Array; ix: number }) => { const b = resolved.get(refKey(r)); if (!b) return undefined; try { return txOutputFromBytes(b); } catch { return undefined; } };

    const withdrawals = entries(fieldOf(body, 5)).slice().sort((a, b) => cmpBytes(bytes(a[0]), bytes(b[0])));
    const mint = multiassets(fieldOf(body, 9), true);
    mint.forEach((m, i) => { m.redeemer = findRedeemer(1, i); });

    const scripts: cardano.Script[] = [
        ...items(fieldOf(w, 1)).map((s) => new cardano.Script({ script: { case: "native", value: nativeScript(s) } })),
        ...items(fieldOf(w, 3)).map((s) => plutusScript(1, s)),
        ...items(fieldOf(w, 6)).map((s) => plutusScript(2, s)),
        ...items(fieldOf(w, 7)).map((s) => plutusScript(3, s)),
    ];

    const certs: cardano.Certificate[] = [];
    items(fieldOf(body, 4)).forEach((c, i) => { const m = certificate(c); if (m) { m.redeemer = findRedeemer(2, i); certs.push(m); } });

    const collReturn = fieldOf(body, 16);
    return new cardano.Tx({
        hash: blake256(slice(src, body)),
        inputs: inputs.map((r, i) => new cardano.TxInput({ txHash: r.id, outputIndex: r.ix, asOutput: asOutput(r), redeemer: findRedeemer(0, i) })),
        outputs: items(fieldOf(body, 1)).map((o) => txOutput(o, ctx)),
        certificates: certs,
        withdrawals: withdrawals.map(([acct, coin], i) => new cardano.Withdrawal({ rewardAccount: bytes(acct), coin: bigIntMsg(num(coin)), redeemer: findRedeemer(3, i) })),
        mint,
        referenceInputs: refInputs.map((r) => new cardano.TxInput({ txHash: r.id, outputIndex: r.ix, asOutput: asOutput(r) })),
        witnesses: new cardano.WitnessSet({
            vkeywitness: items(fieldOf(w, 0)).map((v) => { const [vk, sig] = items(v); return new cardano.VKeyWitness({ vkey: bytes(vk), signature: bytes(sig) }); }),
            script: scripts,
            plutusDatums: items(fieldOf(w, 4)).map(plutusData),
        }),
        collateral: new cardano.Collateral({
            collateral: collateral.map((r) => new cardano.TxInput({ txHash: r.id, outputIndex: r.ix, asOutput: asOutput(r) })),
            collateralReturn: collReturn ? txOutput(collReturn, ctx) : undefined,
            totalCollateral: bigIntMsg(num(fieldOf(body, 17))),
        }),
        fee: bigIntMsg(num(fieldOf(body, 2))),
        validity: new cardano.TxValidity({ start: num(fieldOf(body, 8)), ttl: num(fieldOf(body, 3)) }),
        successful: p.isValid,
        auxiliary: auxMsg(p.aux),
        proposals: items(fieldOf(body, 20)).map((pp) => {
            const [deposit, account, action, anc] = items(pp);
            return new cardano.GovernanceActionProposal({ deposit: bigIntMsg(num(deposit)), rewardAccount: bytes(account), govAction: govAction(action), anchor: anchor(anc) });
        }),
    });
}

function auxMsg(n: CNode | undefined): cardano.AuxData {
    if (isNullNode(n)) return new cardano.AuxData();
    let metadata: CNode | undefined, scripts: cardano.Script[] = [];
    if (n!.t === "m") metadata = n; // Shelley: the metadata map
    else if (n!.t === "a") { // Allegra/Mary: [metadata, [native scripts]]
        metadata = n!.v[0];
        scripts = items(n!.v[1]).map((s) => new cardano.Script({ script: { case: "native", value: nativeScript(s) } }));
    } else if (n!.t === "tag") { // Alonzo+: #6.259({0: metadata, 1: native, 2: V1, 3: V2, 4: V3})
        metadata = fieldOf(n, 0);
        scripts = [
            ...items(fieldOf(n, 1)).map((s) => new cardano.Script({ script: { case: "native", value: nativeScript(s) } })),
            ...items(fieldOf(n, 2)).map((s) => plutusScript(1, s)),
            ...items(fieldOf(n, 3)).map((s) => plutusScript(2, s)),
            ...items(fieldOf(n, 4)).map((s) => plutusScript(3, s)),
        ];
    }
    return new cardano.AuxData({
        metadata: entries(metadata).map(([label, v]) => new cardano.Metadata({ label: num(label), value: metadatum(v) })),
        scripts,
    });
}

/** A standalone transaction (`[body, witnesses, is_valid?, aux]`, as submitted) as a `Tx` message. */
export function txFromBytes(b: Uint8Array, resolve?: InputResolver): cardano.Tx {
    const n = parseCbor(b);
    const f = items(n);
    if (f.length < 3) throw new Error("not a transaction");
    // Shelley–Mary: [body, witnesses, aux]; Alonzo+: [body, witnesses, is_valid, aux]
    const alonzo = f.length >= 4;
    const isValid = alonzo ? !(f[2]!.t === "simple" && f[2]!.v === false) : true;
    return txMsg({ body: f[0]!, witnesses: f[1], isValid, aux: alonzo ? f[3] : f[2], src: b }, resolve);
}

/** Transaction id of a standalone transaction (blake2b-256 of the body bytes as carried). */
export function txIdOf(b: Uint8Array): Bytes {
    const f = items(parseCbor(b));
    if (!f[0]) throw new Error("not a transaction");
    return blake256(slice(b, f[0]));
}

// ---------------------------------------------------------------- blocks

export interface BlockTx {
    /** Transaction id (hex). */
    id: string;
    /** The transaction as a standalone `[body, witnesses, is_valid, aux]` CBOR (Shelley+), or the Byron `[tx, witnesses]` pair. */
    nativeBytes: Uint8Array;
    msg: cardano.Tx;
    /** Inputs it spends / references (`txid:ix`). */
    refs: string[];
}

export interface ParsedBlock {
    eraTag: number;
    slot: bigint;
    height: bigint;
    hash: Bytes;
    txs: BlockTx[];
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * Every transaction of a stored block (`[eraTag, block]`), each mapped to a `Tx` message.
 * `resolve` fills the inputs' `as_output` when it can (best effort).
 */
export function blockTxs(blockBytes: Uint8Array, resolve?: InputResolver): BlockTx[] {
    const top = parseCbor(blockBytes);
    const [tagNode, blk] = items(top);
    const eraTag = Number(num(tagNode));
    const parts = items(blk);
    const out: BlockTx[] = [];
    if (eraTag === 0) return out; // Byron epoch boundary block: no transactions
    if (eraTag === 1) {
        const txPayload = items(items(parts[1])[0]);
        for (const pair of txPayload) {
            const [tx] = items(pair);
            if (!tx) continue;
            const [ins, outs] = items(tx);
            const id = blake256(slice(blockBytes, tx));
            const inputs = items(ins).flatMap((i) => {
                const [kind, payload] = items(i);
                if (num(kind) !== 0n || !payload) return [];
                try { const inner = parseCbor(bytes(payload.t === "tag" ? payload.v : payload)); const [txid, ix] = items(inner); return [{ id: bytes(txid), ix: Number(num(ix)) }]; } catch { return []; }
            });
            const resolved = resolve ? resolve(inputs.map(refKey)) : new Map<string, Uint8Array>();
            const msg = new cardano.Tx({
                hash: id,
                inputs: inputs.map((r) => { const b = resolved.get(refKey(r)); let asOutput: cardano.TxOutput | undefined; try { asOutput = b ? txOutputFromBytes(b) : undefined; } catch { asOutput = undefined; } return new cardano.TxInput({ txHash: r.id, outputIndex: r.ix, asOutput }); }),
                outputs: items(outs).map((o) => txOutput(o, { src: blockBytes })),
                successful: true,
            });
            out.push({ id: hexOf(id), nativeBytes: u8(slice(blockBytes, pair)), msg, refs: inputs.map(refKey) });
        }
        return out;
    }
    // Shelley+: [header, tx_bodies, witness_sets, aux_data_map, ?invalid_txs]
    const bodies = items(parts[1]), wits = items(parts[2]);
    const auxMap = new Map<number, CNode>();
    for (const [k, v] of entries(parts[3])) auxMap.set(Number(num(k)), v);
    const invalid = new Set(items(parts[4]).map((x) => Number(num(x))));
    const alonzo = eraTag >= 5;
    bodies.forEach((body, i) => {
        const w = wits[i], aux = auxMap.get(i);
        const isValid = !invalid.has(i);
        const msg = txMsg({ body, witnesses: w, isValid, aux, src: blockBytes }, resolve);
        const nullByte = Uint8Array.of(0xf6);
        const auxBytes = aux ? slice(blockBytes, aux) : nullByte;
        const wBytes = w ? slice(blockBytes, w) : Uint8Array.of(0xa0);
        const nativeBytes = alonzo
            ? concat([Uint8Array.of(0x84), slice(blockBytes, body), wBytes, Uint8Array.of(isValid ? 0xf5 : 0xf4), auxBytes])
            : concat([Uint8Array.of(0x83), slice(blockBytes, body), wBytes, auxBytes]);
        out.push({ id: hexOf(msg.hash), nativeBytes, msg, refs: referencedInputs(body) });
    });
    return out;
}

/** Block header facts from a stored block. */
export function blockHeaderFacts(blockBytes: Uint8Array): { eraTag: number; height: bigint | null } {
    const top = parseCbor(blockBytes);
    const [tagNode, blk] = items(top);
    const eraTag = Number(num(tagNode));
    const header = items(blk)[0];
    if (eraTag === 0) return { eraTag, height: null };
    if (eraTag === 1) {
        // Byron header: [magic, prev, proof, [slotid, pubkey, [difficulty], sig], extra]
        const cons = items(header)[3];
        return { eraTag, height: num(items(items(cons)[2])[0]) };
    }
    const hb = items(header)[0];
    return { eraTag, height: num(items(hb)[0]) };
}

/** A `Block` message: header (slot, hash, height), the transactions, and the slot's time in ms. */
export function blockMsg(b: { slot: number | bigint; hash: Uint8Array; height: bigint | number | null; timestampMs: bigint | number; txs: BlockTx[] }): cardano.Block {
    return new cardano.Block({
        header: new cardano.BlockHeader({ slot: BigInt(b.slot), hash: u8(b.hash), height: BigInt(b.height ?? 0) }),
        body: new cardano.BlockBody({ tx: b.txs.map((t) => t.msg) }),
        timestamp: BigInt(b.timestampMs),
    });
}


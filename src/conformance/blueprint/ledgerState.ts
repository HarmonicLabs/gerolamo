/**
 * Decoder for the Cardano Blueprint ledger conformance vectors (cardano-scaling/cardano-blueprint
 * `src/ledger/conformance-test-vectors`, dumped by a cardano-ledger fork at 34365e42, May 2025).
 *
 * One vector is a JSON record: `cbor` (the transaction), `oldLedgerState` and, when the LEDGER rule
 * accepted the transaction, `newLedgerState` (hex CBOR of a Conway `LedgerState`), `success` and
 * `testState` (the ImpSpec test path). Protocol parameters inside the state are replaced by the
 * SHA-256 of their CBOR (the `pparams-by-hash/` files hold the 31-field Conway record).
 *
 * LedgerState layout of that cardano-ledger version (it predates the node 11 layout that
 * mithril/nesDecoder.ts reads; the governance parts are the same and reuse its decoders):
 *   [CertState, UTxOState]
 *   CertState = [VState [dreps, committeeState, dormantEpochs],
 *                PState [poolParams, futurePoolParams, retiring, deposits],
 *                DState [UMap [elems, ptrs], futureGenDelegs, genDelegs, iRewards]]
 *   UMElem    = [StrictMaybe [reward, deposit], ptrs set, StrictMaybe pool, StrictMaybe drep]
 *   PoolParams = [operator, vrf, pledge, cost, margin, rewardAccount, owners, relays, metadata]
 *   UTxOState = [utxo (MemPack TxIn → MemPack TxOut), deposited, fees, GovState, instantStake, donation]
 *   GovState  = [proposals [roots, [ProposalState]], committee, constitution, curPParams hash,
 *                prevPParams hash, futurePParams, drepPulsing]
 */
import { Cbor, CborArray, CborBytes, CborMap, type CborObj } from "@harmoniclabs/cbor";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { decodeUtxoEntry } from "../../state/utxohdMemCodec";
import { txOutWireCbor } from "../../mithril/importUtxo";
import {
    anchor as anchorOf, arr, big, bytes, constitutionOf, govActionId, cred as credOf, drep as drepOf, int, map as mapOf, maybe, proposalOf, rational, rootsOf, set as setOf, typedHex,
    type Anchor, type Proposal, type Roots,
} from "../../mithril/nesDecoder";
import { outputLike } from "../../consensus/rules/blockRulesPure";
import type { ResolvedUtxo } from "../../consensus/rules/resolvedUtxo";
import type { DRepTarget, TypedCred } from "../../consensus/governance/govTxDecode";

export interface BlueprintAccount { reward: bigint; deposit: bigint; pool: string | null; drep: DRepTarget | null }
export interface BlueprintPool { vrf: string; cost: bigint; rewardAccount: string; owners: string[] }
export interface BlueprintDRep { expiry: number; deposit: bigint; anchor: Anchor | null; delegators: TypedCred[] }
export type BlueprintCommitteeAuth = { hot: TypedCred } | { resigned: true };

export interface BlueprintUtxo {
    ref: string;
    /** The output as ledger-ts decodes its Babbage wire form (built from the MemPack bytes). */
    txOut: TxOut;
    /** What the rules read (`outputLike`, the same conversion the block rules use for in-block outputs). */
    resolved: ResolvedUtxo;
}

export interface BlueprintLedgerState {
    utxo: Map<string, BlueprintUtxo>;
    accounts: Map<TypedCred, BlueprintAccount>;
    pools: Map<string, BlueprintPool>;
    futurePools: Map<string, BlueprintPool>;
    retiring: Map<string, number>;
    poolDeposits: Map<string, bigint>;
    dreps: Map<TypedCred, BlueprintDRep>;
    committeeState: Map<TypedCred, BlueprintCommitteeAuth>;
    dormantEpochs: number;
    deposited: bigint;
    fees: bigint;
    donation: bigint;
    gov: {
        roots: Roots;
        proposals: Proposal[];
        /** Enacted committee (typed cold credential → expiry epoch); null after a no-confidence. */
        committee: { members: Map<TypedCred, number>; thresholdNum: bigint; thresholdDen: bigint } | null;
        constitution: { anchor: Anchor; script: string | null };
        curPParamsHash: string;
        prevPParamsHash: string;
        /** Action ids the DRep pulser of the current epoch expires (`rsExpired`: `gasExpiresAfter < current epoch`). */
        pulserExpired: string[];
    };
}

const drepTarget = (o: CborObj, path: string): DRepTarget => {
    const d = drepOf(o, path);
    if (d.kind === 0 || d.kind === 1) return { kind: "cred", cred: d.kind === 1 ? `01${d.hash}` : d.hash };
    return d.kind === 2 ? { kind: "abstain" } : { kind: "noConfidence" };
};

function poolParamsOf(o: CborObj, path: string): BlueprintPool {
    const a = arr(o, path, 9);
    return {
        vrf: bytes(a[1], `${path}.vrf`, 32),
        cost: big(a[3], `${path}.cost`),
        rewardAccount: bytes(a[5], `${path}.rewardAccount`),
        owners: setOf(a[6], `${path}.owners`).map((x) => bytes(x, `${path}.owner`, 28)),
    };
}

/**
 * The corpus predates cardano-ledger's switch of the MemPack `TxIn` to a big-endian `TxIx` (made so
 * on-disk keys sort in output order): its keys carry the index little-endian, where the node 11
 * tables files that `decodeUtxoEntry` reads carry it big-endian. Swap the two bytes.
 */
export function nodeTxInKey(key: Uint8Array): Uint8Array {
    if (key.length !== 34) return key;
    const k = Uint8Array.from(key);
    k[32] = key[33]!; k[33] = key[32]!;
    return k;
}

function utxoOf(key: Uint8Array, val: Uint8Array): BlueprintUtxo {
    const dec = decodeUtxoEntry(nodeTxInKey(key), val);
    if (!dec.ok) throw new Error(`UTxO entry: ${dec.error} @${dec.off}`);
    const { txIn, txOut } = dec.value;
    const out = TxOut.fromCbor(txOutWireCbor(txOut));
    const ref = `${txIn.txIdHex.toLowerCase()}:${txIn.txIx}`;
    const o = outputLike(out);
    return {
        ref,
        txOut: out,
        resolved: { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null },
    };
}

/** Decode a hex `LedgerState` of the Blueprint corpus. */
export function decodeBlueprintLedgerState(hex: string): BlueprintLedgerState {
    const top = arr(Cbor.parse(hex), "ledgerState", 2);
    const cs = arr(top[0], "certState", 3);
    const vs = arr(cs[0], "vstate", 3), ps = arr(cs[1], "pstate", 4), ds = arr(cs[2], "dstate", 4);
    const us = arr(top[1], "utxoState", 6);

    const accounts = new Map<TypedCred, BlueprintAccount>();
    const umap = arr(ds[0], "dstate.umap", 2);
    for (const { k, v } of mapOf(umap[0], "umap.elems")) {
        const c = typedHex(credOf(k, "umap.key"));
        const e = arr(v, `umap.${c}`, 4);
        const rd = maybe(e[0], "umap.rdpair", (x) => arr(x, "umap.rdpair", 2));
        // An element without an RDPair is a pointer-only or delegation-only leftover: not a registered account.
        if (!rd) continue;
        accounts.set(c, {
            reward: big(rd[0], "umap.reward"), deposit: big(rd[1], "umap.deposit"),
            pool: maybe(e[2], "umap.pool", (x) => bytes(x, "umap.pool", 28)),
            drep: maybe(e[3], "umap.drep", (x) => drepTarget(x, "umap.drep")),
        });
    }

    const poolMap = (o: CborObj | undefined, path: string) => { const m = new Map<string, BlueprintPool>(); for (const { k, v } of mapOf(o, path)) { const id = bytes(k, `${path}.key`, 28); m.set(id, poolParamsOf(v, `${path}.${id.slice(0, 8)}`)); } return m; };
    const pools = poolMap(ps[0], "pstate.pools");
    const futurePools = poolMap(ps[1], "pstate.future");
    const retiring = new Map<string, number>();
    for (const { k, v } of mapOf(ps[2], "pstate.retiring")) retiring.set(bytes(k, "retiring.key", 28), int(v, "retiring.epoch"));
    const poolDeposits = new Map<string, bigint>();
    for (const { k, v } of mapOf(ps[3], "pstate.deposits")) poolDeposits.set(bytes(k, "deposits.key", 28), big(v, "deposits.coin"));

    const dreps = new Map<TypedCred, BlueprintDRep>();
    for (const { k, v } of mapOf(vs[0], "vstate.dreps")) {
        const c = typedHex(credOf(k, "dreps.key"));
        const a = arr(v, `dreps.${c}`, 4);
        dreps.set(c, {
            expiry: int(a[0], "dreps.expiry"),
            anchor: maybe(a[1], "dreps.anchor", (x) => anchorOf(x, "dreps.anchor")),
            deposit: big(a[2], "dreps.deposit"),
            delegators: setOf(a[3], "dreps.delegators").map((x) => typedHex(credOf(x, "dreps.delegator"))),
        });
    }
    const committeeState = new Map<TypedCred, BlueprintCommitteeAuth>();
    for (const { k, v } of mapOf(vs[1], "vstate.committeeState")) {
        const cold = typedHex(credOf(k, "committeeState.key"));
        const a = arr(v, `committeeState.${cold}`);
        const t = int(a[0], "committeeState.tag");
        committeeState.set(cold, t === 0 ? { hot: typedHex(credOf(a[1], "committeeState.hot")) } : { resigned: true });
    }

    const utxo = new Map<string, BlueprintUtxo>();
    const utxoMap = us[0];
    if (!(utxoMap instanceof CborMap)) throw new Error("utxoState.utxo: expected map");
    for (const { k, v } of utxoMap.map) {
        if (!(k instanceof CborBytes) || !(v instanceof CborBytes)) throw new Error("utxo entry: expected bytes → bytes");
        const u = utxoOf(k.bytes, v.bytes);
        utxo.set(u.ref, u);
    }

    const g = arr(us[3], "govState", 7);
    const pa = arr(g[0], "govState.proposals", 2);
    const committee = maybe(g[1], "govState.committee", (x) => {
        const a = arr(x, "committee", 2);
        const members = new Map<TypedCred, number>();
        for (const { k, v } of mapOf(a[0], "committee.members")) members.set(typedHex(credOf(k, "committee.member")), int(v, "committee.expiry"));
        const thr = rational(a[1], "committee.threshold");
        return { members, thresholdNum: thr.num, thresholdDen: thr.den };
    });
    return {
        utxo, accounts, pools, futurePools, retiring, poolDeposits, dreps, committeeState,
        dormantEpochs: int(vs[2], "vstate.dormant"),
        deposited: big(us[1], "utxoState.deposited"), fees: big(us[2], "utxoState.fees"), donation: big(us[5], "utxoState.donation"),
        gov: {
            roots: rootsOf(pa[0], "proposals.roots"),
            proposals: arr(pa[1], "proposals.list").map((p, i) => proposalOf(p, `proposals[${i}]`)),
            committee,
            constitution: constitutionOf(g[2], "constitution"),
            curPParamsHash: bytes(g[3], "curPParams", 32),
            prevPParamsHash: bytes(g[4], "prevPParams", 32),
            pulserExpired: setOf(arr(arr(g[6], "drepPulsing", 2)[1], "ratifyState", 4)[2], "ratifyState.expired").map((x) => govActionId(x, "ratifyState.expired")),
        },
    };
}

/** The raw CBOR array of a `pparams-by-hash` file. */
export function pparamsArrayOf(bytesIn: Uint8Array): CborArray {
    const o = Cbor.parse(bytesIn);
    if (!(o instanceof CborArray) || o.array.length !== 31) throw new Error(`pparams: expected the 31-field Conway record`);
    return o;
}


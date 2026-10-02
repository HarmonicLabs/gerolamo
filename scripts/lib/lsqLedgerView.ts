/**
 * A `MempoolLedgerView` backed by a node's LocalStateQuery (cardano-node or Gerolamo): the tip,
 * the current protocol parameters and UTxO lookups, for oracle scripts that run Gerolamo's
 * mempool rules against the reference ledger state.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { N2cConn } from "./n2c";
import type { MempoolLedgerView } from "../../src/mempool/ValidatingMempool";
import type { ResolvedUtxo } from "../../src/consensus/rules/resolvedUtxo";
import { txOutPartsFromBytes } from "../../src/mempool/conwayMempoolRules";

const U = (n: number | bigint) => new CborUInt(n);
const ERA = 6;
const blockQuery = (q: CborObj) => new CborArray([U(0), new CborArray([U(0), new CborArray([U(ERA), q])])]);

/** Conway PParams list (ledger field order) → the Blockfrost-shaped record `epoch_params` stores. */
export function pparamsRecord(pp: CborArray): Record<string, unknown> {
    const n = (i: number) => { const o = pp.array[i]; return o instanceof CborUInt ? o.num.toString() : null; };
    const r = (o: CborObj | undefined) => { if (o instanceof CborTag && o.data instanceof CborArray) { const [a, b] = o.data.array as CborUInt[]; return Number(a!.num) / Number(b!.num); } return null; };
    const pair = (i: number) => (pp.array[i] as CborArray).array;
    const cm = pp.array[15] as CborMap;
    const cost: Record<string, Array<number>> = {};
    for (const { k, v } of cm.map) cost[`PlutusV${Number((k as CborUInt).num) + 1}`] = (v as CborArray).array.map((x: any) => Number(x.num));
    return {
        min_fee_a: n(0), min_fee_b: n(1), max_block_size: n(2), max_tx_size: n(3), max_block_header_size: n(4), key_deposit: n(5), pool_deposit: n(6), e_max: n(7), n_opt: n(8),
        a0: r(pp.array[9]), rho: r(pp.array[10]), tau: r(pp.array[11]),
        protocol_major_ver: (pair(12)[0] as CborUInt).num.toString(), protocol_minor_ver: (pair(12)[1] as CborUInt).num.toString(),
        min_pool_cost: n(13), coins_per_utxo_size: n(14), cost_models: cost,
        price_mem: r(pair(16)[0]), price_step: r(pair(16)[1]),
        max_tx_ex_mem: (pair(17)[0] as CborUInt).num.toString(), max_tx_ex_steps: (pair(17)[1] as CborUInt).num.toString(),
        max_block_ex_mem: (pair(18)[0] as CborUInt).num.toString(), max_block_ex_steps: (pair(18)[1] as CborUInt).num.toString(),
        max_val_size: n(19), collateral_percent: n(20), max_collateral_inputs: n(21),
        gov_action_deposit: n(27), drep_deposit: n(28), min_fee_ref_script_cost_per_byte: r(pp.array[30]),
    };
}

/** A TxOut as the ledger returns it → Gerolamo's ResolvedUtxo. */
export function resolvedFromTxOut(ref: string, out: CborObj): ResolvedUtxo {
    const parts = txOutPartsFromBytes(Cbor.encode(out).toBuffer());
    let address = "";
    try { address = Address.fromBytes(parts.address).toString(); } catch { address = ""; }
    let referenceScriptHash: string | null = null;
    if (parts.scriptRefCbor) {
        const s = Cbor.parse(parts.scriptRefCbor) as CborArray;
        const lang = Number((s.array[0] as CborUInt).num);
        const payload = lang === 0 ? Cbor.encode(s.array[1]!).toBuffer() : (s.array[1] as CborBytes).bytes;
        const pre = new Uint8Array(1 + payload.length); pre[0] = lang; pre.set(payload, 1);
        referenceScriptHash = toHex(blake2b_224(pre));
    }
    return {
        ref, address, value: parts.value, referenceScriptHash,
        hasDatum: !!(parts.datumHash || parts.inlineDatumCbor), datumHash: parts.datumHash ?? null,
        inlineDatumCbor: parts.inlineDatumCbor ? toHex(parts.inlineDatumCbor) : null,
        referenceScriptCbor: parts.scriptRefCbor ? toHex(parts.scriptRefCbor) : null,
    };
}

export async function lsqLedgerView(c: N2cConn, network: "mainnet" | "testnet", epochNetwork: string): Promise<MempoolLedgerView & { reacquire(): Promise<void> }> {
    let acquired = false;
    const query = async (q: CborObj): Promise<CborObj> => {
        c.send(7, Cbor.encode(new CborArray([U(3), q])).toBuffer());
        const r = Cbor.parse(await c.recv(7)) as CborArray;
        return r.array[1]!;
    };
    const reacquire = async () => {
        c.send(7, Cbor.encode(new CborArray([U(acquired ? 9 : 8)])).toBuffer());
        await c.recv(7);
        acquired = true;
    };
    await reacquire();
    return {
        reacquire,
        async tip() {
            const p = await query(new CborArray([U(3)])) as CborArray;
            return { slot: (p.array[0] as CborUInt).num, hash: toHex((p.array[1] as CborBytes).bytes) };
        },
        async state(_slot) {
            const res = await query(blockQuery(new CborArray([U(3)]))) as CborArray;
            const raw = pparamsRecord(res.array[0] as CborArray);
            const epochRes = await query(blockQuery(new CborArray([U(1)]))) as CborArray;
            const epoch = Number((epochRes.array[0] as CborUInt).num);
            return {
                slot: _slot, network, genesis: null,
                params: { epoch, minFeeA: BigInt(String(raw.min_fee_a)), minFeeB: BigInt(String(raw.min_fee_b)), maxTxSize: Number(raw.max_tx_size), maxBlockSize: Number(raw.max_block_size), maxBlockHeaderSize: Number(raw.max_block_header_size), collateralPercent: Number(raw.collateral_percent), maxCollateralInputs: Number(raw.max_collateral_inputs), maxValSize: Number(raw.max_val_size), protocolMajor: Number(raw.protocol_major_ver), raw },
            };
        },
        async resolve(refs) {
            const out = new Map<string, ResolvedUtxo>();
            if (!refs.length) return out;
            const ins = refs.map((r) => { const i = r.lastIndexOf(":"); return { id: r.slice(0, i), ix: Number(r.slice(i + 1)) }; })
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.ix - b.ix))
                .map((x) => new CborArray([new CborBytes(Uint8Array.from(Buffer.from(x.id, "hex"))), U(x.ix)]));
            const res = await query(blockQuery(new CborArray([U(15), new CborTag(258, new CborArray(ins))]))) as CborArray;
            const m = res.array[0] as CborMap;
            for (const { k, v } of m.map) {
                const [id, ix] = (k as CborArray).array as [CborBytes, CborUInt];
                const ref = `${toHex(id.bytes)}:${Number(ix.num)}`;
                out.set(ref, resolvedFromTxOut(ref, v));
            }
            return out;
        },
        async pools(ids) {
            if (!ids.length) return new Set<string>();
            const res = await query(blockQuery(new CborArray([U(16)]))) as CborArray;
            const all = new Set(((res.array[0] as CborTag).data as CborArray).array.map((b) => toHex((b as CborBytes).bytes)));
            return new Set(ids.filter((i) => all.has(i.toLowerCase())));
        },
        async rewardBalances() { return undefined; },
        async stake(list) {
            // GetFilteredDelegationsAndRewardAccounts: [delegations, rewards]; an account is registered iff it has a reward entry
            const creds = [...new Map(list.map((c) => [`${c.type}:${c.hex}`, { t: c.type, h: c.hex.toLowerCase() }])).values()]
                .sort((a, b) => a.t - b.t || (a.h < b.h ? -1 : 1));
            if (!creds.length) return null;
            const set = new CborTag(258, new CborArray(creds.map((c) => new CborArray([U(c.t), new CborBytes(Uint8Array.from(Buffer.from(c.h, "hex")))]))));
            const res = await query(blockQuery(new CborArray([U(10), set]))) as CborArray;
            const [deleg, rewards] = (res.array[0] as CborArray).array as [CborMap, CborMap];
            const key = (k: CborObj) => { const [t, h] = (k as CborArray).array as [CborUInt, CborBytes]; return `${Number(t.num)}:${toHex(h.bytes)}`; };
            return {
                registered: new Set(rewards.map.map(({ k }) => key(k))),
                delegated: new Map(deleg.map.map(({ k, v }) => [key(k), toHex((v as CborBytes).bytes)])),
            };
        },
        epochNetwork: () => epochNetwork,
    };
}

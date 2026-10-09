/**
 * UTxO RPC v1alpha QueryService: ReadParams, ReadUtxos, SearchUtxos, ReadData, ReadTx,
 * ReadGenesis, ReadEraSummary.
 */
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { cardano, query, type queryConnect } from "@utxorpc/spec";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { addressString } from "../../network/n2c/utxoCbor";
import { assetPrefix, credPrefix, datumPrefix, IDX_DELEGATION, IDX_PAYMENT, txOutFacts } from "../../ledger/utxoIndex";
import { keyRef, type UtxoReads } from "../../ledger/utxoStore";
import { selectedTip } from "../../storage/blockReads";
import { parseCbor } from "../../consensus/plutus/cbor";
import { blockTxs, plutusDataFromBytes, u8 } from "./mapper";
import { pparamsFromRecord, genesisMsg, eraSummariesMsg } from "./params";
import { applyMask, bad, ledgerTipChainPoint, mapBlock, needStore, needUtxos, notFound, refFields, resolverFor, tipPoint, txoRefKey, unavailable, utxoToAny, type UtxorpcLimits } from "./common";
import { utxoPredicateMatches } from "./predicates";
import { heightOf } from "./chain";
import type { UtxorpcProvider } from "./provider";

type QueryImpl = ServiceImpl<typeof queryConnect.QueryService>;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const set = (b: Uint8Array | undefined): b is Uint8Array => !!b && b.length > 0;

/** Current protocol parameters (the tip's epoch) as `PParams`. */
export async function currentPParams(p: UtxorpcProvider): Promise<cardano.PParams | null> {
    const store = needStore(p);
    const tip = await selectedTip(store);
    if (!tip) return null;
    const raw = await p.pparams(p.epochOfSlot(BigInt(tip.slot)));
    return raw ? pparamsFromRecord(raw) : null;
}

// ---------------------------------------------------------------- search candidates

type Pred = query.UtxoPredicate;

/**
 * Output keys a predicate can only match among (from the indexes), or null when it names nothing
 * indexable (then the search is refused as too broad, like Dolos).
 */
function candidates(reads: UtxoReads, pred: Pred, limit: number): Map<string, Uint8Array> | null {
    const sets: Array<Map<string, Uint8Array>> = [];
    const take = (keys: Uint8Array[]) => {
        if (keys.length > limit) throw new ConnectError(`the predicate touches more than ${limit} outputs: narrow it down`, Code.ResourceExhausted);
        const m = new Map<string, Uint8Array>();
        for (const k of keys) m.set(hex(k), k);
        sets.push(m);
    };
    const m = pred.match?.utxoPattern;
    if (m?.case === "cardano") {
        const { address: a, asset } = m.value;
        if (a) {
            if (set(a.exactAddress)) {
                const s = addressString(a.exactAddress);
                if (!s) throw bad("exact_address does not decode");
                take(reads.addressRefKeys(s, limit + 1));
            }
            for (const [kind, part, label] of [[IDX_PAYMENT, a.paymentPart, "payment_part"], [IDX_DELEGATION, a.delegationPart, "delegation_part"]] as const) {
                if (!set(part)) continue;
                if (part.length !== 28) throw bad(`${label} must be a 28-byte credential hash, got ${part.length} bytes`);
                take(reads.indexRefKeys(credPrefix(kind, part), limit + 1));
            }
        }
        if (asset && (set(asset.policyId) || set(asset.assetName))) {
            if (!set(asset.policyId)) throw bad("an asset name query needs a policy_id");
            if (asset.policyId.length !== 28) throw bad(`policy_id must be 28 bytes, got ${asset.policyId.length}`);
            take(reads.indexRefKeys(assetPrefix(asset.policyId, set(asset.assetName) ? asset.assetName : undefined), limit + 1));
        }
    }
    const all = pred.allOf.map((x) => candidates(reads, x, limit)).filter((x): x is Map<string, Uint8Array> => !!x);
    sets.push(...all);
    if (pred.anyOf.length) {
        const parts = pred.anyOf.map((x) => candidates(reads, x, limit));
        if (parts.every((x) => !!x)) {
            const u = new Map<string, Uint8Array>();
            for (const part of parts) for (const [k, v] of part!) u.set(k, v);
            sets.push(u);
        }
    }
    if (!sets.length) return null;
    sets.sort((x, y) => x.size - y.size);
    const [first, ...rest] = sets;
    const out = new Map<string, Uint8Array>();
    for (const [k, v] of first!) if (rest.every((s) => s.has(k))) out.set(k, v);
    return out;
}

// ---------------------------------------------------------------- ReadData / ReadTx helpers

/** A datum by hash: an inline datum of a live output, else a witness datum of the transaction that made a datum-hash output (when the explorer knows its block). */
async function findDatum(p: UtxorpcProvider, reads: UtxoReads, hash: Uint8Array): Promise<Uint8Array | null> {
    const keys = reads.indexRefKeys(datumPrefix(hash), 64);
    const producers = new Set<string>();
    for (const k of keys) {
        const r = reads.getByKey(k);
        if (!r) continue;
        const f = txOutFacts(r.tx_out);
        if (f.inlineDatum) {
            const b = Uint8Array.from(Buffer.from(f.inlineDatum, "hex"));
            if (Buffer.from(blake2b_256(b)).equals(Buffer.from(hash))) return b;
        } else if (f.datumHash === hex(hash)) producers.add(keyRef(k).split(":")[0]!);
    }
    for (const txId of producers) {
        const loc = await p.txLocation(txId);
        const store = p.blockStore();
        const block = loc && store ? await store.byHash(loc.blockHash) : null;
        const tx = block ? blockTxs(block.bytes).find((t) => t.id === txId) : null;
        const w = tx?.msg.witnesses;
        if (!tx || !w) continue;
        const raw = datumFromTxBytes(tx.nativeBytes, hash);
        if (raw) return raw;
    }
    return p.datum(hex(hash));
}

/** A witness datum of a transaction's bytes by hash (original bytes). */
export function datumFromTxBytes(txBytes: Uint8Array, hash: Uint8Array): Uint8Array | null {
    try {
        const n = parseCbor(txBytes);
        if (n.t !== "a") return null;
        const w = n.v[1];
        if (!w || w.t !== "m") return null;
        for (const [k, v] of w.v) {
            if (k.t !== "u" || k.v !== 4n) continue;
            const list = v.t === "tag" ? v.v : v;
            if (list.t !== "a") continue;
            for (const d of list.v) {
                const b = txBytes.subarray(d.s, d.e);
                if (Buffer.from(blake2b_256(b)).equals(Buffer.from(hash))) return b.slice();
            }
        }
    } catch { /* not a transaction */ }
    return null;
}

/** A transaction on the selected chain: the explorer's location, else a scan of the volatile blocks. */
async function findChainTx(p: UtxorpcProvider, idHex: string) {
    const store = needStore(p);
    const loc = await p.txLocation(idHex);
    if (loc) {
        const b = await store.byHash(loc.blockHash);
        const t = b ? mapBlock(p, b, { resolve: false }).txs.find((x) => x.id === idHex) : null;
        if (b && t) return { block: b, tx: t };
    }
    const tip = await selectedTip(store);
    if (!tip) return null;
    for (const v of store.volatileChain(tip.hash)) {
        const b = { slot: v.slot, hash: v.hash, bytes: v.bytes, headerOffset: v.headerOffset, headerSize: v.headerSize, immutable: false };
        let txs;
        try { txs = blockTxs(v.bytes); } catch { continue; }
        const t = txs.find((x) => x.id === idHex);
        if (t) return { block: b, tx: t };
    }
    return null;
}

// ---------------------------------------------------------------- service

export function queryService(p: UtxorpcProvider, limits: UtxorpcLimits): Partial<QueryImpl> {
    let genesisCache: ReturnType<typeof genesisMsg> | null = null;
    return {
        async readParams(req) {
            const params = await currentPParams(p);
            if (!params) throw unavailable("no protocol parameters stored for the tip's epoch");
            return applyMask(new query.ReadParamsResponse({ values: new query.AnyChainParams({ params: { case: "cardano", value: params } }), ledgerTip: await ledgerTipChainPoint(p) }), req.fieldMask);
        },

        async readUtxos(req) {
            if (req.keys.length > limits.maxUtxoKeys) throw bad(`too many keys: ${req.keys.length} > ${limits.maxUtxoKeys}`);
            const reads = needUtxos(p);
            const items: query.AnyUtxoData[] = [];
            for (const k of req.keys) {
                const r = reads.get(txoRefKey(k));
                const a = r ? utxoToAny(r) : null;
                if (a) items.push(a);
            }
            return applyMask(new query.ReadUtxosResponse({ items, ledgerTip: await ledgerTipChainPoint(p) }), req.fieldMask);
        },

        async searchUtxos(req) {
            if (req.maxItems < 0) throw bad(`max_items ${req.maxItems} must not be negative`);
            if (req.maxItems > limits.maxSearchItems) throw bad(`max_items ${req.maxItems} exceeds the maximum of ${limits.maxSearchItems}`);
            const max = req.maxItems || limits.maxSearchItems;
            if (!req.predicate) throw bad("criteria too broad: give a predicate");
            if (req.startToken && !/^[0-9a-f]{68}$/.test(req.startToken)) throw bad("invalid start_token");
            const reads = needUtxos(p);
            const cands = candidates(reads, req.predicate, limits.maxSearchScan);
            if (!cands) throw bad("criteria too broad: match an address, a payment or delegation part, or an asset policy");
            const keys = [...cands.keys()].sort();
            let i = 0;
            if (req.startToken) { while (i < keys.length && keys[i]! <= req.startToken) i++; }
            const items: query.AnyUtxoData[] = [];
            let nextToken = "", lastKey = "";
            for (; i < keys.length; i++) {
                const r = reads.getByKey(cands.get(keys[i]!)!);
                const a = r ? utxoToAny(r) : null;
                if (!a || a.parsedState.case !== "cardano" || !utxoPredicateMatches(req.predicate as any, a.parsedState.value)) continue;
                if (items.length === max) { nextToken = lastKey; break; } // one more match exists: the page ends at the previous one
                items.push(a);
                lastKey = keys[i]!;
            }
            return applyMask(new query.SearchUtxosResponse({ items, ledgerTip: await ledgerTipChainPoint(p), nextToken }), req.fieldMask);
        },

        async readData(req) {
            if (req.keys.length > limits.maxUtxoKeys) throw bad(`too many keys: ${req.keys.length} > ${limits.maxUtxoKeys}`);
            const reads = needUtxos(p);
            const values: query.AnyChainDatum[] = [];
            for (const key of req.keys) {
                if (key.length !== 32) throw bad(`datum hash must be 32 bytes, got ${key.length}`);
                const raw = await findDatum(p, reads, key);
                if (!raw) continue;
                let parsed: cardano.PlutusData | undefined;
                try { parsed = plutusDataFromBytes(raw); } catch { parsed = undefined; }
                values.push(new query.AnyChainDatum({ nativeBytes: u8(raw), key: u8(key), parsedState: parsed ? { case: "cardano", value: parsed } : { case: undefined } }));
            }
            return applyMask(new query.ReadDataResponse({ values, ledgerTip: await ledgerTipChainPoint(p) }), req.fieldMask);
        },

        async readTx(req) {
            if (req.hash.length !== 32) throw bad(`tx hash must be 32 bytes, got ${req.hash.length}`);
            const found = await findChainTx(p, hex(req.hash));
            if (!found) throw notFound(`transaction ${hex(req.hash)} not found (the explorer index locates transactions older than the volatile blocks)`);
            const resolve = resolverFor(p, found.block);
            const tx = blockTxs(found.block.bytes, resolve).find((t) => t.id === found.tx.id)!;
            const point = { slot: BigInt(found.block.slot), hash: found.block.hash, height: heightOf(found.block) };
            return applyMask(new query.ReadTxResponse({
                tx: new query.AnyChainTx({ nativeBytes: u8(tx.nativeBytes), chain: { case: "cardano", value: tx.msg }, blockRef: new query.ChainPoint(refFields(p, point)) }),
                ledgerTip: await ledgerTipChainPoint(p),
            }), req.fieldMask);
        },

        async readGenesis(req) {
            genesisCache ??= genesisMsg(p.genesisFiles());
            const g = genesisCache;
            return applyMask(new query.ReadGenesisResponse({ genesis: u8(g.hash), caip2: g.caip2, config: { case: "cardano", value: g.genesis } }), req.fieldMask);
        },

        async readEraSummary(req) {
            const store = needStore(p);
            const tip = await tipPoint(store);
            const tipBlock = tip ? await store.byHash(tip.hash) : null;
            const eraTag = tipBlock ? tipBlock.bytes[1]! : 1;
            const summary = p.eraSummary(Math.max(0, eraTag - 1), tip?.slot ?? 0n);
            const start = p.systemStartMs();
            if (!summary || start == null) throw unavailable("the era history of this network is unknown");
            const params = tip ? await currentPParams(p) : null;
            return applyMask(new query.ReadEraSummaryResponse({ summary: { case: "cardano", value: eraSummariesMsg(summary, start, params ?? undefined) } }), req.fieldMask);
        },
    };
}

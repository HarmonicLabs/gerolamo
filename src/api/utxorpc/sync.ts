/**
 * UTxO RPC v1alpha SyncService: FetchBlock, DumpHistory, FollowTip (reset → apply / undo, see
 * chain.ts), ReadTip; and WatchService WatchTx (matching transactions of applied / undone blocks,
 * `idle` for an applied block without a match).
 */
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import { cardano, sync, watch, type syncConnect, type watchConnect } from "@utxorpc/spec";
import type { BlockRecord } from "../../storage/blockStore";
import { u8 } from "./mapper";
import { bad, chainWaiter, mapBlock, needStore, notFound, refFields, tipPoint, unavailable, type UtxorpcLimits } from "./common";
import { findBlock, findIntersect, followChain, historyPage, pointOf, type Point } from "./chain";
import { needsResolvedInputs, txPredicateMatches, type AnyTxPredicate } from "./predicates";
import type { UtxorpcProvider } from "./provider";

type SyncImpl = ServiceImpl<typeof syncConnect.SyncService>;
type WatchImpl = ServiceImpl<typeof watchConnect.WatchService>;

function anyBlock(p: UtxorpcProvider, b: BlockRecord): sync.AnyChainBlock {
    const m = mapBlock(p, b, { resolve: true });
    return new sync.AnyChainBlock({ nativeBytes: u8(b.bytes), chain: { case: "cardano", value: m.block } });
}

const syncRef = (p: UtxorpcProvider, pt: Point) => new sync.BlockRef(refFields(p, pt));

function intersectPoints(refs: Array<{ slot: bigint; hash: Uint8Array }>, limits: UtxorpcLimits) {
    if (refs.length > limits.maxBlockRefs) throw bad(`too many block refs: ${refs.length} > ${limits.maxBlockRefs}`);
    return refs.map((r) => ({ slot: r.slot, hash: r.hash }));
}

export function syncService(p: UtxorpcProvider, limits: UtxorpcLimits): Partial<SyncImpl> {
    return {
        async fetchBlock(req) {
            if (req.ref.length > limits.maxBlockRefs) throw bad(`too many block refs: ${req.ref.length} > ${limits.maxBlockRefs}`);
            const store = needStore(p);
            const block: sync.AnyChainBlock[] = [];
            for (const r of req.ref) {
                const b = await findBlock(store, { slot: r.slot, hash: r.hash, height: r.height });
                if (!b) throw notFound(`block not found: slot ${r.slot} hash ${Buffer.from(r.hash).toString("hex") || "-"}`);
                block.push(anyBlock(p, b));
            }
            return new sync.FetchBlockResponse({ block });
        },

        async dumpHistory(req) {
            if (req.maxItems > limits.maxHistoryItems) throw bad(`max_items must be at most ${limits.maxHistoryItems}`);
            const store = needStore(p);
            let from = 0;
            const t = req.startToken;
            if (t && (t.hash.length || t.slot > 0n || t.height > 0n)) {
                const b = await findBlock(store, { slot: t.slot, hash: t.hash, height: t.height });
                if (!b) throw notFound("start_token block not found");
                from = b.slot;
            }
            const page = await historyPage(store, from, req.maxItems);
            return new sync.DumpHistoryResponse({ block: page.blocks.map((b) => anyBlock(p, b)), nextToken: page.next ? syncRef(p, pointOf(page.next)) : undefined });
        },

        async *followTip(req, ctx: HandlerContext) {
            const store = needStore(p);
            const start = await findIntersect(store, intersectPoints(req.intersect, limits));
            if (!start) throw notFound("none of the intersect points is on the selected chain");
            for await (const ev of followChain(store, start, { signal: ctx.signal, waitForChange: chainWaiter(p) })) {
                const tip = await tipPoint(store);
                const tipRef = tip ? syncRef(p, tip) : undefined;
                if (ev.kind === "reset") yield new sync.FollowTipResponse({ action: { case: "reset", value: syncRef(p, ev.point) }, tip: tipRef });
                else yield new sync.FollowTipResponse({ action: { case: ev.kind, value: anyBlock(p, ev.block) }, tip: tipRef });
            }
        },

        async readTip() {
            const store = needStore(p);
            const tip = await tipPoint(store);
            if (!tip) throw unavailable("the node has no chain yet");
            return new sync.ReadTipResponse({ tip: syncRef(p, tip) });
        },
    };
}

export function watchService(p: UtxorpcProvider, limits: UtxorpcLimits): Partial<WatchImpl> {
    return {
        async *watchTx(req, ctx: HandlerContext) {
            const store = needStore(p);
            const start = await findIntersect(store, intersectPoints(req.intersect, limits));
            if (!start) throw notFound("none of the intersect points is on the selected chain");
            const pred = req.predicate as unknown as AnyTxPredicate | undefined;
            const resolve = needsResolvedInputs(pred);
            for await (const ev of followChain(store, start, { signal: ctx.signal, waitForChange: chainWaiter(p) })) {
                if (ev.kind === "reset") continue;
                const m = mapBlock(p, ev.block, { resolve });
                const matched = m.txs.filter((t) => !pred || txPredicateMatches(pred, t.msg));
                if (!matched.length) {
                    if (ev.kind === "apply") yield new watch.WatchTxResponse({ action: { case: "idle", value: new watch.BlockRef({ slot: m.point.slot, hash: u8(m.point.hash), height: m.point.height }) } });
                    continue;
                }
                // the block travels with each match as its header (the SDK requires it); its bytes and body are left out
                const header = new cardano.Block({ header: m.block.header, timestamp: m.block.timestamp });
                for (const t of matched) {
                    const value = new watch.AnyChainTx({ chain: { case: "cardano", value: t.msg }, block: new watch.AnyChainBlock({ chain: { case: "cardano", value: header } }) });
                    yield new watch.WatchTxResponse({ action: { case: ev.kind, value } });
                }
            }
        },
    };
}

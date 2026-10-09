/** Gerolamo extensions beside the Blockfrost paths (the explorer UI uses them). */
import { getBlockListRowByHash, getBlockListRowBySlot, getEpochNonce, getMaxSlot, getNetworkSnapshot, getTxByHash, getUtxoByRef, listBlocksDesc } from "../../../db";
import { epochForSlot } from "../../../utils/epochFromSlotCalculations";
import { parseStoredTxOut } from "../../../db/minibf/txOutMetadata";
import { badRequest, notFound } from "../http";
import { route, type Route } from "../router";
import { amountOf, assetsOfJson, bfBlock, blockByHeight, tipInfo } from "../chain";

export const extensionRoutes: Route[] = [
    // newest first, cursor paging (Blockfrost has no block list)
    route("GET", "/blocks", async (c) => {
        const limit = Math.max(1, Math.min(100, Number(c.url.searchParams.get("limit") ?? 20) || 20));
        const before = c.url.searchParams.get("before");
        let beforeSlot: number | undefined, beforeIsEbb: boolean | undefined;
        if (before) {
            if (/^[0-9a-f]{64}$/i.test(before)) {
                const cur = await getBlockListRowByHash(before.toLowerCase());
                if (!cur) throw notFound("Cursor block not found");
                beforeSlot = cur.slot; beforeIsEbb = cur.blockNo == null;
            } else if (/^\d+$/.test(before)) { beforeSlot = Number(before); beforeIsEbb = c.url.searchParams.get("before_ebb") === "1"; }
            else throw badRequest("`before` must be a slot number or a 64-hex block hash");
        }
        const tip = await tipInfo();
        const rows = await listBlocksDesc({ limit, beforeSlot, beforeIsEbb });
        const out: unknown[] = [];
        for (const r of rows) out.push(await bfBlock(r, c.net, tip));
        return out;
    }),
    route("GET", "/blocks/height/{n}", async (c) => {
        if (!/^\d+$/.test(c.params.n!)) throw badRequest("height must be a number");
        const row = await blockByHeight(Number(c.params.n));
        if (!row) throw notFound();
        return bfBlock(row, c.net);
    }),
    route("GET", "/search", async (c) => {
        const q = (c.url.searchParams.get("q") ?? "").trim();
        if (!q) throw badRequest("q required");
        if (/^[0-9a-f]{64}$/i.test(q)) {
            const hex = q.toLowerCase();
            if (await getTxByHash(hex)) return { kind: "tx", id: hex };
            if (await getBlockListRowByHash(hex)) return { kind: "block", id: hex };
            return { kind: "unknown", id: hex, message: "no block or transaction with that hash" };
        }
        if (/^\d+$/.test(q)) {
            const n = Number(q);
            const byHeight = await blockByHeight(n);
            if (byHeight) return { kind: "block", id: byHeight.hash, height: n };
            const bySlot = await getBlockListRowBySlot(n);
            if (bySlot) return { kind: "block", id: bySlot.hash, slot: n };
            return { kind: "unknown", id: q, message: "no block at that height or slot" };
        }
        if (/^(addr|addr_test|Ae2|DdzFF)/.test(q)) return { kind: "address", id: q };
        if (/^(stake|stake_test)1/.test(q)) return { kind: "stake", id: q };
        if (/^pool1/.test(q)) return { kind: "pool", id: q };
        if (/^drep1/.test(q)) return { kind: "drep", id: q };
        if (/^asset1|^[0-9a-f]{56,}$/i.test(q)) return { kind: "asset", id: q };
        return { kind: "unknown", id: q };
    }),
    // one output if unspent
    route("GET", "/txs/{hash}/utxos/{index}", async (c) => {
        const ref = `${c.params.hash!.toLowerCase()}:${c.params.index}`;
        const utxo = await getUtxoByRef(ref);
        if (!utxo) throw notFound();
        const raw = Array.isArray(utxo) ? (typeof utxo[1] === "string" ? utxo[1] : JSON.stringify(utxo[1] ?? {})) : String((utxo as any).tx_out ?? "");
        const parsed = parseStoredTxOut(raw);
        return { address: parsed.address, tx_hash: c.params.hash!.toLowerCase(), output_index: Number(c.params.index), amount: amountOf(parsed.amount, assetsOfJson(parsed.assets)) };
    }),
    // node / index status
    route("GET", "/gerolamo/status", async (c) => {
        const snap = await getNetworkSnapshot();
        const tipSlot = Number(await getMaxSlot());
        const epoch = Number(epochForSlot(tipSlot, c.net));
        return { tip: { slot: snap.tipSlot, hash: snap.tipHash, epoch, epoch_nonce: await getEpochNonce(epoch).catch(() => null) }, utxo_count: snap.utxoCount, index: { mb_tx: snap.mbTxCount, mb_cursor_slot: snap.mbCursorSlot, lag_slots: snap.lagSlots } };
    }),
];

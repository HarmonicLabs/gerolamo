/**
 * MiniBF index writer — apply / rollback derived projections.
 *
 * Best-effort: never throw into ChainSync / apply hot path.
 * Does NOT write ledger tables (blocks, utxo, utxo_deltas).
 */

import { logger } from "../../utils/logger";
import type { MbSql } from "./schema";

export type MbTxOut = {
    outputIndex: number;
    address: string;
    lovelace: string;
    assetsJson?: string | null;
    datumHash?: string | null;
    inlineDatumCbor?: string | null;
    scriptRefHash?: string | null;
};

export type MbTxIn = {
    inputIndex: number;
    prevTxHash: string;
    prevOutputIndex: number;
};

export type MbTxDelta = {
    txHash: string;
    blockHash: Uint8Array;
    slot: number;
    txIndex: number;
    /** Chain height of the containing block. */
    blockHeight?: number | null;
    fee?: string | null;
    size?: number | null;
    invalidBefore?: string | null;
    invalidHereafter?: string | null;
    /** address → direction */
    addresses: Map<string, "in" | "out" | "both">;
    inputs: MbTxIn[];
    outputs: MbTxOut[];
};

/**
 * Upsert one tx into mb_* (+ caller may dual-write legacy tables).
 * Safe on missing tables (no-op warn).
 */
export async function applyMbTx(db: MbSql, d: MbTxDelta): Promise<void> {
    try {
        const txHash = d.txHash.toLowerCase();
        if (!txHash || txHash.length < 64) return;

        await db`
			INSERT INTO mb_tx (
				tx_hash, block_hash, slot, tx_index, fee, size,
				invalid_before, invalid_hereafter, block_height
			) VALUES (
				${txHash},
				${d.blockHash},
				${d.slot},
				${d.txIndex},
				${d.fee ?? null},
				${d.size ?? null},
				${d.invalidBefore ?? null},
				${d.invalidHereafter ?? null},
				${d.blockHeight ?? null}
			)
			ON CONFLICT(tx_hash) DO UPDATE SET
				block_hash = excluded.block_hash,
				slot = excluded.slot,
				tx_index = excluded.tx_index,
				block_height = excluded.block_height,
				fee = excluded.fee,
				size = excluded.size,
				invalid_before = excluded.invalid_before,
				invalid_hereafter = excluded.invalid_hereafter
		`;

        await db`
			INSERT INTO mb_block_tx (block_hash, tx_hash, tx_index)
			VALUES (${d.blockHash}, ${txHash}, ${d.txIndex})
			ON CONFLICT(block_hash, tx_hash) DO UPDATE SET
				tx_index = excluded.tx_index
		`;

        // Inputs → mark prior outs spent + record mb_tx_in
        for (const inn of d.inputs) {
            const prev = inn.prevTxHash.toLowerCase();
            await db`
				INSERT INTO mb_tx_in (
					tx_hash, input_index, prev_tx_hash, prev_output_index
				) VALUES (
					${txHash}, ${inn.inputIndex}, ${prev}, ${inn.prevOutputIndex}
				)
				ON CONFLICT(tx_hash, input_index) DO UPDATE SET
					prev_tx_hash = excluded.prev_tx_hash,
					prev_output_index = excluded.prev_output_index
			`;
            await db`
				UPDATE mb_tx_out
				SET spent_by_tx = ${txHash}, spent_at_slot = ${d.slot}
				WHERE tx_hash = ${prev} AND output_index = ${inn.prevOutputIndex}
			`;
        }

        // Outputs
        for (const out of d.outputs) {
            const addr = out.address || "";
            await db`
				INSERT INTO mb_tx_out (
					tx_hash, output_index, address, lovelace, assets_json,
					datum_hash, inline_datum_cbor, script_ref_hash,
					spent_by_tx, spent_at_slot
				) VALUES (
					${txHash},
					${out.outputIndex},
					${addr},
					${out.lovelace || "0"},
					${out.assetsJson ?? null},
					${out.datumHash ?? null},
					${out.inlineDatumCbor ?? null},
					${out.scriptRefHash ?? null},
					NULL,
					NULL
				)
				ON CONFLICT(tx_hash, output_index) DO UPDATE SET
					address = excluded.address,
					lovelace = excluded.lovelace,
					assets_json = excluded.assets_json,
					datum_hash = excluded.datum_hash,
					inline_datum_cbor = excluded.inline_datum_cbor,
					script_ref_hash = excluded.script_ref_hash
			`;
        }

        for (const [address, direction] of d.addresses) {
            if (!address || address.length < 10) continue;
            await db`
				INSERT INTO mb_address_tx (address, tx_hash, slot, tx_index, direction)
				VALUES (${address}, ${txHash}, ${d.slot}, ${d.txIndex}, ${direction})
				ON CONFLICT(address, tx_hash) DO UPDATE SET
					slot = excluded.slot,
					tx_index = excluded.tx_index,
					direction = CASE
						WHEN mb_address_tx.direction = excluded.direction
							THEN mb_address_tx.direction
						ELSE 'both'
					END
			`;
        }

        // Advance cursor (monotonic best-effort)
        await db`
			UPDATE mb_cursor SET
				tip_slot = MAX(tip_slot, ${d.slot}),
				tip_hash = ${d.blockHash},
				updated_at = strftime('%s','now')
			WHERE id = 1
		`;
    } catch (e: any) {
        logger.warn(
            `MiniBF applyMbTx failed for ${d.txHash}: ${e?.message || e}`,
        );
    }
}

/**
 * Rewind mb_* projections to tip slot (inclusive keep).
 * Call from rollbackChainTo AFTER capturing tip, BEFORE or WITH ledger deletes.
 */
export async function rollbackMbToSlot(
    db: MbSql,
    slot: number | bigint,
): Promise<void> {
    const s = Number(slot);
    if (!Number.isFinite(s)) return;
    try {
        // Unspend outs that were spent by rolled-back txs
        await db`
			UPDATE mb_tx_out
			SET spent_by_tx = NULL, spent_at_slot = NULL
			WHERE spent_by_tx IN (
				SELECT tx_hash FROM mb_tx WHERE slot > ${s}
			)
		`;

        await db`
			DELETE FROM mb_tx_in WHERE tx_hash IN (
				SELECT tx_hash FROM mb_tx WHERE slot > ${s}
			)
		`;
        await db`
			DELETE FROM mb_tx_out WHERE tx_hash IN (
				SELECT tx_hash FROM mb_tx WHERE slot > ${s}
			)
		`;
        await db`
			DELETE FROM mb_address_tx WHERE slot > ${s}
		`;
        await db`
			DELETE FROM mb_block_tx WHERE tx_hash IN (
				SELECT tx_hash FROM mb_tx WHERE slot > ${s}
			)
		`;
        // Also legacy thin indexes if present
        try {
            await db`DELETE FROM address_tx WHERE slot > ${s}`;
            await db`DELETE FROM tx_index WHERE slot > ${s}`;
            // block_tx has no slot — join via mb_tx already covered new; legacy:
            await db`
				DELETE FROM block_tx WHERE tx_hash IN (
					SELECT tx_hash FROM tx_index WHERE slot > ${s}
				)
			`;
        } catch {
            /* legacy tables may lag schema */
        }

        await db`DELETE FROM mb_tx WHERE slot > ${s}`;

        await db`
			UPDATE mb_cursor SET
				tip_slot = ${s},
				updated_at = strftime('%s','now')
			WHERE id = 1
		`;
    } catch (e: any) {
        logger.warn(`MiniBF rollbackMbToSlot(${s}): ${e?.message || e}`);
    }
}

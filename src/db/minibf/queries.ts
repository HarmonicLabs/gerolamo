/**
 * MiniBF read queries over mb_* (+ legacy fallback).
 * Read-only w.r.t. ledger tables except intentional joins for tip/utxo.
 */

import { sql } from "../../sql";
import { toHex } from "@harmoniclabs/uint8array-utils";

function firstScalar(row: unknown): unknown {
    if (row == null) return undefined;
    if (Array.isArray(row)) return row[0];
    if (typeof row === "object") {
        const o = row as Record<string, unknown>;
        if ("c" in o) return o.c;
        if ("tip_slot" in o) return o.tip_slot;
        const vals = Object.values(o);
        return vals.length ? vals[0] : undefined;
    }
    return row;
}

function blobToHex(val: unknown): string | null {
    if (val == null) return null;
    if (typeof val === "string") {
        if (/^[0-9a-fA-F]+$/.test(val) && val.length % 2 === 0) {
            return val.toLowerCase();
        }
        return val;
    }
    if (val instanceof Uint8Array) return toHex(val);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) {
        return toHex(new Uint8Array(val));
    }
    try {
        return toHex(new Uint8Array(val as ArrayBuffer));
    } catch {
        return String(val);
    }
}

export type MbTxRow = {
    tx_hash: string;
    block_hash: string | null;
    slot: number;
    tx_index: number;
    fee: string | null;
    size: number | null;
    invalid_hereafter: string | null;
    invalid_before: string | null;
};

export type MbCursor = {
    tipSlot: number;
    tipHash: string | null;
    schemaVersion: number;
};

export type MbIndexStats = {
    mbTx: number;
    mbAddressTx: number;
    cursorSlot: number;
};

export async function getMbCursor(): Promise<MbCursor> {
    try {
        const rows = await sql`
			SELECT tip_slot, tip_hash, schema_version FROM mb_cursor WHERE id = 1 LIMIT 1
		`.values();
        if (!rows?.length) {
            return { tipSlot: 0, tipHash: null, schemaVersion: 0 };
        }
        const r = rows[0] as any;
        if (Array.isArray(r)) {
            return {
                tipSlot: Number(r[0]) || 0,
                tipHash: blobToHex(r[1]),
                schemaVersion: Number(r[2]) || 0,
            };
        }
        return {
            tipSlot: Number(r.tip_slot) || 0,
            tipHash: blobToHex(r.tip_hash),
            schemaVersion: Number(r.schema_version) || 0,
        };
    } catch {
        return { tipSlot: 0, tipHash: null, schemaVersion: 0 };
    }
}

export async function getMbTxByHash(txHash: string): Promise<MbTxRow | null> {
    const h = txHash.replace(/^0x/i, "").toLowerCase();
    // Prefer mb_tx; fallback legacy tx_index
    try {
        const rows = await sql`
			SELECT tx_hash, block_hash, slot, tx_index, fee, size,
			       invalid_hereafter, invalid_before
			FROM mb_tx WHERE tx_hash = ${h} LIMIT 1
		`.values();
        if (rows?.length) {
            const r = rows[0] as any;
            if (Array.isArray(r)) {
                return {
                    tx_hash: String(r[0] ?? ""),
                    block_hash: blobToHex(r[1]),
                    slot: Number(r[2]),
                    tx_index: Number(r[3]) || 0,
                    fee: r[4] != null ? String(r[4]) : null,
                    size: r[5] != null ? Number(r[5]) : null,
                    invalid_hereafter: r[6] != null ? String(r[6]) : null,
                    invalid_before: r[7] != null ? String(r[7]) : null,
                };
            }
            return {
                tx_hash: String(r.tx_hash ?? ""),
                block_hash: blobToHex(r.block_hash),
                slot: Number(r.slot),
                tx_index: Number(r.tx_index) || 0,
                fee: r.fee != null ? String(r.fee) : null,
                size: r.size != null ? Number(r.size) : null,
                invalid_hereafter:
                    r.invalid_hereafter != null
                        ? String(r.invalid_hereafter)
                        : null,
                invalid_before:
                    r.invalid_before != null ? String(r.invalid_before) : null,
            };
        }
    } catch {
        /* fall through */
    }
    try {
        const rows = await sql`
			SELECT tx_hash, block_hash, slot, fee, size, invalid_hereafter, invalid_before
			FROM tx_index WHERE tx_hash = ${h} LIMIT 1
		`.values();
        if (!rows?.length) return null;
        const r = rows[0] as any;
        if (Array.isArray(r)) {
            return {
                tx_hash: String(r[0] ?? ""),
                block_hash: blobToHex(r[1]),
                slot: Number(r[2]),
                tx_index: 0,
                fee: r[3] != null ? String(r[3]) : null,
                size: r[4] != null ? Number(r[4]) : null,
                invalid_hereafter: r[5] != null ? String(r[5]) : null,
                invalid_before: r[6] != null ? String(r[6]) : null,
            };
        }
        return {
            tx_hash: String(r.tx_hash ?? ""),
            block_hash: blobToHex(r.block_hash),
            slot: Number(r.slot),
            tx_index: 0,
            fee: r.fee != null ? String(r.fee) : null,
            size: r.size != null ? Number(r.size) : null,
            invalid_hereafter:
                r.invalid_hereafter != null
                    ? String(r.invalid_hereafter)
                    : null,
            invalid_before:
                r.invalid_before != null ? String(r.invalid_before) : null,
        };
    } catch {
        return null;
    }
}

export type MbTxIo = {
    inputs: Array<{
        tx_hash: string;
        output_index: number;
        address: string | null;
        amount: Array<{ unit: string; quantity: string }>;
    }>;
    outputs: Array<{
        tx_hash: string;
        output_index: number;
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        collateral: boolean;
        reference: boolean;
    }>;
};

function assetsToBfAmount(
    lovelace: string,
    assetsJson: string | null | undefined,
): Array<{ unit: string; quantity: string }> {
    const out: Array<{ unit: string; quantity: string }> = [
        { unit: "lovelace", quantity: String(lovelace || "0") },
    ];
    if (!assetsJson) return out;
    try {
        const assets =
            typeof assetsJson === "string"
                ? JSON.parse(assetsJson)
                : assetsJson;
        if (assets && typeof assets === "object") {
            for (const [policy, names] of Object.entries(
                assets as Record<string, any>,
            )) {
                if (!policy || !names || typeof names !== "object") continue;
                for (const [name, qty] of Object.entries(
                    names as Record<string, any>,
                )) {
                    out.push({
                        unit: name ? `${policy}${name}` : policy,
                        quantity: String(qty),
                    });
                }
            }
        }
    } catch {
        /* */
    }
    return out;
}

/** Full IO from mb_tx_in/out when indexed; else empty arrays. */
export async function getMbTxUtxos(txHash: string): Promise<MbTxIo> {
    const h = txHash.replace(/^0x/i, "").toLowerCase();
    const empty: MbTxIo = { inputs: [], outputs: [] };
    try {
        const inRows = await sql`
			SELECT i.prev_tx_hash, i.prev_output_index, i.input_index,
			       o.address, o.lovelace, o.assets_json
			FROM mb_tx_in i
			LEFT JOIN mb_tx_out o
			  ON o.tx_hash = i.prev_tx_hash AND o.output_index = i.prev_output_index
			WHERE i.tx_hash = ${h}
			ORDER BY i.input_index ASC
		`.values();

        const inputs = (inRows as any[]).map((r) => {
            const a = Array.isArray(r);
            const prevHash = String(a ? r[0] : r.prev_tx_hash);
            const prevIdx = Number(a ? r[1] : r.prev_output_index);
            const address = a
                ? r[3] != null
                    ? String(r[3])
                    : null
                : r.address != null
                ? String(r.address)
                : null;
            const lovelace = a
                ? r[4] != null
                    ? String(r[4])
                    : "0"
                : r.lovelace != null
                ? String(r.lovelace)
                : "0";
            const assetsJson = a ? r[5] : r.assets_json;
            return {
                tx_hash: prevHash,
                output_index: prevIdx,
                address,
                amount: assetsToBfAmount(lovelace, assetsJson),
            };
        });

        const outRows = await sql`
			SELECT tx_hash, output_index, address, lovelace, assets_json,
			       datum_hash, inline_datum_cbor, script_ref_hash
			FROM mb_tx_out WHERE tx_hash = ${h}
			ORDER BY output_index ASC
		`.values();

        const outputs = (outRows as any[]).map((r) => {
            const a = Array.isArray(r);
            const lovelace = String(a ? r[3] ?? "0" : r.lovelace ?? "0");
            const assetsJson = a ? r[4] : r.assets_json;
            return {
                tx_hash: String(a ? r[0] : r.tx_hash),
                output_index: Number(a ? r[1] : r.output_index),
                address: String(a ? r[2] ?? "" : r.address ?? ""),
                amount: assetsToBfAmount(lovelace, assetsJson),
                data_hash: a
                    ? r[5] != null
                        ? String(r[5])
                        : null
                    : r.datum_hash != null
                    ? String(r.datum_hash)
                    : null,
                inline_datum: blobToHex(a ? r[6] : r.inline_datum_cbor),
                reference_script_hash: a
					? r[7] != null
						? String(r[7])
                        : null
                    : r.script_ref_hash != null
                    ? String(r.script_ref_hash)
                    : null,
                collateral: false,
                reference: false,
            };
        });

        return { inputs, outputs };
    } catch {
        return empty;
    }
}

export async function getMbAddressTxs(
    address: string,
    opts?: { count?: number; page?: number },
): Promise<{ tx_hash: string; slot: number; direction: string | null }[]> {
    const count = Math.min(Math.max(opts?.count ?? 20, 1), 100);
    const page = Math.max(opts?.page ?? 1, 1);
    const offset = (page - 1) * count;
    try {
        const rows = await sql`
			SELECT tx_hash, slot, direction FROM mb_address_tx
			WHERE address = ${address}
			ORDER BY slot DESC
			LIMIT ${count} OFFSET ${offset}
		`.values();
        if (rows?.length) {
            return (rows as any[]).map((r) => {
                if (Array.isArray(r)) {
                    return {
                        tx_hash: String(r[0]),
                        slot: Number(r[1]),
                        direction: r[2] != null ? String(r[2]) : null,
                    };
                }
                return {
                    tx_hash: String(r.tx_hash),
                    slot: Number(r.slot),
                    direction: r.direction != null ? String(r.direction) : null,
                };
            });
        }
    } catch {
        /* fall legacy */
    }
    try {
        const rows = await sql`
			SELECT tx_hash, slot, direction FROM address_tx
			WHERE address = ${address}
			ORDER BY slot DESC
			LIMIT ${count} OFFSET ${offset}
		`.values();
        return (rows as any[]).map((r) => {
            if (Array.isArray(r)) {
                return {
                    tx_hash: String(r[0]),
                    slot: Number(r[1]),
                    direction: r[2] != null ? String(r[2]) : null,
                };
            }
            return {
                tx_hash: String(r.tx_hash),
                slot: Number(r.slot),
                direction: r.direction != null ? String(r.direction) : null,
            };
        });
    } catch {
        return [];
    }
}

export async function getMbBlockTxHashes(
    blockHash: string | Uint8Array,
): Promise<{ tx_hash: string; tx_index: number }[]> {
    let hexKey: string;
    if (typeof blockHash === "string") {
        hexKey = blockHash.replace(/^0x/i, "").toUpperCase();
    } else if (blockHash instanceof Uint8Array) {
        hexKey = toHex(blockHash).toUpperCase();
    } else {
        try {
            hexKey = toHex(new Uint8Array(blockHash as any)).toUpperCase();
        } catch {
            return [];
        }
    }
    if (!/^[0-9A-F]+$/.test(hexKey) || hexKey.length % 2 !== 0) return [];

    try {
        const rows = await sql`
			SELECT tx_hash, tx_index FROM mb_block_tx
			WHERE hex(block_hash) = ${hexKey}
			ORDER BY tx_index ASC
		`.values();
        if (rows?.length) {
            return (rows as any[]).map((r) => {
                if (Array.isArray(r)) {
                    return { tx_hash: String(r[0]), tx_index: Number(r[1]) };
                }
                return {
                    tx_hash: String(r.tx_hash),
                    tx_index: Number(r.tx_index),
                };
            });
        }
    } catch {
        /* */
    }
    try {
        const rows = await sql`
			SELECT tx_hash, tx_index FROM block_tx
			WHERE hex(block_hash) = ${hexKey}
			ORDER BY tx_index ASC
		`.values();
        return (rows as any[]).map((r) => {
            if (Array.isArray(r)) {
                return { tx_hash: String(r[0]), tx_index: Number(r[1]) };
            }
            return { tx_hash: String(r.tx_hash), tx_index: Number(r.tx_index) };
        });
    } catch {
        return [];
    }
}

export async function countMbAddressTxs(address: string): Promise<number> {
    try {
        const rows = await sql`
			SELECT COUNT(*) AS c FROM mb_address_tx WHERE address = ${address}
		`.values();
        const r = rows?.[0] as any;
        const n = Number(Array.isArray(r) ? r[0] : r?.c ?? 0);
        if (n > 0) return n;
    } catch {
        /* */
    }
    try {
        const rows = await sql`
			SELECT COUNT(*) AS c FROM address_tx WHERE address = ${address}
		`.values();
        const r = rows?.[0] as any;
        return Number(Array.isArray(r) ? r[0] : r?.c ?? 0) || 0;
    } catch {
        return 0;
    }
}

export async function getMbIndexStats(): Promise<MbIndexStats> {
    let mbTx = 0;
    let mbAddressTx = 0;
    let cursorSlot = 0;
    try {
        const r1 = await sql`SELECT COUNT(*) AS c FROM mb_tx`.values();
        const a1 = r1?.[0] as any;
        mbTx = Number(Array.isArray(a1) ? a1[0] : a1?.c ?? 0) || 0;
        const r2 = await sql`SELECT COUNT(*) AS c FROM mb_address_tx`.values();
        const a2 = r2?.[0] as any;
        mbAddressTx = Number(Array.isArray(a2) ? a2[0] : a2?.c ?? 0) || 0;
        const cur = await getMbCursor();
        cursorSlot = cur.tipSlot;
    } catch {
        /* */
    }
    return { mbTx, mbAddressTx, cursorSlot };
}

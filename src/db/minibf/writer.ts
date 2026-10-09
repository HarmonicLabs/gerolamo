/**
 * MiniBF index writer — apply / rollback derived projections.
 *
 * Best-effort: never throw into ChainSync / apply hot path.
 * Does NOT write ledger tables (blocks, utxo, utxo_deltas).
 */

import { logger } from "../../utils/logger";
import type { MbSql } from "./schema";
import { blockFacts, type BlockFacts, type TxFact } from "./blockFacts";
import { credentialsOfAddress, typedOfRewardAccount } from "./cardanoIds";
import { bytesAt, hex, isNull, items } from "./cborWalk";
import { blake2b_256 } from "@harmoniclabs/crypto";

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
    /** False for a phase-2-invalid transaction: its inputs are the collateral, its output the collateral return. */
    valid?: boolean;
};

/** A block for the v2 indexes (its bytes are decoded in the worker, off the applier's thread). */
export type MbBlockMsg = {
    kind: "block";
    hash: Uint8Array;
    slot: number;
    height: number | null;
    epoch: number | null;
    epochSlot: number | null;
    bytes: Uint8Array;
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
				invalid_before, invalid_hereafter, block_height, valid_contract
			) VALUES (
				${txHash},
				${d.blockHash},
				${d.slot},
				${d.txIndex},
				${d.fee ?? null},
				${d.size ?? null},
				${d.invalidBefore ?? null},
				${d.invalidHereafter ?? null},
				${d.blockHeight ?? null},
				${d.valid === false ? 0 : 1}
			)
			ON CONFLICT(tx_hash) DO UPDATE SET
				valid_contract = excluded.valid_contract,
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

        // Inputs → mark prior outs spent + record mb_tx_in. One JSON-driven statement per
        // table instead of one statement per row: the per-row loops were 18 % of the
        // applier's main-thread time on preview (SQL profile 2026-09-06).
        if (d.inputs.length) {
            const ins = JSON.stringify(d.inputs.map((inn) => [inn.inputIndex, inn.prevTxHash.toLowerCase(), inn.prevOutputIndex]));
            await db`
				INSERT INTO mb_tx_in (tx_hash, input_index, prev_tx_hash, prev_output_index)
				SELECT ${txHash}, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]') FROM json_each(${ins}) AS j WHERE true
				ON CONFLICT(tx_hash, input_index) DO UPDATE SET
					prev_tx_hash = excluded.prev_tx_hash,
					prev_output_index = excluded.prev_output_index
			`;
            await db`
				UPDATE mb_tx_out
				SET spent_by_tx = ${txHash}, spent_at_slot = ${d.slot}
				WHERE (tx_hash, output_index) IN (SELECT json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]') FROM json_each(${ins}) AS j)
			`;
        }

        // Outputs
        if (d.outputs.length) {
            const outs = JSON.stringify(d.outputs.map((out) => { const cr = credentialsOfAddress(out.address || ""); return { i: out.outputIndex, a: out.address || "", l: out.lovelace || "0", j: out.assetsJson ?? null, d: out.datumHash ?? null, c: out.inlineDatumCbor ?? null, s: out.scriptRefHash ?? null, p: cr.payment, k: cr.stake }; }));
            await db`
				INSERT INTO mb_tx_out (
					tx_hash, output_index, address, lovelace, assets_json,
					datum_hash, inline_datum_cbor, script_ref_hash,
					spent_by_tx, spent_at_slot, payment_cred, stake_cred
				)
				SELECT ${txHash}, json_extract(j.value, '$.i'), json_extract(j.value, '$.a'), json_extract(j.value, '$.l'), json_extract(j.value, '$.j'),
					json_extract(j.value, '$.d'), json_extract(j.value, '$.c'), json_extract(j.value, '$.s'), NULL, NULL,
					json_extract(j.value, '$.p'), json_extract(j.value, '$.k')
				FROM json_each(${outs}) AS j WHERE true
				ON CONFLICT(tx_hash, output_index) DO UPDATE SET
					payment_cred = excluded.payment_cred,
					stake_cred = excluded.stake_cred,
					address = excluded.address,
					lovelace = excluded.lovelace,
					assets_json = excluded.assets_json,
					datum_hash = excluded.datum_hash,
					inline_datum_cbor = excluded.inline_datum_cbor,
					script_ref_hash = excluded.script_ref_hash
			`;
            const assetRows: Array<[number, string, string]> = [];
            for (const out of d.outputs) {
                if (!out.assetsJson) continue;
                try {
                    const a = JSON.parse(out.assetsJson) as Record<string, Record<string, string>>;
                    for (const [policy, names] of Object.entries(a)) for (const [name, qty] of Object.entries(names ?? {})) if (policy) assetRows.push([out.outputIndex, policy + name, String(qty)]);
                } catch { /* malformed assets: lovelace only */ }
            }
            if (assetRows.length) {
                await db`
					INSERT OR REPLACE INTO mb_tx_out_asset (tx_hash, output_index, unit, quantity)
					SELECT ${txHash}, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]') FROM json_each(${JSON.stringify(assetRows)}) AS j WHERE true
				`;
            }
        }

        const addrs: Record<string, string> = {};
        for (const [address, direction] of d.addresses) if (address && address.length >= 10) addrs[address] = direction;
        if (Object.keys(addrs).length) {
            await db`
				INSERT INTO mb_address_tx (address, tx_hash, slot, tx_index, direction)
				SELECT j.key, ${txHash}, ${d.slot}, ${d.txIndex}, j.value FROM json_each(${JSON.stringify(addrs)}) AS j WHERE true
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
        await rollbackMbV2ToSlot(db, s);
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

// ---------------------------------------------------------------- v2: block facts

const toText = (v: unknown): string => (v == null ? "" : String(v));
async function rows(db: MbSql, q: Promise<unknown> | any): Promise<unknown[][]> {
    const r = await (q.values ? q.values() : q);
    return (r as any[]).map((x) => (Array.isArray(x) ? x : Object.values(x)));
}

/** Script hash of a payment address (typed "01…" credential), or null. */
async function spentScriptHash(db: MbSql, txHash: string, index: number): Promise<string | null> {
    const r = await rows(db, (db as any)`SELECT payment_cred, address FROM mb_tx_out WHERE tx_hash = ${txHash} AND output_index = ${index}`);
    if (!r.length) return null;
    let pc = r[0]![0] == null ? null : toText(r[0]![0]);
    if (pc == null) pc = credentialsOfAddress(toText(r[0]![1])).payment;
    return pc && pc.length === 58 && pc.startsWith("01") ? pc.slice(2) : null;
}

/** Ledger order of credentials: script credentials before key credentials, then by hash. */
const credOrder = (typedHex: string): string => (typedHex.startsWith("01") && typedHex.length === 58 ? "0" + typedHex.slice(2) : "1" + typedHex);

/** The script a redeemer runs (Blockfrost `script_hash`), from its purpose and index. */
export async function redeemerScriptHash(db: MbSql | null, tx: TxFact, tag: number, index: number): Promise<string | null> {
    try {
        switch (tag) {
            case 0: {
                const ins = [...tx.inputs].sort((a, b) => (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.index - b.index));
                const i = ins[index];
                return i && db ? await spentScriptHash(db, i.txHash, i.index) : null;
            }
            case 1: return [...new Set(tx.mint.map((m) => m.policy))].sort()[index] ?? null;
            case 2: {
                const c = tx.certs[index];
                const t = c?.stake ?? (c?.drep_cred ? (c.drep_cred.type === 1 ? "01" : "") + c.drep_cred.hash : c?.cc_cold ? (c.cc_cold.type === 1 ? "01" : "") + c.cc_cold.hash : null);
                return t && t.length === 58 && t.startsWith("01") ? t.slice(2) : null;
            }
            case 3: {
                const ws = tx.withdrawals.map((w) => typedOfRewardAccount(w.rewardAccount) ?? "").sort((a, b) => (credOrder(a) < credOrder(b) ? -1 : 1));
                const t = ws[index];
                return t && t.startsWith("01") && t.length === 58 ? t.slice(2) : null;
            }
            case 4: {
                const group = (k: number) => (k <= 1 ? 0 : k <= 3 ? 1 : 2);
                const voters = [...new Map(tx.votes.map((v) => [`${v.voterKind}:${v.voterHash}`, v])).values()]
                    .sort((a, b) => group(a.voterKind) - group(b.voterKind) || (a.voterKind === 4 ? 0 : (b.voterKind & 1) - (a.voterKind & 1)) || (a.voterHash < b.voterHash ? -1 : 1));
                const v = voters[index];
                return v && (v.voterKind === 1 || v.voterKind === 3) ? v.voterHash : null;
            }
            case 5: {
                const p = tx.proposals[index];
                if (!p) return null;
                const f = items(p.action, 0);
                const pos = p.actionTag === 0 ? f[3] : p.actionTag === 2 ? f[2] : undefined;
                return pos != null && !isNull(p.action, pos) ? hex(bytesAt(p.action, pos)) : null;
            }
        }
    } catch { /* unresolvable */ }
    return null;
}

const DREP_SPECIAL = { abstain: "abstain", no_confidence: "no_confidence" } as const;
function drepKey(d: NonNullable<TxFact["certs"][number]["drep"]>): string {
    if (d.kind === "abstain" || d.kind === "no_confidence") return DREP_SPECIAL[d.kind];
    return (d.kind === "script" ? "01" : "") + d.hash;
}

const big = (v: bigint): string => v.toString();
function certData(c: TxFact["certs"][number]): string | null {
    const o: Record<string, unknown> = {};
    if (c.pool_params) {
        const p = c.pool_params;
        o.pool = { operator: p.operator, vrf: p.vrf, pledge: big(p.pledge), cost: big(p.cost), margin: [big(p.margin.num), big(p.margin.den)], reward_account: hex(p.rewardAccount), owners: p.owners, relays: p.relays, metadata: p.metadata };
    }
    if (c.retire_epoch != null) o.retire_epoch = c.retire_epoch;
    if (c.mir) o.mir = { pot: c.mir.pot, other_pot: c.mir.otherPot == null ? null : big(c.mir.otherPot), n: c.mir.to.length };
    if (c.anchor !== undefined) o.anchor = c.anchor;
    if (c.cc_cold) o.cc_cold = c.cc_cold;
    if (c.cc_hot) o.cc_hot = c.cc_hot;
    if (c.drep && c.drep_cred == null) o.vote_to = drepKey(c.drep);
    if (c.genesis) o.genesis = c.genesis;
    return Object.keys(o).length ? JSON.stringify(o) : null;
}

/**
 * Write the v2 rows of one block (block row, metadata, mint and assets, certificates, MIR,
 * withdrawals, redeemers, scripts, datums, votes, proposals). Idempotent per block; never throws.
 */
export async function applyMbBlock(db: MbSql, m: MbBlockMsg, decoded?: BlockFacts): Promise<void> {
    let facts: BlockFacts | null = decoded ?? null;
    try { facts ??= blockFacts(m.bytes); } catch (e: any) { logger.warn(`MiniBF block ${hex(m.hash).slice(0, 16)}… not decodable: ${e?.message || e}`); }
    try {
        const t = db as any;
        let fees = 0n, output = 0n, feesKnown = true;
        if (facts) {
            for (const tx of facts.txs) {
                if (tx.byron) { output += tx.outputs.reduce((a, o) => a + o.lovelace, 0n); continue; }
                if (tx.valid) { fees += tx.fee; output += tx.outputs.reduce((a, o) => a + o.lovelace, 0n); }
                else {
                    output += tx.collateralReturn?.lovelace ?? 0n;
                    if (tx.totalCollateral != null) fees += tx.totalCollateral;
                    else {
                        let sum = 0n;
                        for (const c of tx.collateral) { const r = await rows(db, t`SELECT lovelace FROM mb_tx_out WHERE tx_hash = ${c.txHash} AND output_index = ${c.index}`); if (r.length) sum += BigInt(toText(r[0]![0]) || "0"); else feesKnown = false; }
                        fees += sum - (tx.collateralReturn?.lovelace ?? 0n);
                    }
                }
            }
            if (facts.era === 1) {
                // Byron fees are inputs − outputs; the applier computed them per transaction (mb_tx.fee)
                const r = await rows(db, t`SELECT fee FROM mb_tx WHERE block_hash = ${m.hash}`);
                fees = 0n;
                for (const x of r) { if (x[0] == null) feesKnown = false; else fees += BigInt(toText(x[0])); }
                if (r.length < facts.txs.length) feesKnown = false;
            }
        }
        await t`INSERT OR REPLACE INTO mb_block (hash, slot, height, epoch, epoch_slot, era, size, tx_count, fees, output, slot_leader, vrf_key, op_cert, op_cert_counter, prev_hash)
			VALUES (${m.hash}, ${m.slot}, ${m.height}, ${m.epoch}, ${m.epochSlot}, ${facts?.era ?? null}, ${m.bytes.length}, ${facts?.txs.length ?? 0},
				${facts && feesKnown ? fees.toString() : null}, ${facts ? output.toString() : null}, ${facts?.leader ?? null}, ${facts?.vrfVkey ?? null},
				${facts?.opCertHotVkey ?? null}, ${facts?.opCertCounter ?? null}, ${facts?.prevHash ? Buffer.from(facts.prevHash, "hex") : null})`;
        if (!facts || facts.era < 2) return;
        const slot = m.slot;
        for (const tx of facts.txs) {
            const h = tx.hash, ti = tx.index;
            for (const x of tx.metadata) {
                const label = x.label.toString();
                const fresh = (await rows(db, t`SELECT 1 FROM mb_tx_meta WHERE tx_hash = ${h} AND label = ${label}`)).length === 0;
                await t`INSERT OR REPLACE INTO mb_tx_meta (tx_hash, label, slot, tx_index, cbor) VALUES (${h}, ${label}, ${slot}, ${ti}, ${x.value})`;
                if (fresh) await t`INSERT INTO mb_meta_label (label, count) VALUES (${label}, 1) ON CONFLICT(label) DO UPDATE SET count = count + 1`;
            }
            // scripts and datums are content-addressed: the first sighting keeps its slot
            for (const sc of tx.scripts) await t`INSERT OR IGNORE INTO mb_script (hash, type, bytes, first_slot, first_tx_index) VALUES (${sc.hash}, ${sc.type}, ${sc.bytes}, ${slot}, ${ti})`;
            for (const d of tx.datums) await t`INSERT OR IGNORE INTO mb_datum (hash, bytes, first_slot) VALUES (${d.hash}, ${d.bytes}, ${slot})`;
            for (const r of tx.redeemers) {
                const sh = await redeemerScriptHash(db, tx, r.tag, r.index);
                await t`INSERT OR REPLACE INTO mb_redeemer (tx_hash, purpose, idx, script_hash, data_hash, mem, steps, slot, tx_index)
					VALUES (${h}, ${r.tag}, ${r.index}, ${sh}, ${hex(blake2b_256(r.data))}, ${r.mem.toString()}, ${r.steps.toString()}, ${slot}, ${ti})`;
            }
            if (!tx.valid) continue; // a phase-2 failure applies nothing but its collateral
            for (const mt of tx.mint) {
                const unit = mt.policy + mt.name;
                // a block indexed twice (restart, backfill over a live range) must not count its mint twice
                if ((await rows(db, t`SELECT 1 FROM mb_mint WHERE tx_hash = ${h} AND unit = ${unit}`)).length) continue;
                await t`INSERT INTO mb_mint (tx_hash, unit, policy, quantity, slot, tx_index) VALUES (${h}, ${unit}, ${mt.policy}, ${mt.qty.toString()}, ${slot}, ${ti})`;
                const cur = await rows(db, t`SELECT quantity, mint_count FROM mb_asset WHERE unit = ${unit}`);
                if (cur.length) await t`UPDATE mb_asset SET quantity = ${(BigInt(toText(cur[0]![0])) + mt.qty).toString()}, mint_count = ${Number(cur[0]![1]) + 1} WHERE unit = ${unit}`;
                else await t`INSERT INTO mb_asset (unit, policy, name, quantity, mint_count, first_tx, first_slot, first_tx_index) VALUES (${unit}, ${mt.policy}, ${mt.name}, ${mt.qty.toString()}, 1, ${h}, ${slot}, ${ti})`;
            }
            for (const c of tx.certs) {
                const drep = c.drep_cred ? (c.drep_cred.type === 1 ? "01" : "") + c.drep_cred.hash : c.drep ? drepKey(c.drep) : null;
                await t`INSERT OR REPLACE INTO mb_cert (tx_hash, cert_index, slot, tx_index, tag, stake, pool, drep, coin, data)
					VALUES (${h}, ${c.index}, ${slot}, ${ti}, ${c.tag}, ${c.stake ?? null}, ${c.pool ?? null}, ${drep}, ${c.coin != null ? c.coin.toString() : null}, ${certData(c)})`;
                if (c.mir) for (const x of c.mir.to) await t`INSERT OR REPLACE INTO mb_mir (tx_hash, cert_index, stake, pot, amount, slot, tx_index) VALUES (${h}, ${c.index}, ${x.stake}, ${c.mir.pot}, ${x.amount.toString()}, ${slot}, ${ti})`;
            }
            for (const w of tx.withdrawals) {
                const st = typedOfRewardAccount(w.rewardAccount);
                if (st) await t`INSERT OR REPLACE INTO mb_withdrawal (tx_hash, stake, amount, slot, tx_index) VALUES (${h}, ${st}, ${w.amount.toString()}, ${slot}, ${ti})`;
            }
            for (const v of tx.votes) await t`INSERT OR REPLACE INTO mb_vote (tx_hash, idx, voter_kind, voter_hash, action_tx, action_ix, vote, anchor_url, anchor_hash, slot, tx_index)
				VALUES (${h}, ${v.index}, ${v.voterKind}, ${v.voterHash}, ${v.actionTx}, ${v.actionIx}, ${v.vote}, ${v.anchor?.url ?? null}, ${v.anchor?.hash ?? null}, ${slot}, ${ti})`;
            for (const p of tx.proposals) await t`INSERT OR REPLACE INTO mb_proposal (tx_hash, idx, slot, tx_index, deposit, return_account, action_tag, action, anchor_url, anchor_hash)
				VALUES (${h}, ${p.index}, ${slot}, ${ti}, ${p.deposit.toString()}, ${p.returnAccount}, ${p.actionTag}, ${p.action}, ${p.anchor?.url ?? null}, ${p.anchor?.hash ?? null})`;
        }
    } catch (e: any) {
        logger.warn(`MiniBF applyMbBlock ${hex(m.hash).slice(0, 16)}… failed: ${e?.message || e}`);
    }
}

/** Remove the v2 rows above `s` (inclusive keep) and recompute the asset aggregates they touched. */
async function rollbackMbV2ToSlot(db: MbSql, s: number): Promise<void> {
    const t = db as any;
    try {
        await t`DELETE FROM mb_tx_out_asset WHERE tx_hash IN (SELECT tx_hash FROM mb_tx WHERE slot > ${s})`;
        const units = (await rows(db, t`SELECT DISTINCT unit FROM mb_mint WHERE slot > ${s}`)).map((r) => toText(r[0]));
        await t`DELETE FROM mb_mint WHERE slot > ${s}`;
        for (const unit of units) {
            const ms = await rows(db, t`SELECT quantity, tx_hash, slot, tx_index FROM mb_mint WHERE unit = ${unit} ORDER BY slot, tx_index`);
            if (!ms.length) { await t`DELETE FROM mb_asset WHERE unit = ${unit}`; continue; }
            const q = ms.reduce((a, r) => a + BigInt(toText(r[0])), 0n);
            await t`UPDATE mb_asset SET quantity = ${q.toString()}, mint_count = ${ms.length}, first_tx = ${toText(ms[0]![1])}, first_slot = ${Number(ms[0]![2])}, first_tx_index = ${Number(ms[0]![3])} WHERE unit = ${unit}`;
        }
        for (const r of await rows(db, t`SELECT label, COUNT(*) FROM mb_tx_meta WHERE slot > ${s} GROUP BY label`)) await t`UPDATE mb_meta_label SET count = MAX(0, count - ${Number(r[1])}) WHERE label = ${toText(r[0])}`;
        for (const table of ["mb_block", "mb_tx_meta", "mb_cert", "mb_mir", "mb_withdrawal", "mb_redeemer", "mb_vote", "mb_proposal"]) await t.unsafe(`DELETE FROM ${table} WHERE slot > ${Math.trunc(s)}`);
        await t`DELETE FROM mb_script WHERE first_slot > ${s}`;
        await t`DELETE FROM mb_datum WHERE first_slot > ${s}`;
    } catch (e: any) {
        logger.warn(`MiniBF v2 rollback(${s}): ${e?.message || e}`);
    }
}

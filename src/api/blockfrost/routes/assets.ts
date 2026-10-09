/** Assets, transaction metadata and scripts / datums. */
import { getReferenceScriptCborByHash } from "../../../db";
import { getStoredEpochParams } from "../../../consensus/epochParams";
import { rationalOf, scriptExecutionFee } from "../../../consensus/rules/ledgerChecks";
import { assetFingerprint } from "../../../db/minibf/cardanoIds";
import { REDEEMER_PURPOSES } from "../../../db/minibf/blockFacts";
import { hex } from "../../../db/minibf/cborWalk";
import { CborArray, CborBytes, CborMap, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { epochForSlot } from "../../../utils/epochFromSlotCalculations";
import { datumJson, metadataJson, nativeScriptJson, parseCbor, plainJson } from "../cborJson";
import { badRequest, fromTo, intParam, MSG, notFound, pageOf, paging } from "../http";
import { route, type Ctx, type Route } from "../router";
import { amountOf, assetsOfJson, blobHex, blockTime, mb, mbUnsafe, num, str, type Row } from "../chain";
import { txMetas } from "./addresses";

const ASSET_RE = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;
function assetParam(c: Ctx): string {
    const a = c.params.asset!.toLowerCase();
    if (!ASSET_RE.test(a)) throw badRequest(MSG.asset);
    return a;
}

interface AssetRow { unit: string; policy: string; name: string; quantity: string; mintCount: number; firstTx: string }
async function assetRow(unit: string): Promise<AssetRow> {
    const r = await mb`SELECT unit, policy, name, quantity, mint_count, first_tx FROM mb_asset WHERE unit = ${unit}`;
    if (!r.length) throw notFound();
    const x = r[0]!;
    return { unit: str(x[0]), policy: str(x[1]), name: str(x[2]), quantity: str(x[3]), mintCount: num(x[4]), firstTx: str(x[5]) };
}

const CIP68_REF = "000643b0", CIP68_USER = ["000de140", "0014df10", "001bc280"];
const textOrHex = (o: CborObj): string => (o instanceof CborText ? o.text : o instanceof CborBytes ? hex((o as any).bytes ?? (o as any).buffer) : "");

/** CIP-68: the reference NFT's inline datum `[metadata, version, extra]`. */
async function cip68(policy: string, name: string): Promise<{ meta: unknown; standard: string; extra: string | null } | null> {
    if (!CIP68_USER.some((p) => name.startsWith(p))) return null;
    const ref = policy + CIP68_REF + name.slice(8);
    const r = await mb`SELECT o.inline_datum_cbor FROM mb_tx_out_asset a JOIN mb_tx_out o ON o.tx_hash = a.tx_hash AND o.output_index = a.output_index WHERE a.unit = ${ref} AND o.spent_by_tx IS NULL AND o.inline_datum_cbor IS NOT NULL LIMIT 1`;
    if (!r.length) return null;
    const raw = r[0]![0];
    const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(Buffer.from(str(raw), "hex"));
    try {
        const d: any = parseCbor(bytes);
        const fields: CborObj[] = d?.data instanceof CborArray ? d.data.array : [];
        if (!(fields[0] instanceof CborMap)) return null;
        const version = fields[1] instanceof CborUInt ? Number(fields[1].num) : 1;
        return { meta: plainJson(fields[0]), standard: `CIP68v${Math.min(3, Math.max(1, version))}`, extra: fields[2] ? hex(bytes) : null };
    } catch { return null; }
}

/** CIP-25: label 721 of the latest minting transaction that carries it. */
async function cip25(policy: string, name: string, unit: string): Promise<{ meta: unknown; standard: string } | null> {
    const r = await mb`SELECT t.cbor FROM mb_mint m JOIN mb_tx_meta t ON t.tx_hash = m.tx_hash AND t.label = '721' WHERE m.unit = ${unit} AND m.quantity NOT LIKE '-%' ORDER BY m.slot DESC, m.tx_index DESC LIMIT 1`;
    if (!r.length) return null;
    try {
        const root = parseCbor(r[0]![0] as Uint8Array);
        if (!(root instanceof CborMap)) return null;
        let version = 1;
        for (const { k, v } of root.map) if (textOrHex(k) === "version" && (v instanceof CborUInt || v instanceof CborText)) version = Number(v instanceof CborUInt ? v.num : v.text) >= 2 ? 2 : 1;
        const nameText = Buffer.from(name, "hex").toString("utf8");
        for (const { k, v } of root.map) {
            if (textOrHex(k).toLowerCase() !== policy || !(v instanceof CborMap)) continue;
            for (const e of v.map) {
                const kn = textOrHex(e.k);
                if (kn === nameText || kn.toLowerCase() === name) return { meta: plainJson(e.v), standard: version === 2 ? "CIP25v2" : "CIP25v1" };
            }
        }
    } catch { /* malformed */ }
    return null;
}

async function assetTxMetas(unit: string) {
    const outs = await mb`SELECT DISTINCT tx_hash FROM mb_tx_out_asset WHERE unit = ${unit}`;
    const mints = await mb`SELECT tx_hash FROM mb_mint WHERE unit = ${unit}`;
    const metas = await txMetas([...new Set([...outs, ...mints].map((x) => str(x[0])))]);
    return [...metas.values()].sort((a, b) => a.slot - b.slot || a.index - b.index);
}

const LABELS: Record<string, string> = {
    "0": "Transaction metadata (CIP-10 reserved)", "674": "CIP-0020 - Transaction message/comment metadata", "721": "CIP-0025 - NFT Token Standard",
    "1967": "CIP-0072 - nut.link metadata oracles registration", "1968": "nut.link metadata oracles data points", "61284": "CIP-0015 - Catalyst registration", "61285": "CIP-0015 - Catalyst witness",
    "61286": "CIP-0036 - Catalyst deregistration", "1694": "CIP-0100 - Governance metadata", "309": "Cardano Foundation - Cardano Ballot",
};
let labelsCache: { at: number; rows: Array<{ label: string; count: number }> } | null = null;

async function redeemerFee(slot: number, mem: bigint, steps: bigint, net: Ctx["net"]): Promise<string> {
    const p = (await getStoredEpochParams(Number(epochForSlot(slot, net)))) ?? {};
    const pm = rationalOf(p.price_mem), ps = rationalOf(p.price_step);
    return pm && ps ? scriptExecutionFee(mem, steps, pm, ps).toString() : "0";
}

async function scriptRow(hash: string): Promise<{ type: string; bytes: Uint8Array } | null> {
    const r = await mb`SELECT type, bytes FROM mb_script WHERE hash = ${hash}`;
    if (r.length) return { type: str(r[0]![0]), bytes: r[0]![1] as Uint8Array };
    // not indexed yet: a reference script in the current UTxO set
    const cbor = await getReferenceScriptCborByHash(hash);
    if (!cbor) return null;
    return { type: "plutusV2", bytes: Uint8Array.from(Buffer.from(cbor, "hex")) };
}

const hashParam = (c: Ctx, name: string, len: number): string => {
    const h = c.params[name]!.toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${len}}$`).test(h)) throw notFound();
    return h;
};

export const assetRoutes: Route[] = [
    route("GET", "/assets", async (c) => {
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        return (await mbUnsafe(`SELECT unit, quantity FROM mb_asset ORDER BY first_slot ${o}, first_tx_index ${o}, unit ${o} LIMIT ? OFFSET ?`, [p.count, p.offset])).map((r) => ({ asset: str(r[0]), quantity: str(r[1]) }));
    }),
    route("GET", "/assets/policy/{policy_id}", async (c) => {
        const policy = c.params.policy_id!.toLowerCase();
        if (!/^[0-9a-f]{56}$/.test(policy)) throw badRequest(MSG.policy);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT unit, quantity FROM mb_asset WHERE policy = ? ORDER BY first_slot ${o}, first_tx_index ${o}, unit ${o} LIMIT ? OFFSET ?`, [policy, p.count, p.offset]);
        if (!rows.length && p.page === 1) throw notFound();
        return rows.map((r) => ({ asset: str(r[0]), quantity: str(r[1]) }));
    }),
    route("GET", "/assets/{asset}", async (c) => {
        const a = await assetRow(assetParam(c));
        const m68 = await cip68(a.policy, a.name);
        const m25 = m68 ? null : await cip25(a.policy, a.name, a.unit);
        return {
            asset: a.unit, policy_id: a.policy, asset_name: a.name || null, fingerprint: assetFingerprint(a.policy, a.name), quantity: a.quantity,
            initial_mint_tx_hash: a.firstTx, mint_or_burn_count: a.mintCount,
            onchain_metadata: (m68?.meta ?? m25?.meta ?? null) as unknown, onchain_metadata_standard: m68?.standard ?? m25?.standard ?? null, onchain_metadata_extra: m68?.extra ?? null,
            metadata: null,
        };
    }),
    route("GET", "/assets/{asset}/history", async (c) => {
        const a = await assetRow(assetParam(c));
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        return (await mbUnsafe(`SELECT tx_hash, quantity FROM mb_mint WHERE unit = ? ORDER BY slot ${o}, tx_index ${o} LIMIT ? OFFSET ?`, [a.unit, p.count, p.offset]))
            .map((r) => ({ tx_hash: str(r[0]), action: str(r[1]).startsWith("-") ? "burned" : "minted", amount: str(r[1]) }));
    }),
    route("GET", "/assets/{asset}/txs", async (c) => {
        const a = await assetRow(assetParam(c));
        return pageOf(await assetTxMetas(a.unit), paging(c.url)).map((m) => m.hash);
    }),
    route("GET", "/assets/{asset}/transactions", async (c) => {
        const a = await assetRow(assetParam(c));
        const p = paging(c.url);
        const r = fromTo(c.url);
        const metas = (await assetTxMetas(a.unit)).filter((m) => (r.fromHeight == null || (m.height ?? 0) >= r.fromHeight) && (r.toHeight == null || (m.height ?? 0) <= r.toHeight));
        return pageOf(metas, p).map((m) => ({ tx_hash: m.hash, tx_index: m.index, block_height: m.height ?? 0, block_time: blockTime(m.slot, c.net) }));
    }),
    route("GET", "/assets/{asset}/addresses", async (c) => {
        const a = await assetRow(assetParam(c));
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT o.address, SUM(CAST(a.quantity AS INTEGER)) FROM mb_tx_out_asset a JOIN mb_tx_out o ON o.tx_hash = a.tx_hash AND o.output_index = a.output_index
            WHERE a.unit = ? AND o.spent_by_tx IS NULL GROUP BY o.address ORDER BY MIN(o.rowid) ${o} LIMIT ? OFFSET ?`, [a.unit, p.count, p.offset]);
        return rows.map((r) => ({ address: str(r[0]), quantity: str(r[1]) }));
    }),
    route("GET", "/assets/{asset}/utxos", async (c) => {
        const a = await assetRow(assetParam(c));
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT o.address, o.tx_hash, o.output_index, o.lovelace, o.assets_json, o.datum_hash, o.inline_datum_cbor, o.script_ref_hash, t.block_hash, t.block_height, t.slot
            FROM mb_tx_out_asset a JOIN mb_tx_out o ON o.tx_hash = a.tx_hash AND o.output_index = a.output_index JOIN mb_tx t ON t.tx_hash = o.tx_hash
            WHERE a.unit = ? AND o.spent_by_tx IS NULL ORDER BY t.slot ${o}, t.tx_index ${o}, o.output_index ${o} LIMIT ? OFFSET ?`, [a.unit, p.count, p.offset]);
        return rows.map((r) => {
            const inline = blobHex(r[6]);
            return { address: str(r[0]), tx_hash: str(r[1]), output_index: num(r[2]), amount: amountOf(str(r[3]) || "0", assetsOfJson(r[4])), block: blobHex(r[8]) ?? "", block_height: num(r[9]), block_time: blockTime(num(r[10]), c.net), data_hash: r[5] == null ? null : str(r[5]), inline_datum: inline, inline_datum_json: inline ? datumJson(Buffer.from(inline, "hex")) : null, reference_script_hash: r[7] == null ? null : str(r[7]) };
        });
    }),

    route("GET", "/metadata/txs/labels", async (c) => {
        const p = paging(c.url);
        if (!labelsCache || Date.now() - labelsCache.at > 30_000) {
            const rows = await mb`SELECT label, count FROM mb_meta_label WHERE count > 0`;
            labelsCache = { at: Date.now(), rows: rows.map((r) => ({ label: str(r[0]), count: num(r[1]) })).sort((a, b) => (BigInt(a.label) < BigInt(b.label) ? -1 : 1)) };
        }
        return pageOf(labelsCache.rows, p).map((r) => ({ label: r.label, cip10: LABELS[r.label] ?? null, count: String(r.count) }));
    }),
    route("GET", "/metadata/txs/labels/{label}", async (c) => {
        const label = c.params.label!;
        if (!/^\d+$/.test(label) || BigInt(label) > 18446744073709551615n) throw badRequest(MSG.label);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, cbor FROM mb_tx_meta WHERE label = ? ORDER BY slot ${o}, tx_index ${o} LIMIT ? OFFSET ?`, [BigInt(label).toString(), p.count, p.offset]);
        if (!rows.length) throw notFound();
        return rows.map((r) => ({ tx_hash: str(r[0]), json_metadata: metadataJson(r[1] as Uint8Array) }));
    }),
    route("GET", "/metadata/txs/labels/{label}/cbor", async (c) => {
        const label = c.params.label!;
        if (!/^\d+$/.test(label) || BigInt(label) > 18446744073709551615n) throw badRequest(MSG.label);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, cbor FROM mb_tx_meta WHERE label = ? ORDER BY slot ${o}, tx_index ${o} LIMIT ? OFFSET ?`, [BigInt(label).toString(), p.count, p.offset]);
        if (!rows.length) throw notFound();
        return rows.map((r) => { const h = hex(r[1] as Uint8Array); return { tx_hash: str(r[0]), cbor_metadata: "\\x" + h, metadata: h }; });
    }),

    route("GET", "/scripts", async (c) => {
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        return (await mbUnsafe(`SELECT hash FROM mb_script ORDER BY first_slot ${o}, first_tx_index ${o}, hash ${o} LIMIT ? OFFSET ?`, [p.count, p.offset])).map((r) => ({ script_hash: str(r[0]) }));
    }),
    route("GET", "/scripts/datum/{datum_hash}", async (c) => {
        const h = hashParam(c, "datum_hash", 64);
        const r = await mb`SELECT bytes FROM mb_datum WHERE hash = ${h}`;
        if (!r.length) throw notFound();
        return { json_value: datumJson(r[0]![0] as Uint8Array) };
    }),
    route("GET", "/scripts/datum/{datum_hash}/cbor", async (c) => {
        const h = hashParam(c, "datum_hash", 64);
        const r = await mb`SELECT bytes FROM mb_datum WHERE hash = ${h}`;
        if (!r.length) throw notFound();
        return { cbor: hex(r[0]![0] as Uint8Array) };
    }),
    route("GET", "/scripts/{script_hash}", async (c) => {
        const h = hashParam(c, "script_hash", 56);
        const s = await scriptRow(h);
        if (!s) throw notFound();
        return { script_hash: h, type: s.type, serialised_size: s.type === "timelock" ? null : s.bytes.length };
    }),
    route("GET", "/scripts/{script_hash}/json", async (c) => {
        const h = hashParam(c, "script_hash", 56);
        const s = await scriptRow(h);
        if (!s) throw notFound();
        return { json: s.type === "timelock" ? nativeScriptJson(s.bytes) : null };
    }),
    route("GET", "/scripts/{script_hash}/cbor", async (c) => {
        const h = hashParam(c, "script_hash", 56);
        const s = await scriptRow(h);
        if (!s) throw notFound();
        return { cbor: s.type === "timelock" ? null : hex(s.bytes) };
    }),
    route("GET", "/scripts/{script_hash}/redeemers", async (c) => {
        const h = hashParam(c, "script_hash", 56);
        if (!(await scriptRow(h))) throw notFound();
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, idx, purpose, data_hash, mem, steps, slot FROM mb_redeemer WHERE script_hash = ? ORDER BY slot ${o}, tx_index ${o}, idx ${o} LIMIT ? OFFSET ?`, [h, p.count, p.offset]);
        const out: unknown[] = [];
        for (const r of rows) out.push({ tx_hash: str(r[0]), tx_index: num(r[1]), purpose: REDEEMER_PURPOSES[num(r[2])] ?? "spend", redeemer_data_hash: str(r[3]), datum_hash: str(r[3]), unit_mem: str(r[4]), unit_steps: str(r[5]), fee: await redeemerFee(num(r[6]), BigInt(str(r[4])), BigInt(str(r[5])), c.net) });
        return out;
    }),
    route("GET", "/scripts/{script_hash}/utxos", async (c) => {
        const h = hashParam(c, "script_hash", 56);
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT o.address, o.tx_hash, o.output_index, o.lovelace, o.assets_json, o.datum_hash, o.inline_datum_cbor, o.script_ref_hash, t.block_hash FROM mb_tx_out o JOIN mb_tx t ON t.tx_hash = o.tx_hash
            WHERE o.payment_cred = ? AND o.spent_by_tx IS NULL ORDER BY t.slot ${o}, t.tx_index ${o}, o.output_index ${o} LIMIT ? OFFSET ?`, ["01" + h, p.count, p.offset]);
        return rows.map((r: Row) => ({ address: str(r[0]), tx_hash: str(r[1]), output_index: num(r[2]), amount: amountOf(str(r[3]) || "0", assetsOfJson(r[4])), block: blobHex(r[8]) ?? "", data_hash: r[5] == null ? null : str(r[5]), inline_datum: blobHex(r[6]), reference_script_hash: r[7] == null ? null : str(r[7]) }));
    }),
];
void intParam;

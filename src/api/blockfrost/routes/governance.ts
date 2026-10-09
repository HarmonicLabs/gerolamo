/** Conway governance: DReps, proposals, votes, the constitutional committee. */
import { ccId, parseCcId, DREP_ABSTAIN, DREP_NO_CONFIDENCE, drepIdCip129, drepIdLegacy, govActionId, parseDrepId, parseGovActionId, poolIdBech32, rewardAccountBech32, stakeAddressOf } from "../../../db/minibf/cardanoIds";
import type { ProposalRow } from "../../../ledger/govStore";
import { epochForSlot } from "../../../utils/epochFromSlotCalculations";
import { badRequest, MSG, notFound, pageOf, paging } from "../http";
import { route, type Ctx, type Route } from "../router";
import { blockTime, mb, mbUnsafe, num, str } from "../chain";
import { drepIndex, ledger, liveAccountStake } from "../ledger";
import { currentEpoch } from "./core";
import { getStoredEpochParams } from "../../../consensus/epochParams";
import vendored from "../blockfrost-openapi.responses.json";

const PARAM_KEYS = Object.keys(((vendored as any).paths["/governance/proposals/{tx_hash}/{cert_index}/parameters"]?.properties?.parameters?.properties ?? {}) as Record<string, unknown>);

const GOV_TYPE: Record<string, string> = {
    ParameterChange: "parameter_change", InitHardFork: "hard_fork_initiation", TreasuryWithdrawals: "treasury_withdrawals",
    NoConfidence: "no_confidence", UpdateCommittee: "new_committee", NewConstitution: "new_constitution", Info: "info_action",
};
const TAG_TYPE = ["parameter_change", "hard_fork_initiation", "treasury_withdrawals", "no_confidence", "new_committee", "new_constitution", "info_action"];
const VOTE = ["no", "yes", "abstain"];

interface DRepRef { type: number; hash: string; special: "abstain" | "no_confidence" | null; cip129: boolean }
function drepParam(c: Ctx): DRepRef {
    const d = parseDrepId(c.params.drep_id!);
    if (!d) throw badRequest(MSG.drep);
    if ("special" in d) return { type: d.special === "abstain" ? 2 : 3, hash: "", special: d.special, cip129: true };
    return { type: d.type, hash: d.hash, special: null, cip129: d.cip129 };
}
const drepTyped = (d: { type: number; hash: string }) => (d.type === 1 ? "01" : "") + d.hash;
const drepKey = (d: { type: number; hash: string }) => `${d.type}:${d.hash}`;

async function drepAmounts(epoch: number): Promise<Map<string, bigint>> {
    const l = ledger();
    const out = new Map<string, bigint>();
    if (!l) return out;
    for (const r of l.gov.drepStake(epoch)) out.set(`${r.type}:${r.type <= 1 ? r.hash : ""}`, r.stake);
    return out;
}

async function drepJson(c: Ctx, d: DRepRef, full: boolean): Promise<Record<string, unknown> | null> {
    const l = ledger();
    const cur = await currentEpoch(c.net);
    const amounts = await drepAmounts(cur);
    if (d.special) {
        return { drep_id: d.special === "abstain" ? DREP_ABSTAIN : DREP_NO_CONFIDENCE, hex: "", amount: (amounts.get(`${d.type}:`) ?? 0n).toString(), ...(full ? { active: true, active_epoch: null } : {}), has_script: false, retired: false, expired: false, last_active_epoch: null };
    }
    const row = l?.gov.drep(drepTyped(d)) ?? null;
    const certs = await mbUnsafe(`SELECT tag, slot FROM mb_cert WHERE drep = ? AND tag IN (16, 17, 18) ORDER BY slot`, [drepTyped(d)]);
    if (!row && !certs.length) return null;
    const regs = certs.filter((x) => num(x[0]) === 16);
    const id = d.cip129 ? drepIdCip129(d.type, d.hash) : drepIdLegacy(d.type, d.hash);
    return {
        drep_id: id, hex: d.cip129 ? (d.type === 1 ? "23" : "22") + d.hash : d.hash,
        amount: (amounts.get(drepKey(d)) ?? 0n).toString(),
        ...(full ? { active: row != null, active_epoch: regs.length ? Number(epochForSlot(num(regs[regs.length - 1]![1]), c.net)) : row ? Number(epochForSlot(row.registeredSlot, c.net)) : null } : {}),
        has_script: d.type === 1,
        retired: row == null,
        expired: row?.expiryEpoch != null ? row.expiryEpoch < cur : false,
        last_active_epoch: row?.lastActiveEpoch ?? null,
    };
}

function proposalRef(c: Ctx): { txHash: string; index: number } {
    if (c.params.gov_action_id) {
        const g = parseGovActionId(c.params.gov_action_id);
        if (!g) throw badRequest(MSG.govAction);
        return g;
    }
    const tx = c.params.tx_hash!.toLowerCase(), ix = c.params.cert_index!;
    if (!/^[0-9a-f]{64}$/.test(tx) || !/^\d+$/.test(ix)) throw badRequest(MSG.govAction);
    return { txHash: tx, index: Number(ix) };
}

interface ProposalInfo { ref: { txHash: string; index: number }; row: ProposalRow | null; deposit: string; returnAccount: string | null; tag: number | null }
async function proposal(c: Ctx): Promise<ProposalInfo> {
    const ref = proposalRef(c);
    const row = ledger()?.gov.proposal(`${ref.txHash}:${ref.index}`) ?? null;
    const p = await mb`SELECT deposit, return_account, action_tag FROM mb_proposal WHERE tx_hash = ${ref.txHash} AND idx = ${ref.index}`;
    if (!row && !p.length) throw notFound();
    const ra = p.length ? (p[0]![1] as Uint8Array) : null;
    return { ref, row, deposit: p.length ? str(p[0]![0]) : row!.deposit, returnAccount: ra ? rewardAccountBech32(ra) : row ? stakeAddressOf(row.returnAccount, c.network) : null, tag: p.length ? num(p[0]![2]) : null };
}

function payloadOf(row: ProposalRow | null): any { try { return row ? JSON.parse(row.payload) : null; } catch { return null; } }

function voterText(kind: number, hash: string): { role: string; voter: string } {
    if (kind <= 1) return { role: "constitutional_committee", voter: ccId("hot", kind, hash) };
    if (kind <= 3) return { role: "drep", voter: drepIdCip129(kind - 2, hash) };
    return { role: "spo", voter: poolIdBech32(hash) };
}

const proposalRoutesFor = (prefix: string): Route[] => [
    route("GET", prefix, async (c) => {
        const p = await proposal(c);
        const row = p.row;
        const type = row ? GOV_TYPE[row.kind] ?? "info_action" : TAG_TYPE[p.tag ?? 6] ?? "info_action";
        const st = row?.status, de = row?.decidedEpoch ?? null;
        return {
            id: govActionId(p.ref.txHash, p.ref.index), tx_hash: p.ref.txHash, cert_index: p.ref.index, governance_type: type,
            governance_description: row ? { tag: row.kind, contents: payloadOf(row) } : null,
            deposit: p.deposit, return_address: p.returnAccount ?? "",
            ratified_epoch: st === "ratified" ? de : st === "enacted" && de != null ? de - 1 : null,
            enacted_epoch: st === "enacted" ? de : null, dropped_epoch: st === "dropped" ? de : null, expired_epoch: st === "expired" ? de : null,
            expiration: row?.expiresEpoch ?? 0,
        };
    }),
    route("GET", prefix + "/parameters", async (c) => {
        const p = await proposal(c);
        if (p.row?.kind !== "ParameterChange" && p.tag !== 0) throw notFound();
        const changes = (payloadOf(p.row)?.changes ?? {}) as Record<string, unknown>;
        // Blockfrost lists every parameter, null where the proposal leaves it unchanged
        const parameters: Record<string, unknown> = Object.fromEntries(PARAM_KEYS.map((k) => [k, null]));
        for (const [k, v] of Object.entries(changes)) if (k in parameters) parameters[k] = v;
        return { id: govActionId(p.ref.txHash, p.ref.index), tx_hash: p.ref.txHash, cert_index: p.ref.index, parameters };
    }),
    route("GET", prefix + "/withdrawals", async (c) => {
        const p = await proposal(c);
        if (p.row?.kind !== "TreasuryWithdrawals" && p.tag !== 2) throw notFound();
        return ((payloadOf(p.row)?.withdrawals ?? []) as Array<{ account: string; amount: string }>).map((w) => ({ stake_address: stakeAddressOf(w.account, c.network), amount: String(w.amount) }));
    }),
    route("GET", prefix + "/votes", async (c) => {
        const p = await proposal(c);
        const q = paging(c.url);
        const o = q.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, idx, voter_kind, voter_hash, vote FROM mb_vote WHERE action_tx = ? AND action_ix = ? ORDER BY slot ${o}, tx_index ${o}, idx ${o} LIMIT ? OFFSET ?`, [p.ref.txHash, p.ref.index, q.count, q.offset]);
        return rows.map((r) => { const v = voterText(num(r[2]), str(r[3])); return { tx_hash: str(r[0]), cert_index: num(r[1]), voter_role: v.role, voter: v.voter, vote: VOTE[num(r[4])] ?? "abstain" }; });
    }),
    route("GET", prefix + "/metadata", async () => { throw notFound("Off-chain governance metadata is not fetched by this node."); }),
];

async function committeeVotes(c: Ctx, hot: { type: number; hash: string } | null): Promise<unknown[]> {
    const p = paging(c.url);
    const o = p.order === "desc" ? "DESC" : "ASC";
    const where = hot ? "v.voter_kind = ? AND v.voter_hash = ?" : "v.voter_kind IN (0, 1)";
    const rows = await mbUnsafe(`SELECT v.tx_hash, v.voter_kind, v.voter_hash, v.action_tx, v.action_ix, v.vote, v.anchor_url, v.anchor_hash, v.slot, t.block_height, pr.action_tag
        FROM mb_vote v LEFT JOIN mb_tx t ON t.tx_hash = v.tx_hash LEFT JOIN mb_proposal pr ON pr.tx_hash = v.action_tx AND pr.idx = v.action_ix
        WHERE ${where} ORDER BY v.slot ${o}, v.tx_index ${o}, v.idx ${o} LIMIT ? OFFSET ?`, [...(hot ? [hot.type, hot.hash] : []), p.count, p.offset]);
    const l = ledger();
    return rows.map((r) => {
        const kind = r[10] == null ? GOV_TYPE[l?.gov.proposal(`${str(r[3])}:${num(r[4])}`)?.kind ?? ""] ?? "info_action" : TAG_TYPE[num(r[10])] ?? "info_action";
        return { tx_hash: str(r[0]), voter_hot_id: ccId("hot", num(r[1]), str(r[2])), proposal_id: govActionId(str(r[3]), num(r[4])), proposal_tx_hash: str(r[3]), proposal_index: num(r[4]), governance_type: kind, vote: VOTE[num(r[5])] ?? "abstain", metadata_url: r[6] == null ? null : str(r[6]), metadata_hash: r[7] == null ? null : str(r[7]), block_height: num(r[9]), block_time: blockTime(num(r[8]), c.net) };
    });
}

export const governanceRoutes: Route[] = [
    route("GET", "/governance/dreps", async (c) => {
        const p = paging(c.url);
        const l = ledger();
        const keys = new Map<string, DRepRef>();
        keys.set("2:", { type: 2, hash: "", special: "abstain", cip129: true });
        keys.set("3:", { type: 3, hash: "", special: "no_confidence", cip129: true });
        const regs = await mb`SELECT drep, MIN(slot) FROM mb_cert WHERE tag = 16 GROUP BY drep ORDER BY MIN(slot)`;
        for (const r of regs) { const t = str(r[0]); const d = { type: t.length === 58 ? 1 : 0, hash: t.length === 58 ? t.slice(2) : t }; keys.set(drepKey(d), { ...d, special: null, cip129: true }); }
        if (l) for (const [cred] of l.gov.dreps()) { const d = { type: cred.length === 58 && cred.startsWith("01") ? 1 : 0, hash: cred.length === 58 ? cred.slice(2) : cred }; if (!keys.has(drepKey(d))) keys.set(drepKey(d), { ...d, special: null, cip129: true }); }
        const out: unknown[] = [];
        for (const d of pageOf([...keys.values()], p)) { const j = await drepJson(c, d, false); if (j) out.push({ ...j, metadata: null }); }
        return out;
    }),
    route("GET", "/governance/dreps/{drep_id}", async (c) => {
        const j = await drepJson(c, drepParam(c), true);
        if (!j) throw notFound();
        return j;
    }),
    route("GET", "/governance/dreps/{drep_id}/delegators", async (c) => {
        const d = drepParam(c);
        const l = ledger();
        if (!l) return [];
        if (!d.special && !(await drepJson(c, d, false))) throw notFound();
        const ix = await drepIndex(l);
        const list = [...(ix.delegators.get(d.special ? `${d.type}:` : drepKey(d)) ?? [])].sort();
        return pageOf(list, paging(c.url)).map((cred) => ({ address: stakeAddressOf(cred, c.network), amount: liveAccountStake(l, cred).toString() }));
    }),
    route("GET", "/governance/dreps/{drep_id}/metadata", async (c) => {
        const d = drepParam(c);
        if (d.special) throw notFound();
        const r = await mbUnsafe(`SELECT data FROM mb_cert WHERE drep = ? AND tag IN (16, 18) ORDER BY slot DESC, tx_index DESC LIMIT 1`, [drepTyped(d)]);
        let anchor: { url: string; hash: string } | null = null;
        try { anchor = r.length ? JSON.parse(str(r[0]![0])).anchor ?? null : null; } catch { /* */ }
        if (!anchor) throw notFound();
        return { drep_id: drepIdCip129(d.type, d.hash), hex: (d.type === 1 ? "23" : "22") + d.hash, url: anchor.url, hash: anchor.hash, json_metadata: null, bytes: null, error: { code: "UNKNOWN_ERROR", message: "Off-chain metadata is not fetched by this node." } };
    }),
    route("GET", "/governance/dreps/{drep_id}/updates", async (c) => {
        const d = drepParam(c);
        if (d.special) return [];
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, cert_index, tag, coin FROM mb_cert WHERE drep = ? AND tag IN (16, 17, 18) ORDER BY slot ${o}, tx_index ${o}, cert_index ${o} LIMIT ? OFFSET ?`, [drepTyped(d), p.count, p.offset]);
        if (!rows.length && p.page === 1 && !ledger()?.gov.drep(drepTyped(d))) throw notFound();
        return rows.map((r) => { const t = num(r[2]); return { tx_hash: str(r[0]), cert_index: num(r[1]), action: t === 16 ? "registered" : t === 17 ? "deregistered" : "updated", deposit: t === 18 ? null : r[3] == null ? null : (t === 17 ? "-" : "") + str(r[3]) }; });
    }),
    route("GET", "/governance/dreps/{drep_id}/votes", async (c) => {
        const d = drepParam(c);
        if (d.special) return [];
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, idx, action_tx, action_ix, vote FROM mb_vote WHERE voter_kind = ? AND voter_hash = ? ORDER BY slot ${o}, tx_index ${o}, idx ${o} LIMIT ? OFFSET ?`, [d.type + 2, d.hash, p.count, p.offset]);
        return rows.map((r) => ({ tx_hash: str(r[0]), cert_index: num(r[1]), proposal_id: govActionId(str(r[2]), num(r[3])), proposal_tx_hash: str(r[2]), proposal_cert_index: num(r[3]), vote: VOTE[num(r[4])] ?? "abstain" }));
    }),
    route("GET", "/governance/proposals", async (c) => {
        const p = paging(c.url);
        const o = p.order === "desc" ? "DESC" : "ASC";
        const rows = await mbUnsafe(`SELECT tx_hash, idx, action_tag FROM mb_proposal ORDER BY slot ${o}, tx_index ${o}, idx ${o} LIMIT ? OFFSET ?`, [p.count, p.offset]);
        if (rows.length || p.page > 1) return rows.map((r) => ({ id: govActionId(str(r[0]), num(r[1])), tx_hash: str(r[0]), cert_index: num(r[1]), governance_type: TAG_TYPE[num(r[2])] ?? "info_action" }));
        // projection without v2 history: the ledger's proposals
        const l = ledger();
        const all = l ? l.gov.proposals() : [];
        return pageOf(all, p).map((x) => { const [tx, ix] = x.actionId.split(":"); return { id: govActionId(tx!, Number(ix)), tx_hash: tx!, cert_index: Number(ix), governance_type: GOV_TYPE[x.kind] ?? "info_action" }; });
    }),
    ...proposalRoutesFor("/governance/proposals/{tx_hash}/{cert_index}"),
    ...proposalRoutesFor("/governance/proposals/{gov_action_id}"),
    route("GET", "/governance/committee/votes", async (c) => committeeVotes(c, null)),
    route("GET", "/governance/committee/{cc_id}/votes", async (c) => {
        const id = parseCcId(c.params.cc_id!);
        if (!id) throw badRequest("Invalid or malformed cc credential id.");
        let hot: { type: number; hash: string } | null = id.role === "hot" ? id : null;
        if (!hot) {
            const auth = ledger()?.gov.committeeAuth((id.type === 1 ? "01" : "") + id.hash);
            const h = auth?.hot ?? null;
            if (!h) return [];
            hot = { type: h.length === 58 && h.startsWith("01") ? 1 : 0, hash: h.length === 58 ? h.slice(2) : h };
        }
        return committeeVotes(c, hot);
    }),
    route("GET", "/governance/committee", async (c) => {
        const l = ledger();
        if (!l) throw notFound();
        const st = l.gov.state();
        const members = [...l.gov.committee()].map(([cold, m]) => {
            const typed = cold.length === 58 && cold.startsWith("01");
            const coldHash = typed ? cold.slice(2) : cold;
            const auth = l.gov.committeeAuth(cold);
            const hot = auth?.hot ?? m.hot ?? null;
            const hotScript = hot != null && hot.length === 58 && hot.startsWith("01");
            const hotHash = hot == null ? null : hotScript ? hot.slice(2) : hot;
            return {
                cc_cold_id: ccId("cold", typed ? 1 : 0, coldHash), cc_cold_hex: (typed ? "03" : "02") + coldHash, cc_cold_has_script: typed,
                cc_hot_id: hotHash ? ccId("hot", hotScript ? 1 : 0, hotHash) : null, cc_hot_hex: hotHash ? (hotScript ? "13" : "12") + hotHash : null, cc_hot_has_script: hotHash ? hotScript : null,
                status: (auth?.resigned ?? m.resigned) ? "resigned" : hotHash ? "authorized" : "not_authorized",
                expiration_epoch: m.expiresEpoch,
            };
        });
        return { gov_action_id: null, proposal_tx_hash: null, proposal_index: null, is_dissolved: !!st?.noConfidence, quorum: { numerator: st?.thrNum ?? 0, denominator: st?.thrDen ?? 1 }, members };
    }),
];
void getStoredEpochParams;

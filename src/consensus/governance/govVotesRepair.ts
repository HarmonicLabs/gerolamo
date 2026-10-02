/**
 * One-time repair of the votes stored on the live proposals (bug 166): recompute them from the chain
 * as cardano-ledger-conway 1.22.1 keeps them and correct the store.
 *
 * What the ledger does with a vote (`Rules/Gov.hs`): a vote of a known voter on a live action is
 * inserted into the action's map for its voter (a later vote replaces an earlier one); after the
 * transaction's votes are in, the DRep votes of every DRep the transaction's certificates unregister
 * (`UnRegDRepTxCert`) are removed from every live action (`cleanupProposalVotes`). Nothing else
 * removes a vote: a committee member's resignation or expiry and a pool's retirement leave their
 * votes in place (RATIFY ignores them at tally time, `committeeAcceptedRatio` / `spoAcceptedRatio`),
 * and votes leave the state only with their action at a boundary. Phase-2-invalid transactions
 * apply nothing.
 *
 * Builds before bug 156 kept an unregistering DRep's votes, so a DRep that voted, unregistered and
 * registered again still carries its old vote in our store (preview 3036 and the producer: one vote
 * on 56348457…:0 by e8cfbc95…, cast 2026-09-29 before its 16:33 UTC deregistration; the relay's
 * GetProposals has none). The repair walks the selected chain from the first slot of the oldest live
 * proposal's epoch to the tip (the chunk store and the volatile files, read-only), applies the votes
 * and the removals in order for the live action ids, and then deletes, adds or changes stored votes
 * so they equal the result; a matching vote keeps its stored slot. It runs once per store, in the
 * same place as the credential migration (inside the first Conway block a new build applies, so the
 * LMDB writes are part of that block's diff): SQLite marker `gov_votes_repaired_v1`, LMDB
 * `gov_state.credSchema` = 2. `scripts/gov-votes-repair.ts --dry-run` prints the diff for a node's
 * stores without touching them.
 */
import { sql } from "../../sql";
import { ledgerGov, ledgerGovReads, sqlLedgerWrites } from "../../ledger/nodeLedgerStore";
import { logger } from "../../utils/logger";
import { firstSlotOfEpoch } from "../../utils/epochFromSlotCalculations";
import { blockTxBodies, bodyHasKey, decodeGovTx, type GovTxModel } from "./govTxDecode";
import { loadLiveProposals } from "./govLedgerView";

export interface StoredVote { voterKind: number; voterHash: string; vote: number; slot: number }
export type VoteMap = Map<string, StoredVote>; // `${voterKind}:${voterHash}` → vote
export const voteKeyOf = (kind: number, hash: string): string => `${kind}:${hash.toLowerCase()}`;

/**
 * The votes the ledger holds on `liveIds` after applying `txs` (phase-2-valid, in chain order) to
 * empty vote maps: per action id, per voter, the last vote, minus the DRep votes removed by an
 * unregistration in the same or a later transaction.
 */
export function survivingVotes(txs: Iterable<{ slot: number; model: GovTxModel }>, liveIds: ReadonlySet<string>): Map<string, VoteMap> {
    const out = new Map<string, VoteMap>();
    for (const id of liveIds) out.set(id, new Map());
    for (const { slot, model } of txs) {
        for (const v of model.votes) {
            const m = out.get(v.actionId);
            if (!m) continue; // an action that is not live: its votes are gone with it, or never existed
            m.set(voteKeyOf(v.voterKind, v.voterHash), { voterKind: v.voterKind, voterHash: v.voterHash.toLowerCase(), vote: v.vote, slot });
        }
        for (const c of model.certs) {
            if (c.type !== 17 || !c.cred) continue;
            const key = voteKeyOf(c.cred.length === 58 ? 3 : 2, c.cred.length === 58 ? c.cred.slice(2) : c.cred);
            for (const m of out.values()) m.delete(key);
        }
    }
    return out;
}

export interface VoteRepairPlan {
    remove: Array<{ actionId: string } & StoredVote>;
    add: Array<{ actionId: string } & StoredVote>;
    /** Stored with another vote value: rewritten with the chain's vote and slot. */
    change: Array<{ actionId: string; stored: StoredVote; expected: StoredVote }>;
}

/** The corrections that make `stored` (per live action) equal `expected`. */
export function planVoteRepair(stored: Map<string, VoteMap>, expected: Map<string, VoteMap>): VoteRepairPlan {
    const plan: VoteRepairPlan = { remove: [], add: [], change: [] };
    for (const [actionId, exp] of expected) {
        const have = stored.get(actionId) ?? new Map<string, StoredVote>();
        for (const [k, v] of have) { const e = exp.get(k); if (!e) plan.remove.push({ actionId, ...v }); else if (e.vote !== v.vote) plan.change.push({ actionId, stored: v, expected: e }); }
        for (const [k, e] of exp) if (!have.has(k)) plan.add.push({ actionId, ...e });
    }
    const byId = (a: { actionId: string; voterKind?: number; voterHash?: string }, b: { actionId: string; voterKind?: number; voterHash?: string }) => a.actionId.localeCompare(b.actionId) || (a.voterKind ?? 0) - (b.voterKind ?? 0) || (a.voterHash ?? "").localeCompare(b.voterHash ?? "");
    plan.remove.sort(byId); plan.add.sort(byId); plan.change.sort((a, b) => byId({ actionId: a.actionId, ...a.stored }, { actionId: b.actionId, ...b.stored }));
    return plan;
}

const VOTE_KEYS = new Set([4, 19]); // certificates, voting procedures

/** The governance transactions of a stored block (`[era, block]`), phase-2-valid and carrying certificates or votes. */
export function govTxsOfBlock(slot: number, bytes: Uint8Array): Array<{ slot: number; model: GovTxModel }> {
    const out: Array<{ slot: number; model: GovTxModel }> = [];
    let parsed: ReturnType<typeof blockTxBodies>;
    try { parsed = blockTxBodies(bytes); } catch { return out; }
    if (parsed.era < 7) return out;
    parsed.bodies.forEach((b, i) => {
        if (parsed.invalid.has(i) || !bodyHasKey(b, VOTE_KEYS)) return;
        try { out.push({ slot, model: decodeGovTx(b, "-") }); } catch { /* not decodable: the rules report it */ }
    });
    return out;
}

export async function storedVotesOf(actionIds: string[]): Promise<Map<string, VoteMap>> {
    const gr = ledgerGovReads();
    const out = new Map<string, VoteMap>();
    for (const id of actionIds) {
        const m: VoteMap = new Map();
        const rows: StoredVote[] = gr
            ? gr.votes(id).map((v) => ({ voterKind: v.voterKind, voterHash: v.voterHash, vote: v.vote, slot: v.slot }))
            : ((await sql`SELECT voter_kind, voter_hash, vote, slot FROM gov_votes WHERE action_id = ${id}`.values()) as unknown[][]).map((r) => ({ voterKind: Number(r[0]), voterHash: String(r[1]).toLowerCase(), vote: Number(r[2]), slot: Number(r[3]) }));
        for (const v of rows) m.set(voteKeyOf(v.voterKind, v.voterHash), v);
        out.set(id, m);
    }
    return out;
}

export interface VoteRepairResult { plan: VoteRepairPlan; live: number; blocks: number; txs: number; fromSlot: number; toSlot: number }

/**
 * Compute the repair plan for the live proposals from `chain` (the selected chain's blocks from
 * `fromSlot`, ascending) and, unless `dryRun`, apply it to the store.
 */
export async function repairLiveProposalVotes(chain: (fromSlot: number) => AsyncIterable<{ slot: number; bytes: Uint8Array }>, opts: { dryRun: boolean; txsOfBlock?: (b: { slot: number; bytes: Uint8Array }) => Array<{ slot: number; model: GovTxModel }> }): Promise<VoteRepairResult> {
    const txsOfBlock = opts.txsOfBlock ?? ((b) => govTxsOfBlock(b.slot, b.bytes)); // tests feed decoded transactions
    const live = await loadLiveProposals();
    const ids = new Set(live.map((p) => p.id));
    const fromSlot = live.length ? Number(firstSlotOfEpoch(Math.min(...live.map((p) => p.proposedEpoch)))) : 0;
    const txs: Array<{ slot: number; model: GovTxModel }> = [];
    let blocks = 0, toSlot = fromSlot;
    if (live.length) for await (const b of chain(fromSlot)) { blocks++; toSlot = b.slot; txs.push(...txsOfBlock(b)); }
    const expected = survivingVotes(txs, ids);
    const plan = planVoteRepair(await storedVotesOf([...ids]), expected);
    if (!opts.dryRun) {
        const gw = ledgerGov();
        for (const v of plan.remove) { gw?.delVote(v.actionId, v.voterKind, v.voterHash); if (sqlLedgerWrites()) await sql`DELETE FROM gov_votes WHERE action_id = ${v.actionId} AND voter_kind = ${v.voterKind} AND voter_hash = ${v.voterHash}`; }
        for (const v of [...plan.add, ...plan.change.map((c) => ({ actionId: c.actionId, ...c.expected }))]) {
            gw?.putVote({ actionId: v.actionId, voterKind: v.voterKind, voterHash: v.voterHash, vote: v.vote, slot: v.slot });
            if (sqlLedgerWrites()) await sql`INSERT OR REPLACE INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES (${v.actionId}, ${v.voterKind}, ${v.voterHash}, ${v.vote}, ${v.slot})`;
        }
    }
    return { plan, live: live.length, blocks, txs: txs.length, fromSlot, toSlot };
}

export function describeVoteRepair(r: VoteRepairResult): string[] {
    const kind = (k: number) => ["CC key", "CC script", "DRep key", "DRep script", "pool"][k] ?? String(k);
    const out = [`${r.live} live proposal(s); ${r.blocks} block(s) walked from slot ${r.fromSlot} to ${r.toSlot}, ${r.txs} transaction(s) with certificates or votes`];
    for (const v of r.plan.remove) out.push(`REMOVE ${v.actionId} ${kind(v.voterKind)} ${v.voterHash} vote ${v.vote} (stored at slot ${v.slot}): the chain does not hold it`);
    for (const v of r.plan.add) out.push(`ADD    ${v.actionId} ${kind(v.voterKind)} ${v.voterHash} vote ${v.vote} (slot ${v.slot}): missing from the store`);
    for (const c of r.plan.change) out.push(`CHANGE ${c.actionId} ${kind(c.stored.voterKind)} ${c.stored.voterHash} vote ${c.stored.vote} → ${c.expected.vote} (slot ${c.expected.slot})`);
    out.push(`${r.plan.remove.length} removal(s), ${r.plan.add.length} addition(s), ${r.plan.change.length} change(s)`);
    return out;
}

const MARKER = "gov_votes_repaired_v1";
let attempted = false;

/**
 * The node's one-time run (from `migrateGovCredentials`, inside the first Conway block applied):
 * walks the block store's selected chain — the block being applied is not in it yet — and marks
 * the store. Without a block store (SQLite-only tests) nothing runs and nothing is marked.
 */
export async function repairLiveProposalVotesOnce(): Promise<VoteRepairResult | null> {
    if (attempted) return null;
    const gw = ledgerGov();
    if (gw) { const st = gw.reads.state(); if (!st) return null; if ((st.credSchema ?? 0) >= 2) { attempted = true; return null; } }
    else {
        try { const m = (await sql`SELECT 1 FROM schema_migrations WHERE name = ${MARKER}`.values()) as unknown[][]; if (m.length) { attempted = true; return null; } } catch { attempted = true; return null; }
        if (!((await sql`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][]).length) return null;
    }
    const { getNodeBlockStore } = await import("../../storage/nodeBlockStore");
    const { selectedChain } = await import("../../storage/blockReads");
    const store = getNodeBlockStore();
    if (!store) { attempted = true; logger.warn("governance votes repair (bug 166) skipped: no block store to replay the chain from"); return null; }
    attempted = true;
    const t0 = performance.now();
    const r = await repairLiveProposalVotes((from) => selectedChain(store, from, Number.MAX_SAFE_INTEGER), { dryRun: false });
    if (gw) gw.updateState({ credSchema: 2 });
    if (sqlLedgerWrites()) { try { await sql`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${MARKER})`; } catch { /* bare test DB */ } }
    for (const line of describeVoteRepair(r)) logger.info(`governance votes repair (bug 166): ${line}`);
    logger.info(`governance votes repair (bug 166) done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return r;
}

export function resetGovVotesRepairForTests(): void { attempted = false; }

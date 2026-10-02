/** Dual-run verifier for the governance, parameter and nonce databases (phase 3): touched keys vs SQLite rows. */
import { sql } from "../sql";
import type { LedgerDiff } from "./LedgerDiff";
import { unhex } from "./LedgerDiff";
import { GDB, keyAction, type GovReads } from "./govStore";
import { keyHex } from "./stakeStore";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const str = (v: unknown) => (v == null ? null : String(v));
const rdU32 = (b: Uint8Array, o = 0) => new DataView(b.buffer, b.byteOffset).getUint32(o, false);

export async function verifyGovDiff(r: GovReads, d: LedgerDiff): Promise<{ checked: number; differences: string[] }> {
    const out = { checked: 0, differences: [] as string[] };
    const diff = (s: string) => out.differences.push(s);
    for (const k of d.touchedKeys(GDB.dreps)) {
        out.checked++;
        const rs = (await sql`SELECT is_script, deposit, registered_slot, last_active_epoch, expiry_epoch FROM gov_dreps WHERE credential = ${k}`.values()) as unknown[][];
        const a = rs.length ? { isScript: Number(rs[0]![0] ?? 0), deposit: String(rs[0]![1]), registeredSlot: Number(rs[0]![2]), lastActiveEpoch: Number(rs[0]![3]), expiryEpoch: rs[0]![4] == null ? null : Number(rs[0]![4]) } : null;
        if (!same(a, r.drep(k))) diff(`gov_dreps ${k.slice(0, 12)}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(r.drep(k))}`);
    }
    for (const k of d.touchedKeys(GDB.drepDeleg)) {
        out.checked++;
        const rs = (await sql`SELECT drep_type, drep_hash FROM gov_drep_delegations WHERE stake_key = ${k}`.values()) as unknown[][];
        const a = rs.length ? { type: Number(rs[0]![0]), hash: str(rs[0]![1]) } : null;
        if (!same(a, r.drepDelegation(k))) diff(`gov_drep_delegations ${k.slice(0, 12)}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(r.drepDelegation(k))}`);
    }
    for (const k of d.touchedKeys(GDB.committee)) {
        out.checked++;
        const rs = (await sql`SELECT expires_epoch, hot_credential, resigned FROM gov_committee WHERE cold_credential = ${k}`.values()) as unknown[][];
        const a = rs.length ? { expiresEpoch: Number(rs[0]![0]), hot: str(rs[0]![1]), resigned: Number(rs[0]![2] ?? 0) } : null;
        const b = r.committee().get(k) ?? null;
        if (!same(a, b)) diff(`gov_committee ${k.slice(0, 12)}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`);
    }
    for (const k of d.touchedKeys(GDB.ccAuth)) {
        out.checked++;
        const rs = (await sql`SELECT hot_credential, resigned FROM gov_committee_auth WHERE cold_credential = ${k}`.values()) as unknown[][];
        const a = rs.length ? { hot: str(rs[0]![0]), resigned: Number(rs[0]![1] ?? 0) } : null;
        if (!same(a, r.committeeAuth(k))) diff(`gov_committee_auth ${k.slice(0, 12)}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(r.committeeAuth(k))}`);
    }
    if (d.touchedKeys(GDB.state).size) {
        out.checked++;
        const rs = (await sql`SELECT committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, prev_pparams, prev_hardfork, prev_committee, prev_constitution, seeded_epoch, dormant_epochs, pending FROM gov_state WHERE id = 1`.values()) as unknown[][];
        const x = rs[0];
        const a = x ? { thrNum: Number(x[0]), thrDen: Number(x[1]), constitutionHash: str(x[2]), constitutionScript: str(x[3]), noConfidence: Number(x[4] ?? 0), prevPP: str(x[5]), prevHF: str(x[6]), prevCC: str(x[7]), prevCons: str(x[8]), seededEpoch: Number(x[9]), dormantEpochs: Number(x[10] ?? 0), pending: str(x[11]) } : null;
        const b = r.state(); if (b) delete (b as { credSchema?: number }).credSchema; // an LMDB-only migration marker (bug 153)
        if (!same(a, b)) diff(`gov_state: sqlite ${JSON.stringify(a)?.slice(0, 300)} lmdb ${JSON.stringify(b)?.slice(0, 300)}`);
    }
    for (const k of d.touchedKeys(GDB.proposals)) {
        out.checked++;
        const id = keyAction(unhex(k));
        const rs = (await sql`SELECT seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status, decided_epoch FROM gov_proposals WHERE action_id = ${id}`.values()) as unknown[][];
        const x = rs[0];
        const a = x ? { actionId: id, seq: Number(x[0]), kind: String(x[1]), prevActionId: str(x[2]), deposit: String(x[3]), returnAccount: String(x[4]), payload: String(x[5]), proposedEpoch: Number(x[6]), expiresEpoch: Number(x[7]), status: String(x[8] ?? "active"), decidedEpoch: x[9] == null ? null : Number(x[9]) } : null;
        const b = r.proposal(id);
        if (!same(a, b)) diff(`gov_proposals ${id.slice(0, 12)}: sqlite ${JSON.stringify(a)?.slice(0, 200)} lmdb ${JSON.stringify(b)?.slice(0, 200)}`);
    }
    for (const k of d.touchedKeys(GDB.votes)) {
        out.checked++;
        const key = unhex(k), id = keyAction(key.subarray(0, 36)), kind = key[36]!, voter = keyHex(key.subarray(37));
        const rs = (await sql`SELECT vote, slot FROM gov_votes WHERE action_id = ${id} AND voter_kind = ${kind} AND voter_hash = ${voter}`.values()) as unknown[][];
        const a = rs.length ? { vote: Number(rs[0]![0]), slot: Number(rs[0]![1]) } : null;
        const v = r.votes(id).find((x) => x.voterKind === kind && x.voterHash === voter);
        const b = v ? { vote: v.vote, slot: v.slot } : null;
        if (!same(a, b)) diff(`gov_votes ${id.slice(0, 12)}/${kind}/${voter.slice(0, 8)}: sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`);
    }
    const enactedEpochs = new Set<number>(); for (const k of d.touchedKeys(GDB.enacted)) enactedEpochs.add(rdU32(unhex(k)));
    for (const e of enactedEpochs) {
        out.checked++;
        const rs = (await sql`SELECT action_id, kind, detail FROM gov_enacted WHERE epoch = ${e} ORDER BY action_id`.values()) as unknown[][];
        const a = rs.map((x) => ({ actionId: String(x[0]), kind: String(x[1]), detail: str(x[2]) }));
        const b = r.enactedAt(e).sort((x, y) => (x.actionId < y.actionId ? -1 : 1));
        if (!same(a, b)) diff(`gov_enacted ${e}: sqlite ${a.length} lmdb ${b.length}`);
    }
    const stakeEpochs = new Set<number>(); for (const k of d.touchedKeys(GDB.drepStake)) stakeEpochs.add(rdU32(unhex(k)));
    for (const e of stakeEpochs) {
        out.checked++;
        const rs = (await sql`SELECT drep_type, drep_hash, stake FROM epoch_drep_stake WHERE taken_at = ${e}`.values()) as unknown[][];
        const a = new Map(rs.map((x) => [`${x[0]}:${x[1] ?? ""}`, String(x[2])]));
        const b = new Map(r.drepStake(e).map((x) => [`${x.type}:${x.hash}`, x.stake.toString()]));
        let bad = 0; for (const [k, v] of a) if (b.get(k) !== v) bad++; for (const k of b.keys()) if (!a.has(k)) bad++;
        if (bad) diff(`epoch_drep_stake ${e}: ${bad} DRep(s) differ (sqlite ${a.size}, lmdb ${b.size})`);
    }
    for (const k of d.touchedKeys(GDB.epochParams)) {
        out.checked++;
        const e = rdU32(unhex(k));
        const rs = (await sql`SELECT params, source FROM epoch_params WHERE epoch = ${e}`.values()) as unknown[][];
        const a = rs.length ? { params: JSON.parse(String(rs[0]![0])), source: str(rs[0]![1]) } : null;
        if (!same(a, r.epochParams(e))) diff(`epoch_params ${e}: ${a ? "present" : "absent"} in sqlite, ${r.epochParams(e) ? "present" : "absent"} in lmdb${a && r.epochParams(e) ? " (content differs)" : ""}`);
    }
    for (const k of d.touchedKeys(GDB.pparamProps)) {
        out.checked++;
        const key = unhex(k), e = rdU32(key), gk = keyHex(key.subarray(4));
        const rs = (await sql`SELECT changes_json, slot FROM pparam_proposals WHERE epoch = ${e} AND genesis_key = ${gk}`.values()) as unknown[][];
        const a = rs.length ? { changes: String(rs[0]![0]), slot: Number(rs[0]![1]) } : null;
        const b = r.pparamProposals(e).find((x) => x.genesisKey === gk);
        if (!same(a, b ? { changes: b.changes, slot: b.slot } : null)) diff(`pparam_proposals ${e}/${gk.slice(0, 8)} differ`);
    }
    for (const k of d.touchedKeys(GDB.nonces)) {
        out.checked++;
        const e = rdU32(unhex(k));
        const rs = (await sql`SELECT nonce_hex, source, evolving_hex, candidate_hex, start_evolving_hex, start_candidate_hex, start_slot, start_lab_hex FROM epoch_nonces WHERE epoch = ${e}`.values()) as unknown[][];
        const x = rs[0];
        const a = x ? { nonceHex: String(x[0]), source: String(x[1] ?? "external"), evolvingHex: str(x[2]), candidateHex: str(x[3]), startEvolvingHex: str(x[4]), startCandidateHex: str(x[5]), startSlot: x[6] == null ? null : Number(x[6]), startLabHex: str(x[7]) } : null;
        if (!same(a, r.nonce(e))) diff(`epoch_nonces ${e}: sqlite ${JSON.stringify(a)?.slice(0, 200)} lmdb ${JSON.stringify(r.nonce(e))?.slice(0, 200)}`);
    }
    return out;
}

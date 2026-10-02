/**
 * The one place the LocalStateQuery answers read governance identities from the gov store, so a
 * change of its keys touches only this file. Assumptions (2026-09-28):
 *   - `gov_dreps` / `gov_committee` / `gov_cc_auth` are keyed by the bare 28-byte hash today; a
 *     re-keying to (key | script, hash) is under way. Accepted key forms: 56 hex (bare; the kind
 *     comes from the row's `isScript`, the chain scan, or the Conway genesis), 58 hex with a 00 /
 *     01 prefix (the typed form the stake tables use), and "0:<hash>" / "1:<hash>".
 *   - `gov_drep_deleg` values: type 0 key, 1 script, 2 always-abstain, 3 always-no-confidence.
 *   - `gov_votes` voter kinds: 0 / 1 committee hot key / script, 2 / 3 DRep key / script, 4 pool.
 */
import type { CommitteeRow, CcAuthRow, DRepRow, GovReads } from "../../../ledger/govStore";
import type { GovFacts } from "./govIndex";

export interface Cred { type: number; hash: string }

/** Parse a gov-store key into (kind, hash); `kindHint` fills in the kind of a bare hash. */
export function parseGovKey(k: string, kindHint: (hash: string) => number | undefined): Cred {
    const s = k.toLowerCase();
    if (/^[01]:[0-9a-f]{56}$/.test(s)) return { type: Number(s[0]), hash: s.slice(2) };
    if (/^0[01][0-9a-f]{56}$/.test(s)) return { type: Number(s[1]), hash: s.slice(2) };
    return { type: kindHint(s) ?? 0, hash: s };
}

export interface DRepEntry { cred: Cred; row: DRepRow }
export function drepEntries(gov: GovReads): DRepEntry[] {
    const out: DRepEntry[] = [];
    for (const [k, row] of gov.dreps()) out.push({ cred: parseGovKey(k, () => (row.isScript ? 1 : 0)), row });
    return out;
}

export interface CommitteeEntry { cold: Cred; expiresEpoch: number; hot: Cred | null; resigned: boolean }
/**
 * Current committee members (cold → expiry) with their authorisation folded in, plus the
 * authorisations of cold credentials that are not members (the ledger's committee state keeps
 * both; `GetCommitteeMembersState` reports the latter as Unrecognized).
 */
export function committeeEntries(gov: GovReads, facts: GovFacts | null, genesisKinds: Map<string, number>): { members: CommitteeEntry[]; strayAuths: CommitteeEntry[] } {
    const kind = (h: string) => facts?.credType.get(h) ?? genesisKinds.get(h);
    const members: CommitteeEntry[] = [];
    const auths = new Map<string, { cold: Cred; a: CcAuthRow }>();
    for (const [k, a] of gov.committeeAuths()) { const cold = parseGovKey(k, kind); auths.set(cold.hash, { cold, a }); }
    const seen = new Set<string>();
    for (const [k, c] of gov.committee() as Map<string, CommitteeRow>) {
        const cold = parseGovKey(k, kind);
        seen.add(cold.hash);
        const a = auths.get(cold.hash)?.a;
        const hotHash = a ? a.hot : c.hot, resigned = a ? a.resigned !== 0 : c.resigned !== 0;
        members.push({ cold, expiresEpoch: c.expiresEpoch, hot: hotHash ? parseGovKey(hotHash, kind) : null, resigned });
    }
    const strayAuths: CommitteeEntry[] = [];
    for (const [h, { cold, a }] of auths) if (!seen.has(h)) strayAuths.push({ cold, expiresEpoch: -1, hot: a.hot ? parseGovKey(a.hot, kind) : null, resigned: a.resigned !== 0 });
    return { members, strayAuths };
}

/** Kinds of the Conway genesis committee members ("keyHash-…" / "scriptHash-…"). */
export function genesisCommitteeKinds(conwayGenesis: unknown): Map<string, number> {
    const out = new Map<string, number>();
    const members = (conwayGenesis as { committee?: { members?: Record<string, number> } })?.committee?.members ?? {};
    for (const k of Object.keys(members)) {
        const m = /^(keyHash|scriptHash)-([0-9a-f]{56})$/i.exec(k);
        if (m) out.set(m[2]!.toLowerCase(), m[1] === "scriptHash" ? 1 : 0);
    }
    return out;
}

/** The DRep a stake credential's vote is delegated to, as (drepKind, hash): 0 key, 1 script, 2 abstain, 3 no confidence. */
export function drepDelegations(gov: GovReads): Array<{ stakeKey: string; type: number; hash: string | null }> {
    const out: Array<{ stakeKey: string; type: number; hash: string | null }> = [];
    for (const [k, d] of gov.drepDelegations()) out.push({ stakeKey: k, type: d.type, hash: d.hash });
    return out;
}

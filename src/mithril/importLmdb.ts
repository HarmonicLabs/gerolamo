/**
 * Snapshot bootstrap straight into the LMDB ledger store (docs/PLAN_LMDB_LEDGER.md §5): the same
 * mapping as importUtxo.ts / importState.ts, written with the store's own group writers so a fresh
 * node never creates the SQLite ledger tables. The store ends anchored at the snapshot's block with
 * the current seed version; the node's first start finds it complete and syncs from there.
 */
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { LedgerStore } from "../ledger/LedgerStore";
import { GovWrites } from "../ledger/govStore";
import { ccKey } from "../consensus/governance/govLedgerView";
import { StakeWrites } from "../ledger/stakeStore";
import { UtxoWrites } from "../ledger/utxoStore";
import { markUtxoIndexBuilt } from "../ledger/utxoIndex";
import { markLedgerSource, markSeeded } from "../ledger/nodeLedgerStore";
import { streamTablesFile, txOutWireCbor } from "./importUtxo";
import { decodeUtxoEntry } from "../state/utxohdMemCodec";
import { drepColumns, payloadOf, poolParamsJson, withAllOwners } from "./importState";
import { conwayPParamsToRaw, typedHex, type LedgerSnapshot, type StakeSnapshot } from "./nesDecoder";

export interface ImportLmdbUtxoOptions { tablesPath: string; ledgerDir: string; batchSize?: number; limit?: number; log?: (m: string) => void; fresh?: boolean }
export interface ImportLmdbUtxoResult { entries: number; inserted: number; errors: number; lovelace: bigint; seconds: number }

/** Stream the snapshot's `tables` file into the store's UTxO group. `fresh` (default true) wipes the directory first. */
export async function importUtxoToLmdb(opts: ImportLmdbUtxoOptions): Promise<ImportLmdbUtxoResult> {
    const log = opts.log ?? (() => {});
    const { buildUtxoRowForOutput } = await import("../db");
    const t0 = performance.now();
    if (opts.fresh !== false && existsSync(opts.ledgerDir)) rmSync(opts.ledgerDir, { recursive: true, force: true });
    mkdirSync(opts.ledgerDir, { recursive: true });
    const st = LedgerStore.open(opts.ledgerDir);
    const w = new UtxoWrites(st);
    const result: ImportLmdbUtxoResult = { entries: 0, inserted: 0, errors: 0, lovelace: 0n, seconds: 0 };
    const batchSize = opts.batchSize ?? 50_000;
    let batch: Array<Parameters<UtxoWrites["put"]>[0]> = [];
    const errorsShown: string[] = [];
    const flush = () => { const rows = batch; batch = []; st.applyDirectSync(() => { for (const r of rows) w.put(r); }); result.inserted += rows.length; };
    streamTablesFile(opts.tablesPath, (key, val, index) => {
        result.entries++;
        const dec = decodeUtxoEntry(key, val);
        if (!dec.ok) { result.errors++; if (errorsShown.length < 10) errorsShown.push(`entry ${index}: ${dec.error} @${dec.off}`); return; }
        const { txIn, txOut } = dec.value;
        try {
            const out = TxOut.fromCbor(txOutWireCbor(txOut));
            const txHash = txIn.txIdHex.toLowerCase();
            const row = buildUtxoRowForOutput(txHash, txIn.txIx, out);
            batch.push({ utxo_ref: row.utxoRef, tx_out: row.txOutJson, tx_hash: txHash, address: row.cols.address ?? row.address, lovelace: row.cols.lovelace ?? row.lovelace, reference_script_hash: row.cols.referenceScriptHash ?? null, stake_key: row.cols.stakeKey ?? null });
            result.lovelace += BigInt(row.lovelace);
            if (batch.length >= batchSize) flush(); // the tables stream is synchronous: so is the write
        } catch (err) {
            result.errors++;
            if (errorsShown.length < 10) errorsShown.push(`entry ${index} tag ${txOut.tag}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (result.entries % 250_000 === 0) log(`import-utxo (lmdb): ${result.entries} entries, ${result.inserted} rows, ${result.errors} error(s), ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }, { limit: opts.limit });
    if (batch.length) flush();
    if (opts.fresh !== false) markUtxoIndexBuilt(st); // a fresh store whose every row went through UtxoWrites: the search indexes are complete
    for (const e of errorsShown) log(`import-utxo (lmdb) error: ${e}`);
    st.close();
    result.seconds = (performance.now() - t0) / 1000;
    return result;
}

export interface ImportLmdbStateOptions { ledgerDir: string; snapshot: LedgerSnapshot; nodeVersion?: string | null; log?: (m: string) => void }
export interface ImportLmdbStateResult { counts: Record<string, number>; feePot: bigint; warnings: string[]; seconds: number }

/** Write the decoded NewEpochState into the store's stake and governance groups and anchor it at the snapshot block. */
export async function importStateToLmdb(opts: ImportLmdbStateOptions): Promise<ImportLmdbStateResult> {
    const t0 = performance.now();
    const s = opts.snapshot;
    const log = opts.log ?? (() => {});
    const warnings: string[] = [];
    const counts: Record<string, number> = {};
    const count = (t: string, n: number) => { counts[t] = (counts[t] ?? 0) + n; };
    const E = s.epoch, S = s.slot;
    if (s.stashedAvvm) throw new Error("import-state: stashed AVVM addresses present (mainnet Byron-era state) — not supported yet");
    if (!s.irwdEmpty) throw new Error("import-state: pending MIR transfers present — not supported in Conway");
    if (opts.nodeVersion && !/^11\.0\./.test(opts.nodeVersion)) warnings.push(`snapshot written by cardano-node ${opts.nodeVersion}; the decoder is pinned to 11.0.x`);
    let deposits = 0n;
    for (const u of s.umap) deposits += u.deposit;
    for (const p of s.pools.values()) deposits += p.deposit;
    for (const d of s.dreps) deposits += d.deposit;
    for (const p of s.gov.proposals) deposits += p.deposit;
    if (deposits !== s.deposited) warnings.push(`deposits: node ${s.deposited}, sum of the imported deposits ${deposits}`);
    const feePot = s.fees - s.snapshots.fee;
    if (feePot < 0n) throw new Error(`import-state: fee pot ${s.fees} smaller than the frozen snapshot fee ${s.snapshots.fee}`);
    if (!s.praos.epochNonce || !s.praos.evolving || !s.praos.candidate) throw new Error("import-state: neutral Praos nonces");

    mkdirSync(opts.ledgerDir, { recursive: true });
    const st = LedgerStore.open(opts.ledgerDir);
    const w = new StakeWrites(st), g = new GovWrites(st);
    const step = (fn: () => void) => st.applyDirect(fn);
    try {
        // ── accounts (the unified map), in slices ──
        const umap = s.umap;
        for (let i = 0; i < umap.length; i += 50_000) {
            const slice = umap.slice(i, i + 50_000);
            await step(() => {
                for (const u of slice) {
                    const key = typedHex(u.cred);
                    w.registerStake(key); count("stake", 1);
                    if (u.reward > 0n) { w.creditRewards(new Map([[key, u.reward]])); count("rewards", 1); }
                    if (u.pool) { w.delegate(key, u.pool); count("delegations", 1); }
                    if (u.drep) { const d = drepColumns(u.drep); g.putDRepDelegation(key, { type: d.type, hash: d.hash }); count("gov_drep_delegations", 1); }
                }
            });
        }
        await step(() => {
            // ── pools ──
            for (const [id, p] of s.pools) { w.putPool(id, { vrf: p.vrf, registeredSlot: 0, retiringEpoch: s.retiring.get(id) ?? null, params: JSON.parse(poolParamsJson(p)) }); count("pool_params", 1); }
            for (const [id, p] of s.futurePools) { w.putPoolPending(id, { vrf: p.vrf, registeredSlot: S, params: JSON.parse(poolParamsJson(p)) }); count("pool_params_pending", 1); }
            for (const id of s.retiring.keys()) if (!s.pools.has(id)) warnings.push(`retiring pool ${id} is not registered`);
            // ── blocks made, op-cert counters ──
            for (const [epoch, m] of [[E - 1, s.blocksPrev], [E, s.blocksCur]] as Array<[number, Map<string, number>]>) { for (const [pool, n] of m) w.putBlocksMade(epoch, pool, n); count("blocks_made_by_epoch", m.size); }
            for (const [pool, c] of s.praos.ocertCounters) w.putOpcert(pool, c, S);
            count("opcert_counters", s.praos.ocertCounters.size);
            // ── pots ──
            w.putPots({ reserves: s.reserves, treasury: s.treasury, feePot, donationPot: s.donation, initializedEpoch: E });
            w.recordPotSnapshot(E, { reserves: s.reserves, treasury: s.treasury, feesCollected: s.snapshots.fee });
            count("reward_pots", 1); count("pot_snapshots", 1);
            // ── pool-ranking state (bug 262): the boundaries after the snapshot advance it ──
            w.putNonMyopic(E, { rewardPot: s.nonMyopicRewardPot, likelihoods: s.nonMyopicLikelihoods });
            count("nonmyopic", s.nonMyopicLikelihoods.size);
            // ── parameters ──
            for (const [epoch, pp] of [[E, s.gov.curPParams], [E - 1, s.gov.prevPParams]] as const) { g.putEpochParams(epoch, { ...conwayPParamsToRaw(pp), epoch, source: "local" }, "local"); count("epoch_params", 1); }
            if (s.gov.futurePParams.kind !== "none") warnings.push(`future parameters (${s.gov.futurePParams.kind}) present: our boundary derives them from the enacted proposals`);
            // ── nonces ──
            g.putNonce(E, { nonceHex: s.praos.epochNonce!, source: "local", evolvingHex: s.praos.evolving!, candidateHex: s.praos.candidate!, startEvolvingHex: s.praos.evolving!, startCandidateHex: s.praos.candidate!, startSlot: S, startLabHex: s.praos.lastEpochBlock ?? null });
            if (s.praos.previousEpochNonce) g.putNonce(E - 1, { nonceHex: s.praos.previousEpochNonce, source: "local", evolvingHex: null, candidateHex: null, startEvolvingHex: null, startCandidateHex: null, startSlot: null, startLabHex: null });
            count("epoch_nonces", s.praos.previousEpochNonce ? 2 : 1);
            // ── genesis delegations ──
            for (const [gk, d] of s.genDelegs) w.recordGenesisDelegation(gk, d.delegate, d.vrf, 0);
            count("genesis_delegs", s.genDelegs.size);
        });
        // ── stake snapshots: mark (E), set (E−1), go (E−2) ──
        const snaps: Array<[number, StakeSnapshot]> = [[E, s.snapshots.mark], [E - 1, s.snapshots.set], [E - 2, s.snapshots.go]];
        for (const [takenAt, snap] of snaps) {
            const entries = [...snap.stake];
            const perPool = new Map<string, bigint>();
            let total = 0n;
            for (let i = 0; i < entries.length; i += 50_000) {
                const slice = entries.slice(i, i + 50_000);
                await step(() => { for (const [key, e] of slice) { w.putSnapshotCred(takenAt, key, e.pool, e.stake); perPool.set(e.pool, (perPool.get(e.pool) ?? 0n) + e.stake); total += e.stake; } });
            }
            await step(() => {
                for (const [pool, stk] of perPool) w.putSnapshotPool(takenAt, pool, stk);
                w.putSnapshotTotals(takenAt, total, perPool.size);
                for (const [id, p] of snap.pools) { const full = withAllOwners(p, s.pools.get(id)); w.putSnapshotPoolParams(takenAt, id, p.vrf, JSON.parse(poolParamsJson(full))); }
                for (const [id, p] of snap.pools) if (p.delegators || p.owners.length) w.putSnapshotPoolMeta(takenAt, id, p.delegators, [...p.owners].sort()); // the node's own counts
                // pools with delegators whose stake sums to zero: GetPoolDistr and the pulser's SPO distribution list them at 0 (bugs 188, 247, 370)
                for (const [id, p] of snap.pools) if (p.delegators > 0 && !((perPool.get(id) ?? 0n) > 0n)) { w.putSnapshotPoolZero(takenAt, id); count("epoch_pool_zero", 1); }
            });
            count("epoch_stake_cred", snap.stake.size); count("epoch_pool_stake", perPool.size); count("epoch_pool_params", snap.pools.size);
            for (const [pool, p] of snap.pools) { const stk = perPool.get(pool) ?? 0n; if (stk !== p.stake) warnings.push(`snapshot ${takenAt}: pool ${pool.slice(0, 12)} stake ${p.stake} vs summed ${stk}`); }
        }
        // ── governance ──
        await step(() => {
            const raw = conwayPParamsToRaw(s.gov.curPParams);
            const activity = Number(raw.drep_activity ?? 20);
            for (const d of s.dreps) { g.putDRep(typedHex(d.cred), { isScript: d.cred.type, deposit: String(d.deposit), registeredSlot: 0, lastActiveEpoch: d.expiry - activity, expiryEpoch: d.expiry }); } // typed key (bug 153)
            count("gov_dreps", s.dreps.length);
            // committee credentials typed, "00"/"01" + hash (bug 153)
            const hotOf = (coldTyped: string): { hot: string | null; resigned: number } => { const a = s.committeeState.get(coldTyped); if (!a) return { hot: null, resigned: 0 }; return "hot" in a ? { hot: ccKey(typedHex(a.hot)), resigned: 0 } : { hot: null, resigned: 1 }; };
            if (s.gov.committee) for (const [cold, expiry] of s.gov.committee.members) { const h = hotOf(cold); g.putCommittee(ccKey(cold), { expiresEpoch: expiry, hot: h.hot, resigned: h.resigned }); count("gov_committee", 1); }
            for (const [cold, a] of s.committeeState) { g.putCommitteeAuth(ccKey(cold), { hot: "hot" in a ? ccKey(typedHex(a.hot)) : null, resigned: "hot" in a ? 0 : 1 }); count("gov_committee_auth", 1); }
            const pending = { epoch: E, ratified: s.gov.pulsing.enacted, expired: s.gov.pulsing.expired };
            g.putState({ credSchema: 1, thrNum: Number(s.gov.committee?.thresholdNum ?? 0n), thrDen: Number(s.gov.committee?.thresholdDen ?? 1n), constitutionHash: s.gov.constitution.anchor.hash, constitutionScript: s.gov.constitution.script ?? null, noConfidence: s.gov.committee ? 0 : 1, prevPP: s.gov.roots.pparams ?? null, prevHF: s.gov.roots.hardFork ?? null, prevCC: s.gov.roots.committee ?? null, prevCons: s.gov.roots.constitution ?? null, seededEpoch: E, dormantEpochs: s.dormantEpochs, pending: JSON.stringify(pending) });
            count("gov_state", 1);
            const ratified = new Set(s.gov.pulsing.enacted);
            s.gov.proposals.forEach((p, i) => {
                const isRatified = ratified.has(p.id);
                g.putProposal({ actionId: p.id, seq: i + 1, kind: p.action.kind, prevActionId: p.action.prev ?? null, deposit: String(p.deposit), returnAccount: typedHex(p.returnAccount), payload: JSON.stringify(payloadOf(p.action)), proposedEpoch: p.proposedIn, expiresEpoch: p.expiresAfter, status: isRatified ? "ratified" : "active", decidedEpoch: isRatified ? E : null });
                count("gov_proposals", 1);
                for (const [cred, v] of p.ccVotes) { g.putVote({ actionId: p.id, voterKind: cred.length > 56 ? 1 : 0, voterHash: cred.slice(-56), vote: v, slot: S }); count("gov_votes", 1); }
                for (const [cred, v] of p.drepVotes) { g.putVote({ actionId: p.id, voterKind: cred.length > 56 ? 3 : 2, voterHash: cred.slice(-56), vote: v, slot: S }); count("gov_votes", 1); }
                for (const [pool, v] of p.spoVotes) { g.putVote({ actionId: p.id, voterKind: 4, voterHash: pool, vote: v, slot: S }); count("gov_votes", 1); }
            });
            for (const id of s.gov.pulsing.enacted) if (!s.gov.proposals.some((p) => p.id === id)) warnings.push(`ratified action ${id} is not among the live proposals`);
            for (const [key, stk] of s.gov.pulsing.drepDistr) { const [t, h] = key.split(":"); g.putDRepStake(E, Number(t), h ?? "", stk); count("epoch_drep_stake", 1); }
        });
        // ── anchor and seed marker ──
        await st.setAnchor({ slot: S, hash: Uint8Array.from(Buffer.from(s.blockHash, "hex")) });
        await markSeeded(st);
        await markLedgerSource(st, "snapshot");
        log(`import-state (lmdb): epoch ${E} slot ${S} block ${s.blockNo} ${s.blockHash.slice(0, 12)}…: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; fee pot ${feePot}`);
        for (const wmsg of warnings) log(`import-state (lmdb): warning: ${wmsg}`);
        return { counts, feePot, warnings, seconds: (performance.now() - t0) / 1000 };
    } finally {
        st.close();
    }
}

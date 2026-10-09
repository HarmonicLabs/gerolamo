/**
 * The validating mempool: transactions are admitted only if they apply to the ledger at the tip
 * (ticked to the next slot, as cardano-node does) *after* every transaction already in the
 * mempool, in order — inputs spent by an earlier mempool transaction are gone, its outputs are
 * spendable. On every tip change the whole sequence is re-applied (cardano-node
 * `syncWithLedger`): transactions a new block included (all inputs spent), made invalid (inputs
 * spent by another transaction, validity interval passed) or that no longer fit are dropped. A
 * rollback takes the same path; like cardano-node, transactions of rolled-back blocks are not
 * re-added (their submitters resubmit).
 *
 * Storage stays in the shared-memory SharedMempool (the outbound tx-submission clients serve
 * peers from it); this class owns the order, the ledger overlay and the verdicts.
 *
 * Cost control: signature checks and Plutus scripts run once per transaction on a worker (a
 * revalidation reuses the verdicts, cardano-node's `reapplyTx` skips them too); everything runs
 * under one lock, and a revalidation yields to the event loop between transactions.
 */
import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { CborObj } from "@harmoniclabs/cbor";
import { logger } from "../utils/logger";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import { collectShelleyWitnesses } from "../consensus/rules/witnesses";
import { runWitnessVerifyJob } from "../consensus/workers/witnessJob";
import type { ValidationPool } from "../consensus/workers/ValidationPool";
import { outputLike, advanceResolved } from "../consensus/rules/blockRulesPure";
import { rewardAccountKey } from "../consensus/rules/ledgerChecks";
import { certStakeEffect, credKey, stakeCredentialsTouched, type CertView } from "../consensus/certificateRules";
import { LedgerF, RuleRun, UtxoF, UtxosF, UtxowF } from "./applyTxErr";
import { checkBlockGovernance, govRulesMode } from "../consensus/governance/govValidate";
import { bodyHasGovernance } from "../consensus/governance/govTxDecode";
import type { GovLedgerView } from "../consensus/governance/govRules";
import { evaluateMempoolPhase1, MAX_REF_SCRIPT_SIZE_PER_BLOCK, totalExUnits, txRefScriptBytes, type MempoolLedgerState, type MempoolLookups, type WitnessVerdict } from "./conwayMempoolRules";
import { parseMempoolTx, type MempoolTx } from "./mempoolTx";
import type { MempoolPlutusJob, MempoolPlutusResult } from "./plutusJob";
import { runMempoolPlutusJob } from "./plutusJob";

const log = logger.child("mempool");

/** What the mempool reads from the node: the tip, the ledger state at a slot, and lookups. */
export interface MempoolLedgerView {
    tip(): Promise<{ slot: bigint; hash: string } | null>;
    /** Ledger state for validating at `slot` (the tip + 1), or null when unavailable (parameters not loaded). */
    state(slot: bigint): Promise<MempoolLedgerState | null>;
    resolve(refs: string[]): Promise<Map<string, ResolvedUtxo>>;
    pools(ids: string[]): Promise<Set<string>>;
    rewardBalances(creds: string[]): Promise<Map<string, bigint> | undefined>;
    /** Registration / delegation state of stake credentials (keys `credKey(type, hex)`); null when unknown. */
    stake(creds: Array<{ hex: string; type: number }>): Promise<{ registered: Set<string>; delegated: Map<string, string> } | null>;
    /** The network name for slot → time in the Plutus context (preview / preprod / mainnet). */
    epochNetwork(): string;
    /** Are the reward balances exact (nodeLedgerStore `ledgerStateExact`)? The withdrawal-amount rule is strict only then. Absent: not exact. */
    exactness?(): { exact: boolean; why: string };
    /** Governance state for the GOV / GOVCERT / DELEG / POOL checks; absent: the node's store (govLedgerView.ts). */
    govLedgerView?(): Promise<GovLedgerView | undefined>;
}

/** Where the shared-memory copy lives (the outbound tx-submission clients read it). */
export interface MempoolStore {
    append(hash: Uint8Array, tx: Uint8Array): Promise<unknown>;
    drop(hashes: Uint8Array[]): Promise<void>;
}

export type AddTxResult =
    | { ok: true; txId: string; ms: number }
    | { ok: false; txId: string | null; failures: CborObj[]; reasons: string[]; ms: number };

interface Entry {
    tx: MempoolTx;
    ticket: number;
    wits: WitnessVerdict;
    /** Mempool byte measure: `sizeTxF` + 4 (ouroboros-consensus `txInBlockSize` per-tx overhead). */
    bytes: number;
    mem: bigint;
    steps: bigint;
    refBytes: number;
    phase2: MempoolPlutusResult["verdict"] | "none";
    addedAt: number;
}

export interface MempoolMeasures {
    txCount: number;
    bytes: { size: number; capacity: number };
    exUnitsMemory: { size: bigint; capacity: bigint };
    exUnitsSteps: { size: bigint; capacity: bigint };
    referenceScriptsBytes: { size: number; capacity: number };
}

export interface MempoolSnapshot {
    /** Slot the snapshot validates at (cardano-node `snapshotSlotNo`: tip + 1). */
    slot: bigint;
    txs: Array<{ txId: string; txIdBytes: Uint8Array; bytes: Uint8Array; measureBytes: number; ticket: number }>;
    measures: MempoolMeasures;
    /** Changes whenever the transaction list or the slot changes (LocalTxMonitor MsgAwaitAcquire). */
    version: number;
}

const PER_TX_OVERHEAD = 4;
const BLOCK_BODY_OVERHEAD = 1024;

export interface ValidatingMempoolOptions {
    view: MempoolLedgerView;
    store?: MempoolStore | null;
    pool?: ValidationPool | null;
    /**
     * Reject a transaction whose scripts phase 2 judges failing (ValidationTagMismatch /
     * CollectErrors), as cardano-node does. Default on (`initMempool`): the replay of preview's
     * valid script transactions shows 0 disagreements (`scripts/mempool-replay.ts --plutus`,
     * 1 137 transactions, 2026-09-29). Off admits and counts the disagreement, and never forges it.
     */
    rejectFailedPlutus?: boolean;
    /** Reject (true) or admit-and-count (false) when phase 2 cannot evaluate a script. */
    rejectUncheckedPlutus?: boolean;
    /** Revalidation yields to the event loop after this many ms of work. */
    sliceMs?: number;
    now?: () => number;
}

/** A mutex over async sections (admission and revalidation never interleave). */
class Lock {
    private tail: Promise<void> = Promise.resolve();
    run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.tail.then(fn, fn);
        this.tail = next.then(() => undefined, () => undefined);
        return next;
    }
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export class ValidatingMempool {
    private entries: Entry[] = [];
    private byId = new Map<string, Entry>();
    private nextTicket = 1;
    private readonly lock = new Lock();
    private tipKey = "";
    private tipSlot: bigint | null = null;
    private lastState: MempoolLedgerState | null = null;
    private version = 1;
    private readonly waiters = new Set<() => void>();
    private syncTimer: ReturnType<typeof setTimeout> | null = null;
    private syncing: Promise<void> | null = null;
    readonly stats = {
        accepted: 0, rejected: 0, droppedOnSync: 0, syncs: 0,
        phase2Passed: 0, phase2Failed: 0, phase2Unchecked: 0,
        /** Structured rule failures the block rules did not flag / block-rule failures only carried as text. */
        structuredOnly: 0, unmodelled: 0,
        rejectReasons: {} as Record<string, number>,
        admitMs: { count: 0, total: 0, max: 0, last: 0 },
        syncMs: { count: 0, total: 0, max: 0, last: 0 },
    };

    constructor(private readonly opts: ValidatingMempoolOptions) {}

    get size(): number { return this.entries.length; }
    has(txId: string): boolean { return this.byId.has(txId.toLowerCase()); }
    getTx(txId: string): Uint8Array | null { return this.byId.get(txId.toLowerCase())?.tx.bytes ?? null; }
    /** Transaction ids in mempool order. */
    ids(): string[] { return this.entries.map((e) => e.tx.txId); }

    private capacity(state: MempoolLedgerState | null): { bytes: number; mem: bigint; steps: bigint; refBytes: number } {
        const raw = state?.params.raw ?? {};
        const maxBody = Number(state?.params.maxBlockSize ?? raw.max_block_size ?? 90112);
        const mem = BigInt(String(raw.max_block_ex_mem ?? 62_000_000));
        const steps = BigInt(String(raw.max_block_ex_steps ?? 20_000_000_000));
        // cardano-node: 2 × the block capacity (no override configured)
        return { bytes: 2 * (maxBody - BLOCK_BODY_OVERHEAD), mem: 2n * mem, steps: 2n * steps, refBytes: 2 * MAX_REF_SCRIPT_SIZE_PER_BLOCK };
    }

    measures(): MempoolMeasures {
        const cap = this.capacity(this.lastState);
        let bytes = 0, mem = 0n, steps = 0n, ref = 0;
        for (const e of this.entries) { bytes += e.bytes; mem += e.mem; steps += e.steps; ref += e.refBytes; }
        return { txCount: this.entries.length, bytes: { size: bytes, capacity: cap.bytes }, exUnitsMemory: { size: mem, capacity: cap.mem }, exUnitsSteps: { size: steps, capacity: cap.steps }, referenceScriptsBytes: { size: ref, capacity: cap.refBytes } };
    }

    /** The current snapshot (LocalTxMonitor MsgAcquire). */
    async snapshot(): Promise<MempoolSnapshot> {
        if (this.tipSlot == null) { const t = await this.opts.view.tip().catch(() => null); if (t) this.tipSlot = t.slot; }
        return {
            slot: (this.tipSlot ?? -1n) + 1n,
            txs: this.entries.map((e) => ({ txId: e.tx.txId, txIdBytes: e.tx.txIdBytes, bytes: e.tx.bytes, measureBytes: e.bytes, ticket: e.ticket })),
            measures: this.measures(),
            version: this.version,
        };
    }

    /** Resolves once the snapshot differs from `version` (LocalTxMonitor MsgAwaitAcquire). */
    waitForChange(version: number, signal?: { cancelled: boolean }): Promise<void> {
        if (this.version !== version) return Promise.resolve();
        return new Promise((resolve) => {
            const w = () => { if (this.version !== version || signal?.cancelled) { this.waiters.delete(w); resolve(); } };
            this.waiters.add(w);
        });
    }

    private bump(): void {
        this.version++;
        for (const w of [...this.waiters]) w();
    }

    // ───────────────────────── admission ─────────────────────────

    /** Validate and admit one transaction (bytes as submitted). */
    addTx(bytes: Uint8Array, source = "local"): Promise<AddTxResult> {
        return this.lock.run(() => this.addLocked(bytes, source));
    }

    private reject(txId: string | null, failures: CborObj[], reasons: string[], t0: number, source: string): AddTxResult {
        this.stats.rejected++;
        const key = (reasons[0] ?? "unknown").replace(/[0-9a-f]{12,}…?/g, "X").replace(/\d+/g, "N").slice(0, 60);
        this.stats.rejectReasons[key] = (this.stats.rejectReasons[key] ?? 0) + 1;
        const ms = performance.now() - t0;
        log.info(`reject ${txId?.slice(0, 16) ?? "?"} (${source}, ${ms.toFixed(1)} ms): ${reasons.slice(0, 3).join("; ")}`);
        return { ok: false, txId, failures, reasons, ms };
    }

    private async addLocked(bytes: Uint8Array, source: string): Promise<AddTxResult> {
        // Let the event loop run between admissions: a burst of submissions must not queue up as
        // one long run of microtasks in front of the sync loop's I/O.
        await yieldNow();
        const t0 = performance.now();
        let tx: MempoolTx;
        try { tx = parseMempoolTx(bytes); }
        catch (err) { return this.reject(null, [LedgerF.mempoolFailure(`transaction does not decode: ${err instanceof Error ? err.message : String(err)}`)], ["undecodable"], t0, source); }
        await this.ensureSynced();
        const tip = await this.opts.view.tip();
        if (!tip) return this.reject(tx.txId, [LedgerF.mempoolFailure("node has no ledger tip yet")], ["no tip"], t0, source);
        const slot = tip.slot + 1n;
        const state = await this.opts.view.state(slot);
        if (!state) return this.reject(tx.txId, [LedgerF.mempoolFailure("protocol parameters for the current epoch are not available")], ["no parameters"], t0, source);
        this.lastState = state;
        const overlay = this.overlay();
        const look = await this.lookups(tx, overlay, this.entries);
        const wits = await this.verifyWitnesses(tx);
        const r = evaluateMempoolPhase1(tx, state, look, wits);
        this.stats.structuredOnly += r.structuredOnly;
        if (r.unmodelled.length) this.stats.unmodelled++;
        if (r.failures.length) return this.reject(tx.txId, r.failures, r.reasons, t0, source);
        // Conway GOV / GOVCERT (consensus/governance/govValidate.ts), with the queued transactions ahead
        // of this one as the block prefix, so a DRep registered earlier in the mempool is known here.
        if (bodyHasGovernance(tx.bodyBytes)) {
            const queued = this.entries.filter((e) => bodyHasGovernance(e.tx.bodyBytes)).map((e) => ({ bytes: e.tx.bodyBytes, txId: e.tx.txId }));
            const me = queued.length;
            try {
                const gov = await checkBlockGovernance({ slot: Number(slot), epoch: state.params.epoch, bodies: [...queued, { bytes: tx.bodyBytes, txId: tx.txId }], invalid: new Set(), raw: state.params.raw, networkId: state.network === "mainnet" ? 1 : 0, view: await this.opts.view.govLedgerView?.() });
                const mine = gov.failures.filter((f) => f.startsWith(`tx[${me}]`));
                if (mine.length && govRulesMode() === "strict") return this.reject(tx.txId, mine.map((f) => LedgerF.mempoolFailure(f)), mine, t0, source);
            } catch (err) { log.warn(`governance rules not evaluated for ${tx.txId.slice(0, 16)}: ${err instanceof Error ? err.message : String(err)}`); }
        }

        let phase2: Entry["phase2"] = "none";
        if (r.runsPlutus) {
            const res = await this.runPlutus(tx, look.resolved, state);
            phase2 = res.verdict;
            if (res.verdict === "failed") this.stats.phase2Failed++;
            if ((res.verdict === "failed" && this.opts.rejectFailedPlutus) || (res.verdict === "unchecked" && this.opts.rejectUncheckedPlutus)) {
                // Scripts only run when nothing else failed: the failure stands alone, UTXOW ▸ UTXO ▸ UTXOS.
                // (CollectErrors carries per-redeemer CollectError values the ledger builds from its own
                // decoding; not reproduced — carried as a MEMPOOL text.)
                const run = new RuleRun();
                if (res.kind === "CollectErrors") run.fail(LedgerF.mempoolFailure(`CollectErrors: ${res.detail ?? "no script context"}`));
                else run.fail(LedgerF.utxow(UtxowF.utxo(UtxoF.utxos(UtxosF.validationTagMismatch(tx.isValid, [{ message: res.detail ?? "script failure", context: new Uint8Array(0) }])))));
                return this.reject(tx.txId, [...run.failures], [`plutus: ${res.detail ?? "script failure"}`], t0, source);
            }
            if (res.verdict === "passed") this.stats.phase2Passed++;
            else if (res.verdict === "unchecked") this.stats.phase2Unchecked++;
            else log.warn(`phase 2 judges ${tx.txId.slice(0, 16)} failing (${res.detail}); admitted (rejectFailedPlutus off), never forged`);
        }

        const { mem, steps } = totalExUnits(tx);
        const entry: Entry = { tx, ticket: this.nextTicket++, wits, bytes: tx.size + PER_TX_OVERHEAD, mem, steps, refBytes: txRefScriptBytes(tx, look.resolved), phase2, addedAt: Date.now() };
        const m = this.measures(), cap = this.capacity(state);
        if (m.bytes.size + entry.bytes > cap.bytes || m.exUnitsMemory.size + mem > cap.mem || m.exUnitsSteps.size + steps > cap.steps || m.referenceScriptsBytes.size + entry.refBytes > cap.refBytes) {
            return this.reject(tx.txId, [LedgerF.mempoolFailure("mempool is full")], ["mempool full"], t0, source);
        }
        this.entries.push(entry);
        this.byId.set(tx.txId, entry);
        this.tipSlot = tip.slot;
        this.tipKey = `${tip.slot}:${tip.hash}`;
        try { await this.opts.store?.append(tx.txIdBytes, tx.bytes); } catch (err) { log.warn(`shared mempool append failed: ${err instanceof Error ? err.message : String(err)}`); }
        this.bump();
        this.stats.accepted++;
        const ms = performance.now() - t0;
        const a = this.stats.admitMs; a.count++; a.total += ms; a.last = ms; if (ms > a.max) a.max = ms;
        log.info(`accept ${tx.txId.slice(0, 16)} (${source}, ${tx.wireSize} B, ${ms.toFixed(1)} ms${phase2 !== "none" ? `, plutus ${phase2}` : ""}); ${this.entries.length} in mempool`);
        return { ok: true, txId: tx.txId, ms };
    }

    /** Outputs created and inputs spent by the mempool's transactions, in order (kept incrementally; rebuilt when the list changes otherwise). */
    private overlayCache: { spent: Set<string>; created: Map<string, ResolvedUtxo>; count: number; first: Entry | undefined } | null = null;
    private overlay(): { spent: Set<string>; created: Map<string, ResolvedUtxo> } {
        const c = this.overlayCache;
        if (c && c.first === this.entries[0] && c.count <= this.entries.length) {
            for (let i = c.count; i < this.entries.length; i++) this.applyToOverlay(this.entries[i]!.tx, c.spent, c.created);
            c.count = this.entries.length;
            return c;
        }
        const spent = new Set<string>(), created = new Map<string, ResolvedUtxo>();
        for (const e of this.entries) this.applyToOverlay(e.tx, spent, created);
        this.overlayCache = { spent, created, count: this.entries.length, first: this.entries[0] };
        return this.overlayCache;
    }

    private applyToOverlay(tx: MempoolTx, spent: Set<string>, created: Map<string, ResolvedUtxo>): void {
        for (const r of tx.inputs) { spent.add(r); created.delete(r); }
        const outs = ((tx.body.outputs ?? []) as any[]).map(outputLike);
        advanceResolved(created, tx.txId, [], outs);
    }

    private async lookups(tx: MempoolTx, overlay: { spent: Set<string>; created: Map<string, ResolvedUtxo> }, before: readonly Entry[]): Promise<MempoolLookups> {
        const refs = [...new Set([...tx.inputs, ...tx.collateral, ...tx.refInputs])];
        const fromLedger = await this.opts.view.resolve(refs.filter((r) => !overlay.created.has(r)));
        const resolved = new Map<string, ResolvedUtxo>();
        for (const r of refs) {
            if (overlay.spent.has(r)) continue;
            const u = overlay.created.get(r) ?? fromLedger.get(r);
            if (u) resolved.set(r, u);
        }
        const body = tx.body;
        const poolIds = ((body.certs ?? []) as any[]).filter((c) => Number(c.certType) === 3).map((c) => String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase());
        // typed keys ("01" + hash for a script account), as the block rules read them (bug 404: the bare
        // hash read a script account's balance from the key account of the same hash)
        const wdCreds = ((body.withdrawals?.map ?? []) as any[]).map((w) => rewardAccountKey(w.rewardAccount)).filter(Boolean);
        const certs: CertView[] = ((body.certs ?? []) as any[]).map((c) => ({
            certType: Number(c.certType),
            credHex: c.stakeCredential ? String(c.stakeCredential.hash?.toString?.() ?? "").toLowerCase() || null : null,
            credType: c.stakeCredential ? (Number(c.stakeCredential.type) === 1 || c.stakeCredential.type === "script" ? 1 : 0) : null,
            poolHex: c.poolKeyHash ? String(c.poolKeyHash.toString()).toLowerCase() : null,
        }));
        const stakeCreds = new Map<string, { hex: string; type: number }>();
        for (const c of stakeCredentialsTouched(certs)) stakeCreds.set(credKey(c.type, c.hex), c);
        for (const w of tx.withdrawals) stakeCreds.set(credKey(w.credType, w.credHex), { hex: w.credHex, type: w.credType });
        const [pools, rewardBalances, stake] = await Promise.all([
            this.opts.view.pools(poolIds),
            this.opts.view.rewardBalances(wdCreds),
            stakeCreds.size ? this.opts.view.stake([...stakeCreds.values()]) : Promise.resolve(null),
        ]);
        // earlier mempool transactions' certificates change the registration state too
        if (stake) for (const e of before) applyCertsToStake(e.tx, stake);
        // ... and their withdrawals drain the accounts (a later transaction must withdraw 0), as the
        // block rules carry it from one transaction to the next (blockRulesPure `applyOverlay`)
        const balances = rewardBalances ? new Map(rewardBalances) : undefined;
        if (balances) for (const e of before) for (const w of (e.tx.body.withdrawals?.map ?? []) as any[]) { const k = rewardAccountKey(w.rewardAccount); if (balances.has(k)) balances.set(k, 0n); }
        return { resolved, pools, rewardBalances: balances, stake, exactness: this.opts.view.exactness?.() };
    }

    private async verifyWitnesses(tx: MempoolTx): Promise<WitnessVerdict> {
        const c = collectShelleyWitnesses(tx.txIdBytes, tx.witnessSet);
        const ok = c.items.length === 0 ? [] : this.opts.pool ? (await this.opts.pool.verifyWitnesses({ kind: "witnesses", items: c.items })).ok : runWitnessVerifyJob({ kind: "witnesses", items: c.items }).ok;
        const v: WitnessVerdict = { provenKeys: new Set(), provenRoots: new Set(), allKeyHashes: new Set(), invalidVkeys: [] };
        const invalid: Array<{ hash: string; vkey: Uint8Array }> = [];
        c.proves.forEach((p, i) => {
            v.allKeyHashes.add(p.hash);
            if (ok[i]) (p.kind === "key" ? v.provenKeys : v.provenRoots).add(p.hash);
            else if (p.kind === "key") invalid.push({ hash: p.hash, vkey: c.items[i]!.publicKey });
        });
        invalid.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
        v.invalidVkeys = invalid.map((x) => x.vkey);
        return v;
    }

    private async runPlutus(tx: MempoolTx, resolved: Map<string, ResolvedUtxo>, state: MempoolLedgerState): Promise<MempoolPlutusResult> {
        const job: MempoolPlutusJob = {
            kind: "mempoolPlutus", tx: tx.bytes, bodyBytes: tx.bodyBytes, witnessSetBytes: tx.witnessSetBytes, markedInvalid: !tx.isValid,
            resolved, params: state.params, genesis: state.genesis, network: state.network, epochNetwork: this.opts.view.epochNetwork(),
        };
        try { return this.opts.pool ? await this.opts.pool.evaluateMempoolPlutus(job) : await runMempoolPlutusJob(job); }
        catch (err) { return { verdict: "unchecked", detail: err instanceof Error ? err.message : String(err), evaluated: 0, ms: 0 }; }
    }

    // ───────────────────────── revalidation ─────────────────────────

    /** The chain moved (block adopted or rolled back): re-apply the mempool soon (coalesced). */
    noteTipChanged(): void {
        if (this.syncTimer) return;
        this.syncTimer = setTimeout(() => { this.syncTimer = null; void this.sync().catch((err) => log.warn(`mempool sync failed: ${err instanceof Error ? err.message : String(err)}`)); }, 50);
    }

    /** Re-apply now if the tip moved since the last pass. */
    private async ensureSynced(): Promise<void> {
        if (!this.entries.length) return;
        const tip = await this.opts.view.tip().catch(() => null);
        if (tip && `${tip.slot}:${tip.hash}` !== this.tipKey) await this.syncLocked(tip);
    }

    sync(): Promise<void> {
        return this.lock.run(async () => {
            const tip = await this.opts.view.tip().catch(() => null);
            if (!tip) return;
            if (`${tip.slot}:${tip.hash}` === this.tipKey) return;
            if (!this.entries.length) { this.tipKey = `${tip.slot}:${tip.hash}`; this.tipSlot = tip.slot; this.bump(); return; }
            await this.syncLocked(tip);
        });
    }

    /**
     * Re-apply every transaction in order against the ledger at `tip` (+1 slot), reusing the
     * signature and script verdicts; keep those that still apply.
     */
    private async syncLocked(tip: { slot: bigint; hash: string }): Promise<void> {
        const t0 = performance.now();
        const kept = await this.revalidate(tip.slot + 1n, this.entries);
        const dropped = this.entries.filter((e) => !kept.includes(e));
        this.entries = kept;
        this.overlayCache = null;
        this.byId = new Map(kept.map((e) => [e.tx.txId, e]));
        this.tipKey = `${tip.slot}:${tip.hash}`;
        this.tipSlot = tip.slot;
        if (dropped.length) {
            this.stats.droppedOnSync += dropped.length;
            try { await this.opts.store?.drop(dropped.map((e) => e.tx.txIdBytes)); } catch { /* */ }
        }
        this.bump();
        const ms = performance.now() - t0;
        const s = this.stats.syncMs; s.count++; s.total += ms; s.last = ms; if (ms > s.max) s.max = ms;
        this.stats.syncs++;
        if (dropped.length) log.info(`sync at slot ${tip.slot}: dropped ${dropped.length} (${dropped.slice(0, 3).map((e) => e.tx.txId.slice(0, 12)).join(", ")}…), kept ${kept.length}, ${ms.toFixed(1)} ms`);
    }

    /** The prefix-closed subset of `list` that applies at `slot`, in order (phase 1 with cached witness/script verdicts). */
    private async revalidate(slot: bigint, list: Entry[]): Promise<Entry[]> {
        const state = await this.opts.view.state(slot);
        if (!state) return list; // no parameters: keep everything rather than guess
        this.lastState = state;
        const kept: Entry[] = [];
        const spent = new Set<string>(), created = new Map<string, ResolvedUtxo>();
        let sliceStart = performance.now();
        const sliceMs = this.opts.sliceMs ?? 4;
        for (const e of list) {
            const look = await this.lookups(e.tx, { spent, created }, kept);
            const r = evaluateMempoolPhase1(e.tx, state, look, e.wits);
            if (!r.failures.length) {
                kept.push(e);
                this.applyToOverlay(e.tx, spent, created);
            }
            if (performance.now() - sliceStart > sliceMs) { await yieldNow(); sliceStart = performance.now(); }
        }
        return kept;
    }

    /**
     * Transactions for a block forged at `slot`: the mempool re-applied at that slot, then the
     * longest prefix within the block's capacity (body bytes, execution units, reference-script
     * bytes). cardano-node `getSnapshotFor` + the forging loop. Transactions phase 2 judged
     * failing or could not judge are left out, with everything that spends their outputs.
     */
    snapshotForBlock(slot: bigint): Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>> {
        return this.lock.run(async () => {
            const tip = await this.opts.view.tip().catch(() => null);
            if (tip && `${tip.slot}:${tip.hash}` !== this.tipKey && this.entries.length) await this.syncLocked(tip);
            const valid = await this.revalidate(slot, this.entries);
            const state = this.lastState;
            const raw = state?.params.raw ?? {};
            const maxBytes = Number(state?.params.maxBlockSize ?? raw.max_block_size ?? 90112) - BLOCK_BODY_OVERHEAD;
            const maxMem = BigInt(String(raw.max_block_ex_mem ?? 62_000_000)), maxSteps = BigInt(String(raw.max_block_ex_steps ?? 20_000_000_000));
            const out: Array<{ hash: Uint8Array; bytes: Uint8Array }> = [];
            let bytes = 0, mem = 0n, steps = 0n, ref = 0;
            const skipped = new Set<string>();
            for (const e of valid) {
                // A transaction phase 2 judged failing (report-only mode) or could not judge is never
                // forged, nor is what spends its outputs: leaving a valid transaction to another pool
                // costs a fee, forging a failing one costs the block.
                if (e.phase2 === "failed" || e.phase2 === "unchecked" || [...e.tx.inputs, ...e.tx.refInputs].some((r) => skipped.has(r.slice(0, r.lastIndexOf(":"))))) { skipped.add(e.tx.txId); continue; }
                if (bytes + e.bytes > maxBytes || mem + e.mem > maxMem || steps + e.steps > maxSteps || ref + e.refBytes > MAX_REF_SCRIPT_SIZE_PER_BLOCK) break;
                bytes += e.bytes; mem += e.mem; steps += e.steps; ref += e.refBytes;
                out.push({ hash: e.tx.txIdBytes, bytes: e.tx.bytes });
            }
            return out;
        });
    }

    /** Remove transactions (the producer evicts the ones its own block rules rejected). */
    remove(txIds: Array<string | Uint8Array>): Promise<void> {
        return this.lock.run(async () => {
            const want = new Set(txIds.map((t) => (typeof t === "string" ? t : toHex(t)).toLowerCase()));
            const gone = this.entries.filter((e) => want.has(e.tx.txId));
            if (!gone.length) return;
            // a removed transaction's dependants cannot apply any more: re-apply the rest
            const rest = this.entries.filter((e) => !want.has(e.tx.txId));
            const tip = await this.opts.view.tip().catch(() => null);
            const kept = tip ? await this.revalidate(tip.slot + 1n, rest) : rest;
            const dropped = [...gone, ...rest.filter((e) => !kept.includes(e))];
            this.entries = kept;
            this.overlayCache = null;
            this.byId = new Map(kept.map((e) => [e.tx.txId, e]));
            try { await this.opts.store?.drop(dropped.map((e) => e.tx.txIdBytes)); } catch { /* */ }
            this.bump();
        });
    }
}

/** Registration effects of a transaction's certificates on a (registered, delegated) state. */
function applyCertsToStake(tx: MempoolTx, stake: { registered: Set<string>; delegated: Map<string, string> }): void {
    for (const c of (tx.body.certs ?? []) as any[]) {
        const cred = c.stakeCredential;
        if (!cred) continue;
        const fx = certStakeEffect(Number(c.certType));
        const key = credKey(Number(cred.type) === 1 || cred.type === "script" ? 1 : 0, String(cred.hash?.toString?.() ?? ""));
        if (fx.registers) stake.registered.add(key);
        else if (fx.deregisters) { stake.registered.delete(key); stake.delegated.delete(key); }
        if (fx.delegatesToPool && c.poolKeyHash) stake.delegated.set(key, String(c.poolKeyHash.toString()).toLowerCase());
    }
}

/** Key hash of a vkey (hex). */
export function vkeyHash(vkey: Uint8Array): string {
    return toHex(blake2b_224(vkey));
}

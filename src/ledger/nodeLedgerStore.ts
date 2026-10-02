/**
 * The node's LMDB ledger store (docs/PLAN_LMDB_LEDGER.md §7): mode, open/seed, the block hooks the
 * orchestrator calls, the dual-run verifier, and the process-wide registry the `db.ts` helpers use.
 *
 * Modes (`ledgerStore` in config, `GEROLAMO_LEDGER_STORE` wins):
 *   sqlite  — today's path, LMDB untouched
 *   dual    — SQLite stays primary; every UTxO write also goes to the LMDB diffs, and after each
 *             block the touched references are compared between the two (any difference halts)
 *   lmdb    — the LMDB store answers UTxO reads; SQLite UTxO rows are still written in phase 1
 *             (the other ledger groups live there), removed in phase 4.
 *
 * Phase 1 scope: the UTxO group. Directory: `<dir of dbPath>/ledger`.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { epochForSlot } from "../utils/epochFromSlotCalculations";
import { sql } from "../sql";
import { logger } from "../utils/logger";
import type { LedgerDiff } from "./LedgerDiff";
import { LedgerStore } from "./LedgerStore";
import { GovReads, GovWrites } from "./govStore";
import { StakeReads, StakeWrites } from "./stakeStore";
import { verifyStakeDiff } from "./stakeVerify";
import { verifyGovDiff } from "./govVerify";
import { UtxoReads, UtxoWrites, type UtxoRecord } from "./utxoStore";

const log = logger.child("ledger");

export type LedgerStoreMode = "sqlite" | "dual" | "lmdb";

let mode: LedgerStoreMode = "sqlite";
let store: LedgerStore | null = null;
let writes: UtxoWrites | null = null;
let reads: UtxoReads | null = null;
let stake: StakeWrites | null = null;
let gov: GovWrites | null = null;
let touched: string[] = [];             // UTxO refs written/deleted in the current range (dual verify)
let rangeDiffs: LedgerDiff[] = [];      // diffs committed in the current range (dual verify of the other groups)
/** Bumped when the seed covers more groups; a store seeded by an older version is rebuilt. */
const SEED_VERSION = 4;
const SEED_KEY = new TextEncoder().encode("seed_version");
let broken: string | null = null;         // set when the store can no longer be trusted (the sync halts)
let inBlock = false;
let storeDir: string | null = null;
/** Set when the store had to fall back to an older common block at startup; the block store follows it. */
let startupTipOverride: { slot: number; hash: Uint8Array } | null = null;
export function ledgerStartupTipOverride(): { slot: number; hash: Uint8Array } | null { return startupTipOverride; }
const dualTotals = { checked: 0, differences: 0, blocks: 0 };
let lastDualLog = 0;

export function configureLedgerStore(m: string | undefined): void {
    const env = process.env.GEROLAMO_LEDGER_STORE?.trim().toLowerCase();
    const v = env || m?.trim().toLowerCase();
    mode = v === "dual" || v === "lmdb" ? v : "sqlite";
}
export function ledgerStoreMode(): LedgerStoreMode { return mode; }
/**
 * Phase 4 cut-over switch: in `lmdb` mode the SQLite ledger tables stop being written when
 * `GEROLAMO_LEDGER_SQL_WRITES=0` (default: still written, so `ledgerStore` can be switched back).
 * Never off in `sqlite` or `dual` mode.
 */
export function sqlLedgerWrites(): boolean { return mode !== "lmdb" || process.env.GEROLAMO_LEDGER_SQL_WRITES !== "0"; }
export function ledgerStoreActive(): boolean { return mode !== "sqlite" && store !== null; }
/** The store when it answers reads (lmdb mode). */
export function primaryLedgerStore(): LedgerStore | null { return mode === "lmdb" ? store : null; }
export function ledgerUtxoReads(): UtxoReads | null { return mode === "lmdb" ? reads : null; }
/** Stake-group writes for the block being applied (null outside a block or in sqlite mode). */
export function ledgerStake(): StakeWrites | null { return mode !== "sqlite" && inBlock ? stake : null; }
/** Stake-group reads when the store answers them (lmdb mode). */
export function ledgerStakeReads(): StakeReads | null { return mode === "lmdb" && stake ? stake.reads : null; }
/** Governance / parameter / nonce writes for the block being applied (null outside a block or in sqlite mode). */
export function ledgerGov(): GovWrites | null { return mode !== "sqlite" && inBlock ? gov : null; }
export function ledgerGovReads(): GovReads | null { return mode === "lmdb" && gov ? gov.reads : null; }

/**
 * Where the store's reward balances, pots and stake snapshots came from (meta `ledger_source`):
 * "snapshot" — imported from a Mithril NewEpochState (importLmdb.ts), exact by construction and
 * answering GetFilteredDelegationsAndRewardAccounts / GetAccountState / GetPoolDistr2 byte-identically
 * with cardano-node; "sqlite" — seeded from the SQLite ledger, whose reward balances drift (bug 246,
 * the 2026-10-01 producer store). A store written before the marker counts as a snapshot import when
 * the pots' initialized epoch and the governance seed epoch are both the snapshot's epoch (what the
 * importer writes; a SQLite seed copies SQLite's: the Shelley and the Conway start on a node synced
 * from genesis). The balance-dependent rules (withdrawal amounts, `current_treasury_value`, the
 * zero-balance deregistration, the σ leader threshold) are strict only when this is exact (bugs 272–276).
 */
const SOURCE_KEY = new TextEncoder().encode("ledger_source");
export type LedgerSource = "snapshot" | "sqlite";
export async function markLedgerSource(st: LedgerStore, source: LedgerSource): Promise<void> {
    await st.env.write((t) => t.put("meta", SOURCE_KEY, new TextEncoder().encode(source)));
    if (exactMemo?.store === st) exactMemo = null;
}
let exactMemo: { store: LedgerStore; v: { exact: boolean; why: string } } | null = null;
/** Are the reward balances, pots and snapshots the rules read exact? `why` says why not (for the report lines). */
export function ledgerStateExact(): { exact: boolean; why: string } {
    if (mode !== "lmdb" || !store || !stake || !gov) return { exact: false, why: `ledger store mode ${mode}` };
    if (exactMemo?.store === store) return exactMemo.v;
    const raw = store.env.read((t) => t.get("meta", SOURCE_KEY));
    let source = raw ? new TextDecoder().decode(raw) : null;
    if (!source) {
        const p = stake.reads.pots(), g = gov.reads.state();
        source = p && g && p.initializedEpoch > 0 && p.initializedEpoch === g.seededEpoch ? "snapshot" : "unknown";
    }
    const v = source === "snapshot" ? { exact: true, why: "" } : { exact: false, why: source === "sqlite" ? "ledger store seeded from SQLite" : "ledger store not imported from a snapshot" };
    exactMemo = { store, v };
    return v;
}
/**
 * Nonces and epoch parameters are derived state: written from headers and at the boundary, and
 * recomputed by the evolver after a rollback. They always go straight to LMDB, never into a block's
 * diff — a diff that held one of these keys while a later direct write changed the stored value
 * would fail its before-image check at promotion (bug 126: the epoch 1423 nonce row blocked every
 * promotion for a day). `applyDirect` needs no open block; inside a block it writes beside the diff.
 */
export async function ledgerGovDirect(fn: (g: GovWrites) => void): Promise<void> {
    if (!store || !gov || mode === "sqlite") return;
    await store.applyDirectBeside(() => fn(gov!));
}
export function getLedgerStore(): LedgerStore | null { return store; }

export function resolveLedgerDir(config: { dbPath: string; ledgerDir?: string }): string | null {
    const fromEnv = process.env.GEROLAMO_LEDGER_DIR?.trim();
    if (fromEnv) return fromEnv;
    if (config.ledgerDir?.trim()) return config.ledgerDir.trim();
    if (!config.dbPath || config.dbPath === ":memory:") return null;
    return join(dirname(config.dbPath), "ledger");
}

/**
 * Open the store (creating it) and bring it to the selected tip:
 *   - empty environment: seed the UTxO set from SQLite at the tip (one-time);
 *   - anchor present and the persisted diffs connect it to the tip: ready (diffs above the tip on
 *     other branches are dropped);
 *   - anchor present but the tip is unreachable (crash between the block store's commit and the
 *     diff file, a torn diff, a persisted tip ahead of the diffs, or a different chain): in `dual`
 *     mode the environment is rebuilt from SQLite; in `lmdb` mode the node lands on the newest
 *     block of the block store's chain whose diffs reach the anchor (bugs 129, 245) and the block
 *     store's tip follows; only when no block of that chain does is it fatal — repair with the
 *     export tool.
 */
export async function openNodeLedgerStore(config: { dbPath: string; ledgerDir?: string; ledgerStore?: string }, selectedTip: { slot: number; hash: Uint8Array } | null, chainNewestFirst?: Array<{ slot: number; hash: Uint8Array }>): Promise<LedgerStore | null> {
    configureLedgerStore(config.ledgerStore);
    // scripts/ledger-sqlite-drop.ts empties the SQLite ledger tables of an lmdb node: from then on
    // SQLite cannot be the reference again (dual) or the ledger (sqlite).
    try {
        const dropped = (await sql`SELECT 1 FROM schema_migrations WHERE name = 'ledger_sqlite_dropped'`.values()) as unknown[][];
        if (dropped.length && (mode !== "lmdb" || process.env.GEROLAMO_LEDGER_SQL_WRITES !== "0")) throw new Error(`the SQLite ledger tables of ${config.dbPath} were emptied (ledger-sqlite-drop): this node must run ledgerStore "lmdb" with GEROLAMO_LEDGER_SQL_WRITES=0`);
    } catch (err) { if ((err as Error).message.includes("ledger-sqlite-drop")) throw err; }
    if (mode === "sqlite") return null;
    const dir = resolveLedgerDir(config);
    if (!dir) return null;
    const t0 = performance.now();
    storeDir = dir;
    const openAll = () => { store = LedgerStore.open(dir); writes = new UtxoWrites(store); reads = new UtxoReads(store); stake = new StakeWrites(store); gov = new GovWrites(store); return store; };
    openAll();
    if (store!.tornDiffs || store!.staleDiffs) log.warn(`ledger store ${dir}: unclean stop — ${store!.tornDiffs} incomplete diff file(s) and ${store!.staleDiffs} diff(s) of blocks at or below the anchor ignored and removed`);
    let anchor = store!.anchor();
    const seedVersion = store!.env.read((t) => { const v = t.get("meta", SEED_KEY); return v ? new DataView(v.buffer, v.byteOffset).getUint32(0, false) : 0; });
    let reason: string | null = null;
    if (anchor && seedVersion !== SEED_VERSION) reason = `seeded by version ${seedVersion}, this build needs ${SEED_VERSION}`;
    else if (anchor && selectedTip && !store!.chainReachesAnchor(selectedTip.hash)) reason = `anchor slot ${anchor.slot} with ${store!.loadedDiffs} persisted diff(s) does not reach the selected tip (slot ${selectedTip.slot}): ${store!.chainGap(selectedTip.hash)}`;
    if (reason && mode !== "dual" && selectedTip && chainNewestFirst?.length && seedVersion === SEED_VERSION) {
        // lmdb mode after a crash: the block store may hold blocks whose diffs never reached disk, a
        // diff may be torn, or the persisted tip may be ahead of the diffs. Land on the newest block
        // of the block store's chain whose diffs reach the anchor — not merely one the store has a
        // diff for (bug 245: that picked the tip itself, whose chain was broken further down, and
        // the first range halted the node). The caller moves the block store's tip there and the
        // network re-sends the rest (bug 129).
        const common = store!.recoveryTip(chainNewestFirst);
        if (common) {
            const dropped = store!.rollbackTo(common.hash);
            store!.selectTip(common.hash);
            startupTipOverride = common;
            log.warn(`ledger store ${dir}: ${reason}; recovered at the newest block both stores hold with a complete diff chain, ${Buffer.from(common.hash).toString("hex").slice(0, 16)}@${common.slot} (${selectedTip.slot - common.slot} slot(s) back, ${dropped} diff(s) dropped)`);
            log.info(`ledger store ${dir} (${mode}): anchor slot ${anchor!.slot}, ${store!.volatileCount()} volatile diff(s) to the selected tip, ${reads!.count()} UTxOs (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
            return store;
        }
        log.error(`ledger store ${dir}: none of the ${chainNewestFirst.length} block(s) of the block store's chain (slots ${chainNewestFirst[chainNewestFirst.length - 1]!.slot}..${chainNewestFirst[0]!.slot}) reaches the anchor (slot ${anchor!.slot}) through the ${store!.loadedDiffs} persisted diff(s)`);
    }
    if (reason) {
        const msg = `ledger store ${dir}: ${reason}`;
        if (mode !== "dual") throw new Error(`${msg}; rebuild it from a snapshot or with scripts/ledger-export.ts`);
        log.warn(`${msg}; rebuilding from SQLite`);
        store!.close();
        rmSync(dir, { recursive: true, force: true });
        openAll();
        anchor = null;
    }
    if (!anchor) {
        if (!selectedTip) { log.warn("ledger store: no anchor and no selected tip to seed at; store stays empty"); return store; }
        await seedAllFromSqlite(selectedTip, t0);
        await ledgerBoundaryPrune(Number(epochForSlot(selectedTip.slot)));
    } else {
        await ledgerBoundaryPrune(Number(epochForSlot(selectedTip?.slot ?? anchor.slot)));
        if (selectedTip) store!.rollbackTo(selectedTip.hash); // keep only the selected chain's diffs
        log.info(`ledger store ${dir} (${mode}): anchor slot ${anchor.slot}, ${store!.volatileCount()} volatile diff(s) to the selected tip, ${reads!.count()} UTxOs (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    }
    if (selectedTip) store!.selectTip(selectedTip.hash);
    return store;
}

/**
 * Tools beside a running node (forge dry run, probes): open its LMDB store read-only, load the
 * persisted diffs and pin the view to the block store's selected tip. Reads route through the store
 * when `GEROLAMO_LEDGER_STORE=lmdb` (or the config says so); nothing is ever written.
 */
export function attachReadOnlyLedgerStore(config: { dbPath: string; ledgerDir?: string; ledgerStore?: string; blockStoreDir?: string }): LedgerStore | null {
    configureLedgerStore(config.ledgerStore);
    if (mode === "sqlite") return null;
    const dir = resolveLedgerDir(config);
    if (!dir || !existsSync(join(dir, "data.mdb"))) { log.warn(`ledger store: ${dir ?? "?"} has no LMDB environment; reads stay on SQLite`); mode = "sqlite"; return null; }
    storeDir = dir;
    store = LedgerStore.open(dir, { readOnly: true });
    writes = null; reads = new UtxoReads(store); stake = new StakeWrites(store); gov = new GovWrites(store);
    const tipFile = join(config.blockStoreDir?.trim() || join(dirname(config.dbPath), "db"), "gerolamo", "selected-tip.hex");
    if (existsSync(tipFile)) { const h = readFileSync(tipFile, "utf8").trim(); if (/^[0-9a-f]{64}$/i.test(h)) store.selectTip(Uint8Array.from(Buffer.from(h, "hex"))); }
    const a = store.anchor();
    log.info(`ledger store ${dir} attached read-only (${mode}): anchor slot ${a?.slot ?? "-"}, ${store.volatileCount()} diff(s), tip reaches anchor: ${store.chainReachesAnchor(store.selectedTip())}`);
    return store;
}

/** Epochs of report history kept in the store (`GEROLAMO_LEDGER_KEEP_EPOCHS`, default 30: a month on preview, 150 days on mainnet). */
export function ledgerKeepEpochs(): number { const n = Number(process.env.GEROLAMO_LEDGER_KEEP_EPOCHS); return Number.isFinite(n) && n >= 4 ? Math.floor(n) : 30; }

/**
 * Drop report history older than the retention window: reward payouts, per-pool reward reports,
 * blocks made, per-pool snapshot stake and DRep stake snapshots below `currentEpoch − keep`.
 * Derived data the rules never read back, written straight to LMDB one epoch per transaction
 * (the producer's genesis-synced history held 8.5 M payout rows).
 */
export async function ledgerBoundaryPrune(currentEpoch: number): Promise<void> {
    if (!store || !stake || !gov || mode === "sqlite") return;
    const cutoff = currentEpoch - ledgerKeepEpochs();
    let deleted = 0, epochs = 0;
    const t0 = performance.now();
    for (const db of StakeWrites.PRUNED_DBS) {
        for (;;) {
            const oldest = stake.reads ? stake.oldestEpoch(db) : null;
            if (oldest === null || oldest >= cutoff) break;
            await store.applyDirectBeside(() => { deleted += stake!.pruneEpochBelow(db, oldest); });
            epochs++;
        }
    }
    for (;;) {
        const oldest = gov.oldestDRepStakeEpoch();
        if (oldest === null || oldest >= cutoff) break;
        await store.applyDirectBeside(() => { deleted += gov!.pruneDRepStakeEpoch(oldest); });
        epochs++;
    }
    if (deleted) log.info(`ledger store: pruned ${deleted} history key(s) below epoch ${cutoff} (${epochs} epoch slice(s), ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

/** Stamp a store as seeded by this build (the importer and the seed both call it). */
export async function markSeeded(st: LedgerStore): Promise<void> {
    await st.env.write((t) => { const v = new Uint8Array(4); new DataView(v.buffer).setUint32(0, SEED_VERSION, false); t.put("meta", SEED_KEY, v); });
}

/**
 * One-time background backfill (after an upgrade): raw pool parameters and the constitution anchor
 * for records made before they were captured, from a scan of the node's own chain. Pools: the
 * registration at the slot our record says took effect (or, for records without one — snapshot
 * imports — the last registration before the current epoch); the pending one likewise. Constitution:
 * the NewConstitution proposal whose anchor hash is the one in force. Yields to the event loop; the
 * writes check the store first and never overwrite. Marked done in meta.
 */
export async function ledgerBackfillRaw(blockStore: { chunks: { iterate(from: number, to?: number): AsyncGenerator<{ slot: number; bytes: Uint8Array }> }; volatileChain(tip: Uint8Array): Array<{ slot: number; bytes: Uint8Array }> }, tip: Uint8Array | null, epochStartSlot: number): Promise<void> {
    if (!store || !stake || !gov || mode === "sqlite") return;
    const DONE = new TextEncoder().encode("raw_backfill_v1");
    if (store.env.read((t) => t.get("meta", DONE))) return;
    const { scanBlock } = await import("./certScan");
    const { SDB, hexKey } = await import("./stakeStore");
    const t0 = performance.now();
    const regs = new Map<string, Array<{ slot: number; cbor: Uint8Array }>>();
    const cons = new Map<string, string>(); // anchor hash → url
    let blocks = 0;
    const take = (slot: number, bytes: Uint8Array) => {
        blocks++;
        try {
            const r = scanBlock(bytes);
            for (const p of r.pools) { const l = regs.get(p.poolId) ?? []; l.push({ slot, cbor: p.paramsCbor }); regs.set(p.poolId, l); }
            for (const c of r.constitutions) cons.set(c.hash, c.url);
        } catch { /* a block we cannot walk: skip */ }
    };
    for await (const b of blockStore.chunks.iterate(0)) { take(b.slot, b.bytes); if (blocks % 2000 === 0) await new Promise((r) => setImmediate(r)); }
    if (tip) for (const b of [...blockStore.volatileChain(tip)].reverse()) take(b.slot, b.bytes);
    const current: Array<[Uint8Array, Uint8Array]> = [], pending: Array<[Uint8Array, Uint8Array]> = [];
    const pendingPools = stake.reads.pendingPools();
    for (const [id, p] of stake.reads.pools()) {
        const l = regs.get(id);
        if (!l?.length) continue;
        const exact = l.find((x) => x.slot === p.registeredSlot);
        const before = [...l].reverse().find((x) => x.slot < epochStartSlot) ?? l[0]!;
        current.push([hexKey(id), (p.registeredSlot > 0 && exact ? exact : before).cbor]);
        const pp = pendingPools.get(id);
        if (pp) { const e = l.find((x) => x.slot === pp.registeredSlot) ?? l[l.length - 1]!; pending.push([hexKey(id), e.cbor]); }
    }
    const nc = store.fillAbsentSync(SDB.poolCbor, current), np = store.fillAbsentSync(SDB.poolCborPending, pending);
    let constitution = "none";
    const gs = gov.reads.state();
    if (gs?.constitutionHash && !gov.reads.constitutionAnchor()) {
        const url = cons.get(gs.constitutionHash.toLowerCase());
        if (url) { store.fillAbsentSync("gov_constitution_anchor", [[new TextEncoder().encode("current"), new TextEncoder().encode(JSON.stringify({ url, hash: gs.constitutionHash.toLowerCase() }))]]); constitution = url; }
    }
    store.env.writeSync((t) => t.put("meta", DONE, Uint8Array.of(1)));
    log.info(`ledger store: raw backfill scanned ${blocks} blocks in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${nc} pool parameter record(s), ${np} pending, constitution anchor ${constitution}`);
}

/** Stats-page / metrics summary. */
export function ledgerStoreSummary(): { mode: LedgerStoreMode; dir: string | null; anchorSlot: number | null; volatileBlocks: number; volatileBytes: number; utxoCount: number | null; dual: { checked: number; differences: number; blocks: number } } | null {
    if (mode === "sqlite" || !store) return null;
    const a = store.anchor();
    return { mode, dir: storeDir, anchorSlot: a?.slot ?? null, volatileBlocks: store.volatileCount(), volatileBytes: store.volatileBytes(), utxoCount: reads ? reads.count() : null, dual: { ...dualTotals } };
}

async function seedAllFromSqlite(tip: { slot: number; hash: Uint8Array }, t0 = performance.now()): Promise<void> {
    const n = await seedUtxoFromSqlite(store!, tip);
    const ns = await seedStakeFromSqlite(store!, stake!);
    const ng = await seedGovFromSqlite(store!, gov!);
    const { seedByronFromSqlite, BYRON_DB } = await import("./byronStore"); // Byron update / delegation state (a node switched mid-Byron)
    await store!.applyDirect(async () => { await seedByronFromSqlite((k, v) => store!.put(BYRON_DB, k, v)); });
    await store!.env.write((t) => { const v = new Uint8Array(4); new DataView(v.buffer).setUint32(0, SEED_VERSION, false); t.put("meta", SEED_KEY, v); });
    await markLedgerSource(store!, "sqlite"); // SQLite reward balances drift: the balance rules stay report-only on this store
    log.info(`ledger store ${storeDir}: seeded ${n} UTxO rows, ${ns} stake/pool/reward rows and ${ng} governance/parameter/nonce rows from SQLite at slot ${tip.slot} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

/**
 * Dual mode only: SQLite is the reference, so a store that became unusable (a rollback below its
 * seed point, a refused promotion, a lost chain) is thrown away and reseeded at SQLite's current
 * tip. Called between ranges, after the SQLite transaction committed.
 */
async function rebuildFromSqlite(reason: string): Promise<void> {
    if (!store || !storeDir) return;
    const { getChainTip } = await import("../db");
    const tip = await getChainTip();
    if (!tip) { log.error(`ledger store: cannot rebuild (${reason}): no SQLite tip`); return; }
    log.warn(`ledger store: ${reason}; rebuilding from SQLite at slot ${tip.slot}`);
    const t0 = performance.now();
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
    store = LedgerStore.open(storeDir); writes = new UtxoWrites(store); reads = new UtxoReads(store); stake = new StakeWrites(store); gov = new GovWrites(store);
    const at = { slot: Number(tip.slot), hash: Uint8Array.from(Buffer.from(tip.hashHex, "hex")) };
    await seedAllFromSqlite(at, t0);
    await ledgerBoundaryPrune(Number(epochForSlot(at.slot)));
    store.selectTip(at.hash);
    broken = null; touched = []; rangeDiffs = []; inBlock = false;
}

/** Copy the SQLite `utxo` table into LMDB as the immutable state at `tip` (one-time seed). */
export async function seedUtxoFromSqlite(st: LedgerStore, tip: { slot: number; hash: Uint8Array }): Promise<number> {
    let n = 0;
    let after = "";
    const w = new UtxoWrites(st);
    for (;;) {
        const rows = (await sql`SELECT utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key FROM utxo WHERE utxo_ref > ${after} ORDER BY utxo_ref LIMIT 20000`.values()) as unknown[][];
        if (!rows.length) break;
        await st.applyDirect(() => {
            for (const r of rows) {
                w.put({ utxo_ref: String(r[0]), tx_out: String(r[1]), tx_hash: r[2] == null ? null : String(r[2]), address: r[3] == null ? null : String(r[3]), lovelace: r[4] == null ? null : String(r[4]), reference_script_hash: r[5] == null ? null : String(r[5]), stake_key: r[6] == null ? null : String(r[6]) });
                after = String(r[0]);
                n++;
            }
        });
        if (n % 200000 === 0) log.info(`ledger seed: ${n} UTxO rows`);
    }
    await st.setAnchor(tip);
    return n;
}

/** Copy the stake / pool / reward / pot / snapshot tables into LMDB (one-time seed). Returns rows copied. */
export async function seedStakeFromSqlite(st: LedgerStore, w: StakeWrites): Promise<number> {
    let n = 0;
    const typed = (hashHex: unknown, type: unknown) => `${Number(type) === 1 ? "01" : ""}${String(hashHex).toLowerCase()}`;
    const q = async (t: string, cols: string, order = ""): Promise<unknown[][]> => {
        const exists = (await sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${t}`.values()) as unknown[][];
        return exists.length ? ((await sql.unsafe(`SELECT ${cols} FROM ${t} ${order}`).values()) as unknown[][]) : [];
    };
    const apply = async (rows: unknown[][], fn: (r: unknown[]) => void) => { for (let i = 0; i < rows.length; i += 50000) { const chunk = rows.slice(i, i + 50000); await st.applyDirect(() => { for (const r of chunk) fn(r); }); } n += rows.length; };
    await apply(await q("stake", "hex(stake_credentials), cred_type"), (r) => w.registerStake(typed(r[0], r[1])));
    await apply(await q("delegations", "hex(stake_credentials), cred_type, hex(pool_key_hash)", "ORDER BY id"), (r) => w.delegate(typed(r[0], r[1]), String(r[2]).toLowerCase()));
    await apply(await q("stake_pointers", "slot, tx_ix, cert_ix, stake_key"), (r) => w.putPointer(Number(r[0]), Number(r[1]), Number(r[2]), String(r[3])));
    await apply(await q("rewards", "hex(stake_credentials), amount", "WHERE amount <> 0"), (r) => w.creditRewards(new Map([[String(r[0]).toLowerCase(), BigInt(String(r[1]))]])));
    await apply(await q("pool_params", "pool_id, vrf_key_hash, registered_slot, retiring_epoch, params_json"), (r) => w.putPool(String(r[0]), { vrf: String(r[1]), registeredSlot: Number(r[2]), retiringEpoch: r[3] == null ? null : Number(r[3]), params: r[4] == null ? null : JSON.parse(String(r[4])) }));
    await apply(await q("pool_params_pending", "pool_id, vrf_key_hash, registered_slot, params_json"), (r) => w.putPoolPending(String(r[0]), { vrf: String(r[1]), registeredSlot: Number(r[2]), params: r[3] == null ? null : JSON.parse(String(r[3])) }));
    await apply(await q("pool_relays", "pool_id, relays_json, updated_slot"), (r) => { try { w.recordPoolRelays(String(r[0]), JSON.parse(String(r[1])), Number(r[2])); } catch { /* bad row */ } });
    await apply(await q("opcert_counters", "pool_id, counter, slot"), (r) => w.putOpcert(String(r[0]), Number(r[1]), Number(r[2])));
    await apply(await q("blocks_made_by_epoch", "epoch, pool_id, blocks"), (r) => w.putBlocksMade(Number(r[0]), String(r[1]), Number(r[2])));
    await apply(await q("genesis_delegs", "genesis_key_hash, delegate_hash, vrf_key_hash, effective_slot"), (r) => w.recordGenesisDelegation(String(r[0]), String(r[1]), String(r[2]), Number(r[3])));
    await apply(await q("mir_pending", "recorded_epoch, source, stake_key, amount", "ORDER BY id"), (r) => w.queueMir(Number(r[0]), Number(r[1]), [{ stakeKey: r[2] == null ? null : String(r[2]), amount: BigInt(String(r[3])) }]));
    await apply(await q("reward_pots", "reserves, treasury, fee_pot, donation_pot, initialized_epoch", "WHERE id = 1"), (r) => w.putPots({ reserves: BigInt(String(r[0])), treasury: BigInt(String(r[1])), feePot: BigInt(String(r[2])), donationPot: BigInt(String(r[3] ?? 0)), initializedEpoch: Number(r[4]) }));
    await apply(await q("epoch_stake_totals", "taken_at, total_active, pools"), (r) => w.putSnapshotTotals(Number(r[0]), BigInt(String(r[1])), Number(r[2])));
    await apply(await q("epoch_pool_stake", "taken_at, pool_id, stake"), (r) => w.putSnapshotPool(Number(r[0]), String(r[1]), BigInt(String(r[2]))));
    await apply(await q("epoch_stake_cred", "taken_at, stake_key, pool_id, stake"), (r) => w.putSnapshotCred(Number(r[0]), String(r[1]), String(r[2]), BigInt(String(r[3]))));
    await apply(await q("epoch_pool_params", "taken_at, pool_id, vrf_key_hash, params_json"), (r) => w.putSnapshotPoolParams(Number(r[0]), String(r[1]), String(r[2]), r[3] == null ? null : JSON.parse(String(r[3]))));
    await apply(await q("pending_rewards", "pay_at, stake_key, amount"), (r) => w.queuePendingRewards(Number(r[0]), new Map([[String(r[1]), BigInt(String(r[2]))]])));
    await apply(await q("reward_epochs", "performance_epoch, reward_pot, treasury_delta, paid, unclaimed, pools, accounts"), (r) => w.recordRewardEpoch(Number(r[0]), { rewardPot: BigInt(String(r[1])), treasuryDelta: BigInt(String(r[2])), paid: BigInt(String(r[3])), unclaimed: BigInt(String(r[4])), pools: Number(r[5]), accounts: Number(r[6]) }));
    await apply(await q("reward_payouts", "performance_epoch, stake_key, amount"), (r) => w.recordRewardPayouts(Number(r[0]), new Map([[String(r[1]), BigInt(String(r[2]))]])));
    await apply(await q("reward_pool_epochs", "performance_epoch, pool_id, max_pool, pool_reward, operator, members, owner_stake, stake, blocks"), (r) => w.recordPoolRewards(Number(r[0]), [{ poolId: String(r[1]), maxPool: BigInt(String(r[2])), poolReward: BigInt(String(r[3])), operator: BigInt(String(r[4])), members: BigInt(String(r[5])), ownerStake: BigInt(String(r[6])), stake: BigInt(String(r[7])), blocks: BigInt(String(r[8])) }]));
    await apply(await q("pot_snapshots", "epoch, reserves, treasury, fees_collected"), (r) => w.recordPotSnapshot(Number(r[0]), { reserves: BigInt(String(r[1])), treasury: BigInt(String(r[2])), feesCollected: BigInt(String(r[3])) }));
    return n;
}

/** Copy the governance, parameter and nonce tables into LMDB (one-time seed). Returns rows copied. */
export async function seedGovFromSqlite(st: LedgerStore, w: GovWrites): Promise<number> {
    let n = 0;
    const q = async (t: string, cols: string, order = ""): Promise<unknown[][]> => {
        const exists = (await sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${t}`.values()) as unknown[][];
        if (!exists.length) return [];
        const have = new Set(((await sql.unsafe(`PRAGMA table_info(${t})`).values()) as unknown[][]).map((r) => String(r[1])));
        const selected = cols.split(",").map((c) => c.trim()).map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(", ");
        return (await sql.unsafe(`SELECT ${selected} FROM ${t} ${order}`).values()) as unknown[][];
    };
    const apply = async (rows: unknown[][], fn: (r: unknown[]) => void) => { for (let i = 0; i < rows.length; i += 50000) { const chunk = rows.slice(i, i + 50000); await st.applyDirect(() => { for (const r of chunk) fn(r); }); } n += rows.length; };
    const str = (v: unknown) => (v == null ? null : String(v));
    // Bug 246: a NULL expiry (rows from before bug 102) is the ledger's `last activity + drep_activity
    // in force then`, not a value to derive with today's parameter later.
    const { activityLookupSql, credSchemaOfMarkers, legacyDRepExpiry } = await import("../consensus/governance/govStoreSync");
    const activity = await activityLookupSql();
    await apply(await q("gov_dreps", "credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch"), (r) => w.putDRep(String(r[0]), { isScript: Number(r[1] ?? 0), deposit: String(r[2] ?? 0), registeredSlot: Number(r[3]), lastActiveEpoch: Number(r[4]), expiryEpoch: r[5] == null ? legacyDRepExpiry(Number(r[4]), activity) : Number(r[5]) }));
    await apply(await q("gov_drep_delegations", "stake_key, drep_type, drep_hash"), (r) => w.putDRepDelegation(String(r[0]), { type: Number(r[1]), hash: str(r[2]) }));
    await apply(await q("gov_committee", "cold_credential, expires_epoch, hot_credential, resigned"), (r) => w.putCommittee(String(r[0]), { expiresEpoch: Number(r[1]), hot: str(r[2]), resigned: Number(r[3] ?? 0) }));
    await apply(await q("gov_committee_auth", "cold_credential, hot_credential, resigned"), (r) => w.putCommitteeAuth(String(r[0]), { hot: str(r[1]), resigned: Number(r[2] ?? 0) }));
    // the migrations SQLite records are the LMDB `credSchema` level (bug 246: a rebuilt store re-ran them)
    const credSchema = credSchemaOfMarkers((await q("schema_migrations", "name")).map((r) => String(r[0])));
    await apply(await q("gov_state", "committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, prev_pparams, prev_hardfork, prev_committee, prev_constitution, seeded_epoch, dormant_epochs, pending", "WHERE id = 1"), (r) => w.putState({ thrNum: Number(r[0]), thrDen: Number(r[1]), constitutionHash: str(r[2]), constitutionScript: str(r[3]), noConfidence: Number(r[4] ?? 0), prevPP: str(r[5]), prevHF: str(r[6]), prevCC: str(r[7]), prevCons: str(r[8]), seededEpoch: Number(r[9]), dormantEpochs: Number(r[10] ?? 0), pending: str(r[11]), ...(credSchema ? { credSchema } : {}) }));
    await apply(await q("gov_drep_boot_delegs", "drep_key, stake_key"), (r) => w.addBootDelegator(String(r[0]), String(r[1])));
    // the pulser snapshot mirror (bug 167 / 246): the epoch's frozen proposals, votes, DRep distribution and states
    await apply(await q("gov_pulser_snapshot", "epoch, snapshot"), (r) => { try { w.putPulserSnapshot(JSON.parse(String(r[1]))); } catch { /* bad row */ } });
    await apply(await q("gov_proposals", "action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status, decided_epoch"), (r) => w.putProposal({ actionId: String(r[0]), seq: Number(r[1]), kind: String(r[2]), prevActionId: str(r[3]), deposit: String(r[4]), returnAccount: String(r[5]), payload: String(r[6]), proposedEpoch: Number(r[7]), expiresEpoch: Number(r[8]), status: String(r[9] ?? "active"), decidedEpoch: r[10] == null ? null : Number(r[10]) }));
    await apply(await q("gov_votes", "action_id, voter_kind, voter_hash, vote, slot"), (r) => w.putVote({ actionId: String(r[0]), voterKind: Number(r[1]), voterHash: String(r[2]), vote: Number(r[3]), slot: Number(r[4]) }));
    await apply(await q("gov_enacted", "epoch, action_id, kind, detail"), (r) => w.putEnacted(Number(r[0]), String(r[1]), String(r[2]), str(r[3])));
    await apply(await q("epoch_drep_stake", "taken_at, drep_type, drep_hash, stake"), (r) => w.putDRepStake(Number(r[0]), Number(r[1]), String(r[2] ?? ""), BigInt(String(r[3]))));
    await apply(await q("epoch_params", "epoch, params, source"), (r) => { try { w.putEpochParams(Number(r[0]), JSON.parse(String(r[1])), str(r[2])); } catch { /* bad row */ } });
    await apply(await q("pparam_proposals", "epoch, genesis_key, changes_json, slot"), (r) => w.putPParamProposal(Number(r[0]), String(r[1]), String(r[2]), Number(r[3])));
    await apply(await q("epoch_nonces", "epoch, nonce_hex, source, evolving_hex, candidate_hex, start_evolving_hex, start_candidate_hex, start_slot, start_lab_hex"), (r) => w.putNonce(Number(r[0]), { nonceHex: String(r[1]), source: String(r[2] ?? "external"), evolvingHex: str(r[3]), candidateHex: str(r[4]), startEvolvingHex: str(r[5]), startCandidateHex: str(r[6]), startSlot: r[7] == null ? null : Number(r[7]), startLabHex: str(r[8]) }));
    return n;
}

// ------------------------------------------------------------------ block hooks (orchestrator)

export function ledgerBeginBlock(hash: Uint8Array, prevHash: Uint8Array | null, slot: number): void {
    if (!store || mode === "sqlite") return;
    // The block must extend the store's own chain: its parent is the selected tip (or the anchor).
    // Anything else means the block store and the ledger store disagree about the chain (bug 128:
    // a range built on a block the ledger store had rolled back left dangling diffs behind).
    const tip = store.selectedTip();
    const tipHex = tip ? Buffer.from(tip).toString("hex") : null;
    const prevHex = prevHash ? Buffer.from(prevHash).toString("hex") : null;
    if (!broken && prevHex !== tipHex && !(tipHex === null && store.anchor() && prevHex === Buffer.from(store.anchor()!.hash).toString("hex"))) {
        // The block continues from a block this store holds a complete state for (the anchor, or a volatile
        // block whose diffs reach it): the node's chain forked below the store's tip without the store being
        // told. Roll the store back to that common block (within the volatile window, i.e. ≤ k) and go on,
        // as cardano-node's ChainSel does, instead of halting (bug 284). Unknown parents still break it.
        if (prevHash && store.knows(prevHash) && store.chainReachesAnchor(prevHash)) {
            const dropped = store.rollbackTo(prevHash);
            log.warn(`ledger store: block ${Buffer.from(hash).toString("hex").slice(0, 16)}@${slot} extends ${prevHex!.slice(0, 16)}, not the store's tip ${tipHex?.slice(0, 16) ?? "anchor"}: rolled the store back to ${prevHex!.slice(0, 16)} (${dropped} diff(s) dropped)${mode === "lmdb" && sqlLedgerWrites() ? "; the SQLite shadow tables keep the dropped block(s)' rows" : ""}`);
        } else {
            broken = `block ${Buffer.from(hash).toString("hex").slice(0, 16)}@${slot} extends ${prevHex?.slice(0, 16) ?? "genesis"} but the ledger store's tip is ${tipHex?.slice(0, 16) ?? "anchor"}`;
            log.error(`ledger store: ${broken}`);
        }
    }
    store.beginBlock(hash, prevHash, slot);
    inBlock = true;
}

/** Why the store stopped being usable (a refused rollback, a lost chain), or null. */
export function ledgerStoreBroken(): string | null { return broken; }

export function ledgerCommitBlock(): void {
    if (!store || mode === "sqlite" || !inBlock) return;
    rangeDiffs.push(store.commitBlock());
    inBlock = false;
}

/**
 * The range failed: forget exactly the diffs this range committed and put the tip back on the chain
 * the node keeps (`tipAfter` = the block store's selected tip once the orchestrator reset it; falls
 * back to the block before the range). A tip the store does not hold marks it broken.
 */
export function ledgerAbortRange(tipAfter?: Uint8Array | null): void {
    if (!store || mode === "sqlite") return;
    if (inBlock) { store.abortBlock(); inBlock = false; }
    if (rangeDiffs.length) {
        const dropped = store.dropDiffs(rangeDiffs.map((d) => d.hash));
        const prev = rangeDiffs[0]!.prevHash;
        const back = tipAfter !== undefined && store.knows(tipAfter) ? tipAfter : prev;
        if (store.knows(back)) {
            store.selectTip(back);
            log.info(`ledger store: range aborted, ${dropped} diff(s) dropped, tip ${back ? Buffer.from(back).toString("hex").slice(0, 16) : "anchor"}${tipAfter !== undefined && back !== tipAfter ? " (the block store's tip is not a block this store holds; using the block before the range)" : ""}`);
        } else if (!broken) {
            broken = `abort-range: the node's tip ${back ? Buffer.from(back).toString("hex").slice(0, 16) : "(none)"} is neither the anchor nor a volatile block (${store.volatileCount()} diffs)`;
            log.error(`ledger store: ${broken}`);
        }
    }
    touched = [];
    rangeDiffs = [];
}

/** After a committed range: check the chain invariant, promote k deep. */
export async function ledgerAfterRange(k: number): Promise<void> {
    if (!store || mode === "sqlite") return;
    // The range committed: its diffs are no longer "this range's" (bug 131: in lmdb mode only the dual
    // verifier cleared them, so a later aborted range dropped every diff since startup).
    rangeDiffs = [];
    touched = [];
    if (broken) return;
    const tip = store.selectedTip();
    if (!store.chainReachesAnchor(tip)) {
        broken = `the selected tip ${tip ? Buffer.from(tip).toString("hex").slice(0, 16) : "(none)"} does not reach the anchor through the ${store.volatileCount()} volatile diff(s)`;
        log.error(`ledger store: ${broken}`);
        return;
    }
    try {
        const r = await store.promoteDeep(k);
        if (r.promoted) log.debug(`ledger store: ${r.promoted} block diff(s) promoted; anchor slot ${r.anchor?.slot}`);
    } catch (err) {
        // A refused promotion leaves the anchor behind for good (the same diff is retried every range) —
        // the two layers disagree, so the store is unusable until it is rebuilt.
        broken = `promote failed: ${(err as Error).message}`;
        log.error(`ledger store ${broken}`);
    }
}

/**
 * A rollback of our chain to `slot` (the newest block at or below it stays). Slot-based, like the
 * SQLite rollback: the store finds the block on its own selected chain. `hash`, when known, is
 * checked against the block the store kept.
 */
export function ledgerRollbackTo(slot: number, hash?: Uint8Array | null): void {
    if (!store || mode === "sqlite") return;
    try {
        const r = store.rollbackToSlot(slot);
        store.selectTip(r.tip);
        const kept = r.tip ? Buffer.from(r.tip).toString("hex") : null;
        if (hash && kept && Buffer.from(hash).toString("hex") !== kept) { broken = `rollback to slot ${slot} kept ${kept.slice(0, 16)} but the chain's block there is ${Buffer.from(hash).toString("hex").slice(0, 16)}`; log.error(`ledger store: ${broken}`); return; }
        log.info(`ledger store: rolled back to slot ${slot} (${r.dropped} diff(s) dropped, ${store.volatileCount()} left, tip ${kept?.slice(0, 16) ?? "anchor"})`);
    } catch (err) {
        broken = `rollback to slot ${slot} failed: ${(err as Error).message}`;
        log.error(`ledger store: ${broken}`);
    }
}

export function ledgerSelectTip(hash: Uint8Array): void { store?.selectTip(hash); }

// ------------------------------------------------------------------ UTxO writes from db.ts

export function ledgerUtxoPut(r: UtxoRecord): void {
    if (!writes || mode === "sqlite" || !inBlock) return;
    writes.put(r);
    touched.push(r.utxo_ref);
}

/** Delete spent outputs from the store; returns the refs that existed (the store's own view). */
export function ledgerUtxoDel(refs: string[]): string[] {
    if (!writes || mode === "sqlite" || !inBlock) return [];
    const gone = writes.del(refs);
    for (const r of refs) touched.push(r);
    return gone.map((u) => u.utxo_ref);
}

// ------------------------------------------------------------------ dual-run verifier

export interface DualVerifyResult { checked: number; differences: string[] }

/** Compare the refs the last block touched between SQLite and LMDB (call after the SQLite commit). */
export async function ledgerDualVerify(): Promise<DualVerifyResult> {
    const out: DualVerifyResult = { checked: 0, differences: [] };
    if (broken && mode === "dual") { await rebuildFromSqlite(broken); return out; }
    if (broken) out.differences.push(`ledger store unusable: ${broken}`);
    if (!store || !reads || !stake || mode !== "dual") return out;
    const refs = [...new Set(touched)];
    touched = [];
    const diffs = rangeDiffs;
    rangeDiffs = [];
    if (refs.length === 0 && diffs.length === 0) return out;
    dualTotals.blocks += diffs.length;
    for (const d of diffs) {
        const r = await verifyStakeDiff(stake.reads, d);
        out.checked += r.checked;
        out.differences.push(...r.differences);
        if (gov) { const g = await verifyGovDiff(gov.reads, d); out.checked += g.checked; out.differences.push(...g.differences); }
    }
    for (let i = 0; i < refs.length; i += 500) {
        const chunk = refs.slice(i, i + 500);
        const rows = (await sql`SELECT utxo_ref, tx_out, lovelace, stake_key FROM utxo WHERE utxo_ref IN ${sql(chunk)}`.values()) as unknown[][];
        const inSqlite = new Map(rows.map((r) => [String(r[0]), { tx_out: String(r[1]), lovelace: r[2] == null ? null : String(r[2]), stake_key: r[3] == null ? null : String(r[3]) }]));
        for (const ref of chunk) {
            out.checked++;
            const a = inSqlite.get(ref), b = reads.get(ref);
            if (!a && !b) continue;
            if (!a || !b) { out.differences.push(`${ref}: ${a ? "in SQLite only" : "in LMDB only"}`); continue; }
            if (a.tx_out !== b.tx_out) out.differences.push(`${ref}: tx_out differs`);
            else if ((a.lovelace ?? null) !== (b.lovelace ?? null)) out.differences.push(`${ref}: lovelace ${a.lovelace} ≠ ${b.lovelace}`);
            else if ((a.stake_key ?? null) !== (b.stake_key ?? null)) out.differences.push(`${ref}: stake_key differs`);
        }
    }
    dualTotals.checked += out.checked;
    dualTotals.differences += out.differences.length;
    const now = Date.now();
    if (out.differences.length) log.error(`ledger dual-run: ${out.differences.length} difference(s) in ${out.checked} ref(s): ${out.differences.slice(0, 5).join("; ")}`);
    else if (now - lastDualLog > 600_000) { lastDualLog = now; log.info(`ledger dual-run: ${dualTotals.checked} UTxO ref(s) compared over ${dualTotals.blocks} block(s), ${dualTotals.differences} difference(s); anchor slot ${store.anchor()?.slot ?? "-"}, ${store.volatileCount()} volatile diff(s)`); }
    return out;
}

/** Whole-set comparison (counts and a sample) for the periodic check. */
export async function ledgerDualCount(): Promise<{ sqlite: number; lmdb: number }> {
    const rows = (await sql`SELECT COUNT(*) FROM utxo`.values()) as unknown[][];
    return { sqlite: Number(rows[0]?.[0] ?? 0), lmdb: reads ? reads.count() : 0 };
}

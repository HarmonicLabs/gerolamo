/**
 * The node's BlockStore instance (docs/PLAN_CHUNK_STORE.md phase 3, step "dual write").
 *
 * Layout: `<blockStoreDir>/{immutable,volatile,gerolamo}` where `blockStoreDir` is
 * `config.blockStoreDir`, else `<dir of dbPath>/db` — the same shape as a cardano-node
 * `--database-path`. `GEROLAMO_BLOCK_STORE=0` disables it. While the SQLite `blocks` table is
 * still the primary store, `catchUpFromSqlite` copies every applied block above the chunk
 * store's tip into the volatile set (so a crash between the SQLite commit and the mirror write,
 * or a store created on an existing node, leaves no gap) and `promote` moves blocks more than
 * k deep into the chunks.
 */
import { dirname, join } from "node:path";
import { ledgerStoreMode } from "../ledger/nodeLedgerStore";
import { sql } from "../sql";
import { logger } from "../utils/logger";
import { BlockStore } from "./blockStore";
import { ChunkRelayChainStore } from "../network/n2n/ChunkRelayChainStore";
import { chainConnects, persistSelectedTipTo, setSelectedTipHash } from "./blockReads";
import { existsSync } from "node:fs";
import type { RelayChainStore } from "../network/n2n/RelayChainStore";

const log = logger.child("blockstore");

export interface NodeBlockStoreConfig {
    dbPath: string;
    blockStoreDir?: string;
    /** "mirror" (default): SQLite `blocks` stays primary, the store is written beside it. "primary": the store answers every block read and `blocks` is no longer written. */
    blockStoreMode?: "mirror" | "primary";
}

let storeMode: "mirror" | "primary" = "primary";

export function configureBlockStoreMode(mode: string | undefined): void {
    const env = process.env.GEROLAMO_BLOCK_STORE_MODE?.trim().toLowerCase();
    const m = env || mode?.trim().toLowerCase();
    // Primary is the default (docs/PLAN_CHUNK_STORE.md, 2026-09-14); "mirror" keeps SQLite's blocks table primary for a legacy node.
    storeMode = m === "mirror" ? "mirror" : "primary";
}

export function blockStoreMode(): "mirror" | "primary" {
    return storeMode;
}

/** The store when it must answer block reads (primary mode and open); null otherwise. */
export function primaryBlockStore(): BlockStore | null {
    return storeMode === "primary" ? nodeStore : null;
}

export function resolveBlockStoreDir(config: NodeBlockStoreConfig): string | null {
    if (process.env.GEROLAMO_BLOCK_STORE === "0" || process.env.GEROLAMO_BLOCK_STORE === "false") return null;
    const fromEnv = process.env.GEROLAMO_BLOCK_STORE_DIR?.trim();
    if (fromEnv) return fromEnv;
    if (config.blockStoreDir?.trim()) return config.blockStoreDir.trim();
    if (!config.dbPath || config.dbPath === ":memory:") return null;
    return join(dirname(config.dbPath), "db");
}

/** Open (or create) the node's block store; null when disabled or unconfigured. */
export async function openNodeBlockStore(config: NodeBlockStoreConfig, k: number): Promise<BlockStore | null> {
    const dir = resolveBlockStoreDir(config);
    if (!dir) return null;
    const t0 = performance.now();
    const store = await BlockStore.open(dir, { k });
    const imm = await store.immutableTip();
    log.info(`Block store ${dir}: ${store.chunks.chunks().length} chunk(s), immutable tip ${imm ? `slot ${imm.slot}` : "none"}, ${store.volatile.size} volatile block(s) (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    return store;
}

/**
 * Mirror the SQLite `blocks` rows above the chunk store's tip into the volatile set, then
 * promote the selected chain (the highest valid SQLite block) down to k blocks. Returns counts.
 */
export async function catchUpFromSqlite(store: BlockStore, k: number): Promise<{ copied: number; promoted: number; tipSlot: number | null }> {
    const imm = await store.immutableTip();
    const from = imm ? imm.slot : -1;
    const rows = (await sql`SELECT slot, hash, block_data FROM blocks WHERE slot > ${from} AND is_valid = TRUE ORDER BY slot ASC`.values()) as unknown[][];
    let copied = 0;
    let tipHash: Uint8Array | null = null;
    let tipSlot: number | null = null;
    for (const r of rows) {
        const hash = hashBytes(r[1]);
        const bytes = r[2] instanceof Uint8Array ? r[2] : null;
        if (!hash || !bytes) continue;
        if (!store.volatile.has(hash)) {
            await store.put(bytes, hash);
            copied++;
        }
        tipHash = hash;
        tipSlot = Number(r[0]);
    }
    let promoted = 0;
    if (tipHash) {
        try {
            promoted = (await store.promote(tipHash, k)).promoted;
        } catch (err) {
            log.warn(`Block store promote after catch-up failed: ${(err as Error).message}`);
        }
    }
    if (copied || promoted) log.info(`Block store catch-up: ${copied} block(s) copied from SQLite, ${promoted} promoted into chunks${tipSlot != null ? `, tip slot ${tipSlot}` : ""}`);
    return { copied, promoted, tipSlot };
}

export function hashBytes(v: unknown): Uint8Array | null {
    if (v instanceof Uint8Array) return v.length === 32 ? v : null;
    if (typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v)) return Uint8Array.from(Buffer.from(v, "hex"));
    return null;
}

// ---------------------------------------------------------------- process-wide instance

let nodeStore: BlockStore | null = null;
let relayStore: ChunkRelayChainStore | null = null;

/** Register the node's store (peerManager, after catch-up). */
export function setNodeBlockStore(store: BlockStore | null): void {
    nodeStore = store;
    relayStore = store ? new ChunkRelayChainStore(store) : null;
}

export function getNodeBlockStore(): BlockStore | null {
    return nodeStore;
}

/**
 * The RelayChainStore the N2N server and duplex responders should serve from: the chunk-backed
 * one when `GEROLAMO_RELAY_STORE=chunks` and a store is open, otherwise undefined (SQLite default).
 */
let relayStoreMode: string | null = null;

/** `config.relayStore` ("sqlite" | "chunks"); the environment variable wins when set. */
export function configureRelayStore(mode: string | undefined): void {
    relayStoreMode = mode?.trim().toLowerCase() || null;
}

export function relayChainStoreOverride(): RelayChainStore | undefined {
    const want = (process.env.GEROLAMO_RELAY_STORE?.trim().toLowerCase() || relayStoreMode || "");
    if (want !== "chunks" || !relayStore) return undefined;
    return relayStore;
}

/** The consensus layer's selected tip after each applied range (resolves volatile forks for peers). */
/** Make the primary block store's volatile writes durable (once per applied range, before its commit; bug 384). */
export async function flushPrimaryBlockStore(): Promise<void> {
    await primaryBlockStore()?.flush();
}

export function noteSelectedTip(hash: Uint8Array): void {
    relayStore?.setTip(hash);
    setSelectedTipHash(hash);
}

/**
 * Primary mode start: the selected tip must be the block the ledger tables last applied, or the
 * ledger and the block store disagree. Sources in order: the ledger journal's newest block, the
 * persisted selected tip (`<db>/gerolamo/selected-tip.hex`), the SQLite `blocks` table's newest row
 * (exact right after the switch from mirror mode). The block must exist in the store at or above
 * the immutable tip. Returns the hash, or null when primary mode must not start.
 */
export async function resolveStartupTip(store: BlockStore, dir: string, ledgerDiffDir?: string | null): Promise<{ hash: Uint8Array; slot: number; source: string } | null> {
    const imm = await store.immutableTip();
    const candidates: { hash: string; source: string }[] = [];
    // With the ledger in LMDB the SQLite journal is frozen (bug 129: a node restarted at a day-old
    // journal tip after a reboot); the persisted tip is then the authority and comes first.
    const journalFirst = ledgerStoreMode() !== "lmdb";
    const journal: { hash: string; source: string }[] = [];
    try {
        const j = (await sql`SELECT block_hash FROM ledger_journal ORDER BY id DESC LIMIT 1`.values()) as unknown[][];
        const raw = j[0]?.[0];
        const h = raw instanceof Uint8Array ? Buffer.from(raw).toString("hex") : typeof raw === "string" ? raw : null;
        if (h && /^[0-9a-f]{64}$/i.test(h)) journal.push({ hash: h.toLowerCase(), source: "ledger journal" });
    } catch { /* table may not exist */ }
    if (journalFirst) candidates.push(...journal);
    try {
        const f = Bun.file(join(dir, "gerolamo", "selected-tip.hex"));
        if (await f.exists()) { const h = (await f.text()).trim(); if (/^[0-9a-f]{64}$/i.test(h)) candidates.push({ hash: h.toLowerCase(), source: "persisted tip" }); }
    } catch { /* ignore */ }
    if (!journalFirst) candidates.push(...journal);
    try {
        const r = (await sql`SELECT hash FROM blocks WHERE is_valid = TRUE ORDER BY slot DESC LIMIT 1`.values()) as unknown[][];
        const raw = r[0]?.[0];
        const h = raw instanceof Uint8Array ? Buffer.from(raw).toString("hex") : typeof raw === "string" ? raw : null;
        if (h && /^[0-9a-f]{64}$/i.test(h)) candidates.push({ hash: h.toLowerCase(), source: "sqlite blocks" });
    } catch { /* ignore */ }
    for (const c of candidates) {
        const b = await store.byHash(Uint8Array.from(Buffer.from(c.hash, "hex")));
        if (b && (!imm || b.slot >= imm.slot)) return { hash: b.hash, slot: b.slot, source: c.source };
        log.warn(`Block store startup tip candidate from ${c.source} (${c.hash.slice(0, 16)}…) is ${b ? `below the immutable tip (slot ${b.slot})` : "not in the store"}`);
    }
    // Last resort (bug 387): the newest stored block above the immutable tip that chains onto it and whose
    // ledger diff was flushed — a block both stores hold. The ledger store's own recovery takes it from there.
    if (ledgerDiffDir && existsSync(ledgerDiffDir)) {
        const vols = store.volatile.all().filter((v) => !imm || v.slot >= imm.slot).sort((a, b) => b.slot - a.slot);
        for (const v of vols) {
            const h = Buffer.from(v.hash).toString("hex");
            if (!existsSync(join(ledgerDiffDir, `${h}.diff`))) continue;
            if (!chainConnects(store, v.hash, imm)) continue;
            log.warn(`Block store startup tip: no recorded candidate is usable; taking the newest block both stores hold (${h.slice(0, 16)}…, slot ${v.slot})`);
            return { hash: v.hash, slot: v.slot, source: "newest block with a ledger diff" };
        }
    }
    return null;
}

/** Where the selected tip is persisted for a store directory. */
export function selectedTipPathFor(dir: string): string {
    return join(dir, "gerolamo", "selected-tip.hex");
}
export { persistSelectedTipTo };

/**
 * For scripts that read a running node's chain through the `db.ts` helpers (forge dry runs …):
 * open its block store read-only, register it and force primary mode so `getChainTipFromHeader`
 * and friends answer from the store (the SQLite `blocks` table is empty on a cleaned-up node).
 * The selected tip comes from the persisted file; falls back to the volatile chain's top.
 */
export async function attachReadOnlyBlockStore(config: NodeBlockStoreConfig, k: number): Promise<BlockStore | null> {
    const dir = resolveBlockStoreDir(config);
    if (!dir) return null;
    const store = await BlockStore.open(dir, { k, readOnly: true });
    configureBlockStoreMode("primary");
    setNodeBlockStore(store);
    try {
        const f = Bun.file(join(dir, "gerolamo", "selected-tip.hex"));
        if (await f.exists()) { const h = (await f.text()).trim(); if (/^[0-9a-f]{64}$/i.test(h)) setSelectedTipHash(Uint8Array.from(Buffer.from(h, "hex"))); }
    } catch { /* fall back to the volatile chain's top */ }
    return store;
}

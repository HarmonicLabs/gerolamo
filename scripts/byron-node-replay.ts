/**
 * Replay a network's Byron era through the node's own block-application path: a fresh database
 * (temporary directory), the real `ConsensusOrchestrator.applyRange` (strict full validation, as a
 * from-genesis node runs it) fed from a cardano-node immutable directory, read-only; then the first
 * post-Byron block, so the Byron→Shelley boundary goes through `crossByronBoundary` and the
 * hard-fork history. Checks along the way:
 *   - every block applies (a Byron chain-validation, size, fee or update-rule failure throws);
 *   - the Byron state the node persisted (ledger/byronStore) after the last Byron block equals the
 *     state of the standalone replay (consensus/byron/ByronLedger), and survives a reload;
 *   - the adopted versions, the transition epoch the hard-fork history records, the OBFT
 *     delegation restored from the persisted state;
 *   - a rollback of the last N Byron blocks and their re-application give the same state.
 *
 *   bun scripts/byron-node-replay.ts <immutable dir> --network preprod [--ledger sqlite|dual|lmdb] [--to-slot N] [--keep]
 *
 * `--ledger lmdb` starts in dual mode (an LMDB store cannot start from an empty chain: the first
 * block's parent is no anchor — dual rebuilds it from SQLite after the first range, including the
 * Byron record) and switches to lmdb after the first range, so the rest reads the Byron state
 * from the LMDB diffs.
 *
 * Writes only under a fresh temporary directory (removed unless --keep). Never touches a node's
 * database: GEROLAMO_DB_PATH is pointed at the temporary database before anything opens one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const network = opt("network") ?? "preprod";
const ledgerMode = opt("ledger") ?? "sqlite";
const toSlot = Number(opt("to-slot") ?? Number.MAX_SAFE_INTEGER);
if (!dir) { console.error("usage: bun scripts/byron-node-replay.ts <immutable dir> --network preprod [--ledger sqlite|dual] [--to-slot N] [--keep]"); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), "gerolamo-byron-node-replay-"));
process.env.GEROLAMO_DB_PATH = join(tmp, "node.db"); // before src/sql is imported (it opens the default path at import)
process.env.GEROLAMO_EXPLORER_WORKER = "0";
delete process.env.GEROLAMO_LEDGER_STORE;
delete process.env.GEROLAMO_LEDGER_DIR;

const { initSql, sql } = await import("../src/sql");
const db = await import("../src/db");
const { setEpochNetwork } = await import("../src/utils/epochFromSlotCalculations");
const { installHardForkHistory, getHardForkHistory } = await import("../src/consensus/hfc/hfcNode");
const { ConsensusOrchestrator } = await import("../src/consensus/ConsensusOrchestratooor");
const { BlockFetchBlock } = await import("@harmoniclabs/ouroboros-miniprotocols-ts");
const { blockFetchHeaderIdentity: identity } = await import("../src/consensus/blockHeaderParser");
const { ChunkStore } = await import("../src/storage/chunkStore");
const { splitEraBlock } = await import("../src/consensus/bodyHash");
const { byronGenesisUtxos } = await import("../src/consensus/byron/genesisUtxo");
const { openNodeLedgerStore, ledgerStoreMode, getLedgerStore, configureLedgerStore } = await import("../src/ledger/nodeLedgerStore");
const { loadByronLedgerRecord } = await import("../src/ledger/byronStore");
const L = await import("../src/consensus/byron/ByronLedger");
const { pvKey } = await import("../src/consensus/byron/ByronUpdate");

setEpochNetwork(network);
const config: any = await Bun.file(`./src/config/${network}/config.json`).json();
Object.assign(config, { dbPath: process.env.GEROLAMO_DB_PATH, ledgerDir: join(tmp, "ledger"), ledgerStore: ledgerMode === "lmdb" ? "dual" : ledgerMode, syncFromTip: false, syncFromGenesis: true, validation: { workers: 1 }, n2n: undefined, n2c: { enabled: false } });
await installHardForkHistory({ ...config, dbPath: config.dbPath }, network);
initSql(config.dbPath);
await db.ensureInitialized();
const genesis = await Bun.file(resolve(config.byronGenesisFile)).json();
{
    const { utxos } = byronGenesisUtxos(genesis);
    const r = await db.seedGenesisUtxosIfMissing(utxos);
    console.log(`genesis UTxOs: ${utxos.length} (${r.inserted} inserted)`);
}
await openNodeLedgerStore(config, null);
console.log(`ledger store mode ${ledgerStoreMode()}; temporary directory ${tmp}`);

const peers: any = { getPeer: () => undefined, allPeers: () => [], peers: () => [] };
const orch: any = new ConsensusOrchestrator(config, peers);

const cfg = L.byronLedgerConfigFromGenesis(genesis);
const store = await ChunkStore.open(dir, { chunkSlots: Number(cfg.epochSlots), cacheChunks: 4, readOnly: true, hashIndexPath: false });
const byron: Array<{ slot: number; bytes: Uint8Array }> = [];
let firstShelley: { slot: number; bytes: Uint8Array } | null = null;
for await (const b of store.iterate(0, toSlot, { includeEbb: true })) {
    const { era, rawBlock } = splitEraBlock(b.bytes);
    if (era > 1) { firstShelley = { slot: b.slot, bytes: b.bytes }; break; }
    // the chunk index files an EBB under its epoch number; its point's slot is the epoch's first
    byron.push({ slot: era === 0 ? Number(L.byronBoundaryFacts(rawBlock, cfg.epochSlots).slot) : b.slot, bytes: b.bytes });
}
console.log(`${byron.length} Byron blocks, first post-Byron block at slot ${firstShelley?.slot ?? "-"}`);

let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const pointOf = (b: { slot: number; bytes: Uint8Array }) => { const id = identity(b.bytes); return { slot: BigInt(b.slot), hash: Buffer.from(id.hash).toString("hex") }; };
async function applyAll(list: Array<{ slot: number; bytes: Uint8Array }>, rangeSize = 20): Promise<void> {
    for (let i = 0; i < list.length; i += rangeSize) {
        const part = list.slice(i, i + rangeSize);
        await orch.applyRange(part.map(pointOf), part.map((b) => new BlockFetchBlock({ blockData: b.bytes })), "replay");
        if (ledgerMode === "lmdb" && ledgerStoreMode() === "dual") { configureLedgerStore("lmdb"); console.log(`     switched to lmdb after the first range (anchor slot ${getLedgerStore()?.anchor()?.slot})`); }
    }
}

// the standalone reference: the same chain through ByronLedger alone
const reference: Array<ReturnType<typeof L.initialByronLedgerState>> = [];
{
    let st = L.initialByronLedgerState(cfg);
    for (const b of byron) {
        const { era, rawBlock } = splitEraBlock(b.bytes);
        if (era === 0) st = L.applyByronBoundary(cfg, st, L.byronBoundaryFacts(rawBlock, cfg.epochSlots)).state;
        else { const f = L.byronMainBlockFacts(rawBlock, cfg.epochSlots); st = L.applyByronMainBlock(cfg, L.tickByronLedger(cfg, st, f.slot), f).state; }
        reference.push(st);
    }
}
const enc = (s: ReturnType<typeof L.initialByronLedgerState>) => `${L.encodeByronLedgerCore(s)}#${L.encodeByronLedgerTip(s)}`;
const persisted = async () => { const r = await loadByronLedgerRecord(); return r ? `${r.core}#${r.tip}` : null; };

const t0 = performance.now();
await applyAll(byron);
console.log(`applied ${byron.length} Byron blocks through applyRange in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
check((await persisted()) === enc(reference[reference.length - 1]!), "persisted Byron state at the last Byron block = standalone replay");
const last = reference[reference.length - 1]!;
console.log(`     adopted ${pvKey(last.update.adoptedProtocolVersion)}, candidates ${last.update.candidateProtocolUpdates.map((c) => `${pvKey(c.protocolVersion)}@${c.slot}`).join(", ") || "none"}, maxBlockSize ${last.update.adoptedProtocolParameters.maxBlockSize}, maxTxSize ${last.update.adoptedProtocolParameters.maxTxSize}`);
const hfc = getHardForkHistory()!;
const tr = hfc.transitionAt(BigInt(byron[byron.length - 1]!.slot));
console.log(`     hard-fork history at the Byron tip: era ${hfc.currentEra()}, transition ${JSON.stringify(tr, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
check(tr.kind === "known", "the HFC knows the Byron→Shelley transition from the Byron update state before the boundary");

// OBFT delegation restored from the persisted state
const obft = await orch.ensureByronObft();
check(!!obft && [...obft.delegationMap()].every(([g, d]: [string, string]) => last.delegation.map.get(g) === d) && obft.delegationMap().size === last.delegation.map.size, "OBFT delegation map restored from the persisted delegation state");

// roll back the last 10 Byron blocks and re-apply them
const back = Math.min(10, byron.length - 2);
const target = byron[byron.length - 1 - back]!;
const ok = await orch.rollbackOurChainTo(BigInt(target.slot), "byron replay rollback test");
check(ok, `rolled back ${back} Byron blocks to slot ${target.slot}`);
const atTarget = reference.findLast((_, i) => byron[i]!.slot <= target.slot)!;
check((await persisted()) === enc(atTarget), "persisted Byron state after the rollback = standalone state at that block");
await applyAll(byron.slice(byron.length - back));
check((await persisted()) === enc(last), "re-applied: persisted Byron state = standalone replay again");

if (firstShelley) {
    const t1 = performance.now();
    await applyAll([firstShelley]);
    const starts = hfc.startEpochs().map(String);
    console.log(`applied the first post-Byron block (slot ${firstShelley.slot}) in ${((performance.now() - t1) / 1000).toFixed(1)} s; HFC starts ${starts.join(",")} (${hfc.sourceOf(1)})`);
    check(starts[1] === String(BigInt(firstShelley.slot) / cfg.epochSlots), `Shelley starts at epoch ${starts[1]} from the Byron update state`);
}

try { getLedgerStore()?.close(); } catch { /* ignore */ }
try { orch.pool?.close?.(); } catch { /* ignore */ }
void sql;
if (!argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAIL: ${failures} check(s) failed` : "OK: all checks passed");
process.exit(failures ? 1 : 0);

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
 *   bun scripts/byron-node-replay.ts <immutable dir> --network preprod [--ledger sqlite|dual|lmdb] [--to-slot N]
 *       [--shelley-epochs N] [--sql-writes] [--dir <parent dir>] [--keep]
 *
 * `--ledger lmdb` starts from an EMPTY LMDB store holding the network's genesis state
 * (ledger/genesisState.ts, bug 304; before it, this mode had to start in dual and rebuild from
 * SQLite) with `GEROLAMO_LEDGER_SQL_WRITES=0` (no SQLite ledger at all; `--sql-writes` keeps them).
 * `--shelley-epochs N` goes on past the first post-Byron block to the end of the N-th Shelley-based
 * epoch through the same apply path (Byron → Shelley translation, pots, snapshots, rewards, nonces);
 * check the result against Koios with scripts/ledger-koios-check.ts on the kept `ledger/`.
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
const shelleyEpochs = Number(opt("shelley-epochs") ?? 0);
if (!dir) { console.error("usage: bun scripts/byron-node-replay.ts <immutable dir> --network preprod [--ledger sqlite|dual|lmdb] [--to-slot N] [--shelley-epochs N] [--sql-writes] [--dir <parent>] [--keep]"); process.exit(2); }
const tmp = mkdtempSync(join(opt("dir") ?? tmpdir(), "gerolamo-byron-node-replay-"));
process.env.GEROLAMO_DB_PATH = join(tmp, "node.db"); // before src/sql is imported (it opens the default path at import)
process.env.GEROLAMO_EXPLORER_WORKER = "0";
delete process.env.GEROLAMO_LEDGER_STORE;
delete process.env.GEROLAMO_LEDGER_DIR;
if (ledgerMode === "lmdb" && !argv.includes("--sql-writes")) process.env.GEROLAMO_LEDGER_SQL_WRITES = "0";

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
const { openNodeLedgerStore, ledgerStoreMode, getLedgerStore, configureLedgerStore, sqlLedgerWrites } = await import("../src/ledger/nodeLedgerStore");
const { loadByronLedgerRecord } = await import("../src/ledger/byronStore");
const L = await import("../src/consensus/byron/ByronLedger");
const { pvKey } = await import("../src/consensus/byron/ByronUpdate");

setEpochNetwork(network);
const config: any = await Bun.file(`./src/config/${network}/config.json`).json();
Object.assign(config, { dbPath: process.env.GEROLAMO_DB_PATH, ledgerDir: join(tmp, "ledger"), ledgerStore: ledgerMode, syncFromTip: false, syncFromGenesis: true, validation: { workers: 1 }, n2n: undefined, n2c: { enabled: false } });
await installHardForkHistory({ ...config, dbPath: config.dbPath }, network);
initSql(config.dbPath);
await db.ensureInitialized();
const genesis = await Bun.file(resolve(config.byronGenesisFile)).json();
configureLedgerStore(config.ledgerStore);
if (sqlLedgerWrites()) {
    const { utxos } = byronGenesisUtxos(genesis);
    const r = await db.seedGenesisUtxosIfMissing(utxos);
    console.log(`genesis UTxOs (SQLite): ${utxos.length} (${r.inserted} inserted)`);
}
await openNodeLedgerStore(config, null); // lmdb / dual on an empty chain: the genesis state (bug 304)
console.log(`ledger store mode ${ledgerStoreMode()}${process.env.GEROLAMO_LEDGER_SQL_WRITES === "0" ? ", no SQLite ledger writes" : ""}; temporary directory ${tmp}`);

const peers: any = { getPeer: () => undefined, allPeers: () => [], peers: () => [] };
const orch: any = new ConsensusOrchestrator(config, peers);

const cfg = L.byronLedgerConfigFromGenesis(genesis);
const store = await ChunkStore.open(dir, { chunkSlots: Number(cfg.epochSlots), cacheChunks: 4, readOnly: true, hashIndexPath: false });
const byron: Array<{ slot: number; bytes: Uint8Array }> = [];
let firstShelley: { slot: number; bytes: Uint8Array } | null = null;
const later: Array<{ slot: number; bytes: Uint8Array }> = []; // past the first post-Byron block (--shelley-epochs)
let laterEnd = -1;
for await (const b of store.iterate(0, toSlot, { includeEbb: true })) {
    const { era, rawBlock } = splitEraBlock(b.bytes);
    if (firstShelley) { if (b.slot >= laterEnd) break; later.push({ slot: b.slot, bytes: b.bytes }); continue; }
    if (era > 1) {
        firstShelley = { slot: b.slot, bytes: b.bytes };
        if (shelleyEpochs <= 0) break;
        const shelleyGenesis = await Bun.file(resolve(config.shelleyGenesisFile)).json();
        laterEnd = b.slot + shelleyEpochs * Number(shelleyGenesis.epochLength); // the Shelley start is an epoch boundary
        continue;
    }
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
    const st = ledgerStoreMode() !== "sqlite" ? getLedgerStore() : null;
    if (st) {
        // the Byron → Shelley translation (translateToShelleyLedgerState) inside the first Shelley block
        const { utxoTotals } = await import("../src/ledger/genesisState");
        const { StakeReads } = await import("../src/ledger/stakeStore");
        const s = new StakeReads(st), shelleyStart = Number(starts[1]);
        const u = utxoTotals(st), pots = s.pots(), snap = s.potSnapshot(shelleyStart);
        const maxSupply = BigInt((await Bun.file(resolve(config.shelleyGenesisFile)).json()).maxLovelaceSupply);
        console.log(`     after the translation: ${u.count} UTxO(s), ${u.lovelace} lovelace; pots initialised at epoch ${pots?.initializedEpoch}: reserves ${snap?.reserves}, treasury ${snap?.treasury}`);
        check(!!pots && pots.initializedEpoch === shelleyStart, "pots initialised at the Shelley start");
        check(!!pots && snap?.reserves === maxSupply - u.lovelace - pots.feePot, "reserves at the Shelley start = maxLovelaceSupply − Σ UTxO (the first block's fees sit in the fee pot)");
        let zero = 0; for (const [, v] of st.range("utxo", new Uint8Array(0))) if (new DataView(v.buffer, v.byteOffset).getBigUint64(1, false) === 0n) zero++;
        check(zero === 0, `no zero-value output after the translation (the genesis held ${Object.values(genesis.nonAvvmBalances ?? {}).filter((v) => String(v) === "0").length})`);
        check(s.genesisDelegsAt(firstShelley.slot).size > 0, `Shelley genesis delegations in the store (${s.genesisDelegsAt(firstShelley.slot).size})`);
    }
    if (later.length) {
        const t2 = performance.now();
        await applyAll(later, 50);
        const secs = (performance.now() - t2) / 1000;
        const last = later[later.length - 1]!;
        console.log(`applied ${later.length} further blocks to slot ${last.slot} (${shelleyEpochs} Shelley-based epoch(s)) in ${secs.toFixed(1)} s (${(later.length / secs).toFixed(0)} blocks/s)`);
        const anchor = getLedgerStore()?.anchor();
        console.log(`     ledger store: anchor ${anchor ? `slot ${anchor.slot}` : "origin"}, ${getLedgerStore()?.volatileCount() ?? 0} volatile diff(s)`);
    }
}

try { getLedgerStore()?.close(); } catch { /* ignore */ }
try { orch.pool?.close?.(); } catch { /* ignore */ }
void sql;
if (!argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAIL: ${failures} check(s) failed` : "OK: all checks passed");
process.exit(failures ? 1 : 0);

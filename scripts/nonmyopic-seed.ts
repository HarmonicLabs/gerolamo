/**
 * Seed the pool-ranking state (`esNonMyopic`: per-pool likelihoods and the reward pot behind
 * GetNonMyopicMemberRewards / GetRewardInfoPools) of a node whose LMDB ledger store was bootstrapped
 * without it (bug 262: Mithril imports before it, or a store converted from SQLite). The state is
 * read from a cardano-node ledger state file of the current or an earlier epoch — a relay's
 * `db/ledger/<slot>/state`, or the Mithril snapshot's — and advanced over the store's own epoch
 * boundaries (consensus/nonMyopicSeed.ts), which needs the store's records of each boundary (the
 * `go` snapshot's pools are kept four epochs: use a state of the current or the previous epoch).
 * The boundaries after that advance it themselves.
 *
 * Stop the node first (it is the store's only writer).
 *   bun scripts/nonmyopic-seed.ts --config <node config.json> --state <ledger state file> [--yes]
 *       [--db-path <scratch db> (default <config dir>/nonmyopic-seed-scratch.db)]
 * Without --yes it only reports what it would write.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const cfgPath = arg("config"), statePath = arg("state");
if (!cfgPath || !statePath) { console.error("usage: bun scripts/nonmyopic-seed.ts --config <node config.json> --state <ledger state file> [--yes]"); process.exit(2); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const { initSettings } = await import("../src/config/settings");
initSettings({ dbPath: arg("db-path") ?? join(dirname(cfgPath), "nonmyopic-seed-scratch.db") }); // the SQLite writer opens on first use; never the node's database
const { LedgerStore } = await import("../src/ledger/LedgerStore");
const { StakeReads, StakeWrites } = await import("../src/ledger/stakeStore");
const { GovReads } = await import("../src/ledger/govStore");
const { resolveLedgerDir } = await import("../src/ledger/nodeLedgerStore");
const { nonMyopicOfLedgerState, advanceNonMyopicFromStore } = await import("../src/consensus/nonMyopicSeed");

const dbPath = join(dirname(cfgPath), "preview.db");
const dir = resolveLedgerDir({ dbPath: cfg.dbPath ?? dbPath, ledgerDir: cfg.ledgerDir });
if (!dir || !existsSync(join(dir, "data.mdb"))) { console.error(`no LMDB ledger store at ${dir}`); process.exit(1); }
const net = cfg.network === "mainnet" || cfg.networkMagic === 764824073 ? "mainnet" : cfg.networkMagic === 1 ? "preprod" : "preview";
const genesis = JSON.parse(readFileSync(join(import.meta.dir, "..", "src", "config", net, "shelley-genesis.json"), "utf8"));
const env = { activeSlotsCoeff: genesis.activeSlotsCoeff, slotsPerEpoch: Number(genesis.epochLength), maxSupply: BigInt(genesis.maxLovelaceSupply) };

const doWrite = process.argv.includes("--yes");
const st = LedgerStore.open(dir, doWrite ? { persistDiffs: false } : { readOnly: true }); // reads the volatile diffs, never rewrites or prunes them
try {
    const tipFile = join(cfg.blockStoreDir?.trim() || join(dirname(dbPath), "db"), "gerolamo", "selected-tip.hex");
    if (existsSync(tipFile)) st.selectTip(Uint8Array.from(Buffer.from(readFileSync(tipFile, "utf8").trim(), "hex")));
    const sr = new StakeReads(st), gr = new GovReads(st);
    const cur = sr.latestSnapshotEpoch();
    if (cur == null) throw new Error("the store has no stake snapshot");
    const seed = nonMyopicOfLedgerState(new Uint8Array(readFileSync(statePath)));
    console.log(`ledger state: epoch ${seed.epoch}, ${seed.likelihoods.size} pool likelihoods, reward pot ${seed.rewardPot}; store at epoch ${cur} (recorded: ${sr.nonMyopicEpochs().join(", ") || "none"})`);
    if (seed.epoch > cur) throw new Error(`the ledger state (epoch ${seed.epoch}) is ahead of the store (epoch ${cur})`);
    const out = [seed];
    for (let e = seed.epoch + 1; e <= cur; e++) out.push(advanceNonMyopicFromStore(out[out.length - 1]!, e, sr, gr, env));
    const write = out.filter((nm) => nm.epoch >= cur - 3);
    for (const nm of write) console.log(`  epoch ${nm.epoch}: ${nm.likelihoods.size} pools, reward pot ${nm.rewardPot}`);
    if (!doWrite) { console.log("dry run: pass --yes (with the node stopped) to write"); process.exit(0); }
    const w = new StakeWrites(st);
    await st.applyDirect(() => { for (const nm of write) w.putNonMyopic(nm.epoch, nm); });
    console.log(`written: epochs ${write.map((n) => n.epoch).join(", ")}`);
} finally {
    st.close();
}
process.exit(0);

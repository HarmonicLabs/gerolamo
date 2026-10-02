#!/usr/bin/env bun
/**
 * Run the body rules (rules/blockRules.ts with the reward balances, the treasury and the store's
 * exactness, as the body validator gathers them) and the governance rules over a node's most recent
 * blocks against its own LMDB ledger store, read-only: for every block whose parent the store holds
 * the view is pinned to the parent. The balance-dependent rules (withdrawal amounts, bug 272;
 * `current_treasury_value`, 273; `StakeKeyHasNonZeroAccountBalanceDELEG`, 274) are what this checks:
 * every failure on a block the chain adopted is a false rejection.
 *
 *   GEROLAMO_DB_PATH=<scratch>.db bun scripts/ledger-rules-shadow.ts --node <node dir> [--ledger-dir <dir>]
 *       [--blocks 432] [--network preview] [--verify-witnesses]
 *
 * The first block of an epoch is judged after the boundary, as the node does (the parent's state is
 * before it): the reward balances add the payouts of performance epoch e − 2 the store recorded, the
 * treasury is the boundary's (blocks never change it).
 * Nothing of the node is written: LMDB read-only, chunk and volatile stores read-only, SQLite not at all.
 */
import { join } from "node:path";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { readFileSync } from "node:fs";
import { attachReadOnlyLedgerStore, getLedgerStore, ledgerGovReads, ledgerStakeReads, ledgerStateExact } from "../src/ledger/nodeLedgerStore";
import { StakeReads } from "../src/ledger/stakeStore";
import { ChunkStore } from "../src/storage/chunkStore";
import { VolatileStore } from "../src/storage/volatileStore";
import { epochForSlot, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import { gatherShelleyBlockInputs } from "../src/consensus/rules/blockRules";
import { evaluateShelleyBlockWithInputs } from "../src/consensus/rules/blockRulesPure";
import { collectShelleyWitnesses } from "../src/consensus/rules/witnesses";
import { rewardAccountKey } from "../src/consensus/rules/ledgerChecks";
import { blockTxBodies, decodeCbor, decodeGovTx, bodyHasGovernance } from "../src/consensus/governance/govTxDecode";
import { checkBlockGovernance } from "../src/consensus/governance/govValidate";
import { buildGovLedgerView } from "../src/consensus/governance/govLedgerView";
import { logger, LogLevel } from "../src/utils/logger";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node")!;
const network = opt("network", "preview")!;
const want = Number(opt("blocks", "432"));
const verifyWitnesses = argv.includes("--verify-witnesses");
if (!node) { console.error("usage: bun scripts/ledger-rules-shadow.ts --node <node dir> [--ledger-dir <dir>] [--blocks N]"); process.exit(2); }
if (!process.env.GEROLAMO_DB_PATH) { console.error("set GEROLAMO_DB_PATH to a scratch file: this tool must not open the node's SQLite"); process.exit(2); }
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);
const genesis = JSON.parse(readFileSync(`${import.meta.dir}/../src/config/${network}/shelley-genesis.json`, "utf8"));
const config = { network, networkMagic: Number(genesis.networkMagic) };

const store = attachReadOnlyLedgerStore({ dbPath: join(node, "preview.db"), ledgerDir: opt("ledger-dir", join(node, "ledger")), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
if (!store || !ledgerGovReads()) { console.error("no LMDB ledger store"); process.exit(1); }
const exact = ledgerStateExact();
console.log(`store ${opt("ledger-dir", join(node, "ledger"))}: anchor ${store.anchor()?.slot}, ${store.volatileCount()} diff(s); balances exact: ${exact.exact}${exact.exact ? "" : ` (${exact.why})`}`);
const tipAtStart = store.selectedTip();
const chunkSlots = network === "preview" ? 4320 : 21600;
const imm = await ChunkStore.open(join(node, "db", "immutable"), { chunkSlots, cacheChunks: 4, readOnly: true });
const vol = await VolatileStore.open(join(node, "db", "volatile"), { readOnly: true });
const immTip = await imm.tip();
const blocks: Array<{ slot: number; hash: Uint8Array; bytes: Uint8Array; prev?: Uint8Array | null }> = [];
for (const n of imm.chunks().slice(-Math.ceil(want / (chunkSlots / 24)) - 2)) for await (const b of imm.iterate(n * chunkSlots, n * chunkSlots + chunkSlots - 1)) blocks.push({ slot: b.slot, hash: b.hash, bytes: b.bytes });
for (const b of vol.all()) if (!immTip || b.slot > immTip.slot) blocks.push({ slot: b.slot, hash: b.hash, bytes: b.bytes, prev: b.prevHash });
blocks.sort((a, b) => a.slot - b.slot);
const prevOf = (bytes: Uint8Array): Uint8Array | null => { const top: any = decodeCbor(bytes).v; const prev = top.v[1].v[0].v[0].v[2]; return prev?.t === "b" ? prev.v : null; };
const slotOfBlock = new Map<string, number>(blocks.map((b) => [toHex(b.hash), b.slot]));

const cov = { blocks: 0, skipped: 0, boundaryBlocks: 0, txs: 0, withdrawals: 0, withdrawalAccounts: new Set<string>(), treasuryClaims: 0, deregistrations: 0, deregWithBalanceRead: 0, failures: 0, balanceFailures: 0, balanceReports: 0, firstSlot: 0, lastSlot: 0 };
const BALANCE = /reward balance|ConwayTreasuryValueMismatch|StakeKeyHasNonZeroAccountBalance/;
for (const b of blocks.slice(-want)) {
    let prev: Uint8Array | null = null;
    try { prev = b.prev !== undefined ? b.prev : prevOf(b.bytes); } catch { cov.skipped++; continue; }
    if (!prev || !store.knows(prev)) { cov.skipped++; continue; }
    const block: any = MultiEraBlock.fromCbor(b.bytes);
    if (Number(block.era) < 2) { cov.skipped++; continue; }
    store.selectTip(prev);
    const e = Number(epochForSlot(b.slot));
    const raw = ledgerGovReads()!.epochParams(e)?.params;
    if (!raw) { cov.skipped++; continue; }
    const params = epochParamsFromRecord(e, raw);
    const parentSlot = slotOfBlock.get(toHex(prev)) ?? store.anchor()?.slot ?? b.slot;
    const boundary = Number(epochForSlot(parentSlot)) !== e;
    cov.blocks++; cov.firstSlot ||= b.slot; cov.lastSlot = b.slot;
    const bodies: any[] = block.block.transactionBodies ?? [];
    const invalid = new Set<number>(((block.block.invalidTransactions ?? []) as any[]).map(Number));
    cov.txs += bodies.length;
    // what the balance rules see in this block
    bodies.forEach((body, i) => {
        if (invalid.has(i)) return;
        for (const w of (body.withdrawals?.map ?? []) as any[]) { cov.withdrawals++; cov.withdrawalAccounts.add(rewardAccountKey(w.rewardAccount)); }
        if (body.currentTreasuryValue != null) cov.treasuryClaims++;
        for (const c of (body.certs ?? []) as any[]) if (Number(c.certType) === 1 || Number(c.certType) === 8) cov.deregistrations++;
    });

    // ---- body rules, inputs gathered as the node does (state at the parent)
    const inputs = await gatherShelleyBlockInputs(block);
    let payouts: Map<string, bigint> | null = null;
    if (boundary) {
        cov.boundaryBlocks++;
        payouts = ledgerStakeReads()!.rewardPayouts(e - 2);
        if (inputs.rewardBalances) for (const [c, v] of inputs.rewardBalances) inputs.rewardBalances.set(c, v + (payouts.get(c) ?? 0n));
        const after = store.viewAt(b.hash);
        if (after) inputs.treasury = new StakeReads(after).pots()?.treasury ?? inputs.treasury;
    }
    let preVerified: boolean[] | null = null;
    if (!verifyWitnesses) {
        let n = 0;
        const wits: any[] = block.block.transactionWitnessSets ?? [];
        for (let i = 0; i < bodies.length; i++) { const bh = bodies[i].hash?.toString?.(); n += collectShelleyWitnesses(bh ? fromHex(String(bh)) : blake2b_256(bodies[i].toCborBytes()), wits[i]).items.length; }
        preVerified = new Array(n).fill(true);
    }
    const outcome = bodies.length === 0 ? { failures: [], reports: [] } : await evaluateShelleyBlockWithInputs(block, { config, pool: null, params, genesis, slot: BigInt(b.slot), preVerified, phase: "rules" }, inputs);

    // ---- governance rules (the zero-balance deregistration and the LEDGER treasury check)
    const parsed = blockTxBodies(b.bytes);
    const models = parsed.bodies.map((bytes, i) => (parsed.invalid.has(i) || !bytes || !bodyHasGovernance(bytes) ? null : decodeGovTx(bytes))).filter((m): m is NonNullable<typeof m> => !!m);
    let govFailures: string[] = [], govReports: string[] = [];
    if (models.length) {
        const view = await buildGovLedgerView(models, { needVrfs: Number(raw.protocol_major_ver ?? 0) > 10 && models.some((m) => m.certs.some((c) => c.type === 3)) });
        for (const m of models) for (const c of m.certs) if ((c.type === 1 || c.type === 8) && c.cred && view.accountBalance(c.cred) != null) cov.deregWithBalanceRead++;
        const adjusted = boundary ? {
            ...view,
            accountBalance: (c: string) => { const v = view.accountBalance(c); return v == null ? null : v + (payouts!.get(c) ?? 0n); },
            treasury: () => inputs.treasury ?? view.treasury(),
        } : view;
        const v = await checkBlockGovernance({ slot: b.slot, epoch: e, bodies: parsed.bodies.map((bytes) => ({ bytes })), invalid: parsed.invalid, raw, networkId: network === "mainnet" ? 1 : 0, view: adjusted });
        govFailures = v.failures; govReports = v.reports;
    }
    const where = `slot ${b.slot}${boundary ? " (first of epoch)" : ""}`;
    for (const f of [...outcome.failures, ...govFailures]) { cov.failures++; if (BALANCE.test(f)) cov.balanceFailures++; console.log(`FAIL ${where}: ${f}`); }
    for (const r of [...outcome.reports, ...govReports]) if (BALANCE.test(r)) { cov.balanceReports++; console.log(`report ${where}: ${r}`); }
}
if (tipAtStart) store.selectTip(tipAtStart);
console.log(JSON.stringify({ node, exact, ...cov, withdrawalAccounts: cov.withdrawalAccounts.size }));
console.log(`shadow over ${node}: ${cov.blocks} block(s) (slots ${cov.firstSlot}–${cov.lastSlot}, ${cov.boundaryBlocks} first-of-epoch, ${cov.skipped} skipped), ${cov.txs} tx(s); ${cov.withdrawals} withdrawal(s) from ${cov.withdrawalAccounts.size} account(s), ${cov.treasuryClaims} treasury claim(s), ${cov.deregistrations} deregistration(s); ${cov.failures} failure(s) (${cov.balanceFailures} balance rule), ${cov.balanceReports} balance report(s)`);
getLedgerStore()?.close();
process.exit(cov.failures ? 1 : 0);

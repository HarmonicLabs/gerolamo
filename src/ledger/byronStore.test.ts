/**
 * The Byron chain-validation state persists with the ledger's rollback discipline: written inside
 * the block's scope, it rolls back with the block — SQLite through the before-image journal, LMDB
 * through the block diffs — and the driver reloaded afterwards continues from the right state.
 * Driven by the real preprod Byron era (46 blocks).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import chain from "../consensus/byron/__fixtures__/preprod-byron-chain.json";
import preprodGenesis from "../config/preprod/byron-genesis.json";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { setApplyBlock, undoLedgerJournal } from "../db/ledgerJournal";
import { ByronLedgerDriver } from "../consensus/byron/ByronLedgerDriver";
import { encodeByronLedgerCore, encodeByronLedgerTip } from "../consensus/byron/ByronLedger";
import { configureLedgerStore, getLedgerStore, ledgerAfterRange, ledgerBeginBlock, ledgerCommitBlock, ledgerRollbackTo, openNodeLedgerStore } from "./nodeLedgerStore";
import { loadByronLedgerRecord } from "./byronStore";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-byron-store-"));
const ERA_END = { kind: "version", major: 2 } as const;
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; x[1] = 0xb7; return x; };
const blocks = chain.blocks.map((b) => ({ slot: b.slot, bytes: fromHex(b.hex) }));
const snap = (d: ByronLedgerDriver) => `${encodeByronLedgerCore(d.state)}#${encodeByronLedgerTip(d.state)}`;

beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
});
afterAll(() => { configureLedgerStore("sqlite"); rmSync(dir, { recursive: true, force: true }); });

describe("Byron ledger persistence", () => {
    test("SQLite: journaled per block; undoing blocks restores the state they found", async () => {
        configureLedgerStore("sqlite");
        // no record yet but a Byron tip (a chain an older build applied): rebuilt over the stored blocks
        async function* stored() { for (const b of blocks) yield { slot: b.slot, block_data: b.bytes }; }
        const rebuilt = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: true, storedBlocks: stored });
        let d = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: false });
        expect(d.state.tipBlockNo).toBeNull();
        const after: string[] = [];
        for (let i = 0; i < blocks.length; i++) {
            await setApplyBlock(sql as any, h(i));
            const s = d.step(blocks[i]!.bytes);
            expect(s.errors).toEqual([]);
            await d.commit(s);
            await setApplyBlock(sql as any, null);
            after.push(snap(d));
        }
        expect(snap(rebuilt)).toBe(after[after.length - 1]!);
        // a fresh driver reads the tip state back
        d = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: false });
        expect(snap(d)).toBe(after[after.length - 1]!);
        expect(d.transitionEpoch()).toBe(4n);
        // a Byron block at or after the known end of the era is in the wrong era
        const ended = await ByronLedgerDriver.open(preprodGenesis, { kind: "epoch", epoch: 3n }, { rebuild: false });
        expect(ended.transitionEpoch()).toBe(3n);
        expect(ended.step(blocks[blocks.length - 1]!.bytes).errors[0]).toContain("HardForkLedgerErrorWrongEra");
        // roll back the last 25 blocks (newest first, as rollbackChainTo does)
        await undoLedgerJournal(sql as any, blocks.slice(21).map((_, j) => h(21 + j)).reverse());
        d = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: false });
        expect(snap(d)).toBe(after[20]!);
        expect(d.transitionEpoch()).toBeNull(); // the 2.0.0 candidate (slot 56163) is gone with its block
        // and re-applying them reproduces the same tip
        const journalRows = async () => Number(((await sql`SELECT COUNT(*) FROM ledger_journal WHERE tbl = 'byron_ledger'`.values()) as unknown[][])[0]![0]);
        const before = await journalRows();
        for (let i = 21; i < blocks.length; i++) {
            await setApplyBlock(sql as any, h(i));
            await d.commit(d.step(blocks[i]!.bytes));
            await setApplyBlock(sql as any, null);
        }
        expect(snap(d)).toBe(after[after.length - 1]!);
        // the tip row is rewritten on every block, the core row only when it changed
        const rows = (await journalRows()) - before;
        expect(rows).toBeGreaterThanOrEqual(blocks.length - 21);
        expect(rows).toBeLessThan(2 * (blocks.length - 21));
    });

    test("LMDB: the record lives in the block diffs; a rollback drops the blocks' effects, promotion keeps them", async () => {
        await openNodeLedgerStore({ dbPath: join(dir, "t.db"), ledgerDir: join(dir, "ledger"), ledgerStore: "lmdb" }, null);
        let d = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: false });
        expect(d.state.tipBlockNo).toBeNull(); // the SQLite rows of the first test are not read in lmdb mode
        const after: string[] = [];
        for (let i = 0; i < blocks.length; i++) {
            ledgerBeginBlock(h(i), i === 0 ? null : h(i - 1), blocks[i]!.slot);
            const s = d.step(blocks[i]!.bytes);
            expect(s.errors).toEqual([]);
            await d.commit(s);
            ledgerCommitBlock();
            after.push(snap(d));
        }
        expect((await loadByronLedgerRecord())?.tip).toBe(encodeByronLedgerTip(d.state));
        // promote everything deeper than 10 blocks: the anchor holds the older state, the diffs the rest
        await ledgerAfterRange(10);
        expect(getLedgerStore()!.anchor()?.slot).toBe(blocks[blocks.length - 11]!.slot);
        d = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: false });
        expect(snap(d)).toBe(after[after.length - 1]!);
        // roll back 5 blocks: the record at block 40
        ledgerRollbackTo(blocks[40]!.slot, h(40));
        d = await ByronLedgerDriver.open(preprodGenesis, ERA_END, { rebuild: false });
        expect(snap(d)).toBe(after[40]!);
        getLedgerStore()?.close();
        configureLedgerStore("sqlite");
    });
});

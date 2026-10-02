import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "./LedgerStore";
import { StakeReads, StakeWrites } from "./stakeStore";
import { GovWrites } from "./govStore";
import { attachReadOnlyLedgerStore, configureLedgerStore, getLedgerStore, ledgerStateExact, markLedgerSource } from "./nodeLedgerStore";

// Bugs 272–276: the balance-dependent rules are strict only on a store whose balances are exact.
const root = mkdtempSync(join(tmpdir(), "gerolamo-ledger-source-"));
afterAll(() => { getLedgerStore()?.close(); configureLedgerStore("sqlite"); rmSync(root, { recursive: true, force: true }); });
const h = (n: number) => new Uint8Array(32).fill(n);

async function makeStore(name: string, initializedEpoch: number, seededEpoch: number, source?: "snapshot" | "sqlite"): Promise<string> {
    const dir = join(root, name);
    const st = LedgerStore.open(dir);
    const s = new StakeWrites(st), g = new GovWrites(st);
    st.applyDirectSync(() => {
        s.putPots({ reserves: 1n, treasury: 2n, feePot: 0n, donationPot: 0n, initializedEpoch });
        g.putState({ thrNum: 2, thrDen: 3, constitutionHash: null, constitutionScript: null, noConfidence: 0, prevPP: null, prevHF: null, prevCC: null, prevCons: null, seededEpoch, dormantEpochs: 0, pending: null });
    });
    await st.setAnchor({ slot: 100, hash: h(1) });
    if (source) await markLedgerSource(st, source);
    st.close();
    return dir;
}
const attach = (dir: string, mode = "lmdb") => { getLedgerStore()?.close(); return attachReadOnlyLedgerStore({ dbPath: join(root, "none.db"), ledgerDir: dir, ledgerStore: mode, blockStoreDir: join(root, "nodb") }); };

describe("ledgerStateExact", () => {
    test("a snapshot import is exact in lmdb mode only", async () => {
        const dir = await makeStore("import", 1420, 1420, "snapshot");
        attach(dir);
        expect(ledgerStateExact()).toEqual({ exact: true, why: "" });
        attach(dir, "dual");
        expect(ledgerStateExact()).toEqual({ exact: false, why: "ledger store mode dual" });
        configureLedgerStore("sqlite");
        expect(ledgerStateExact().exact).toBe(false);
    });
    test("a store seeded from SQLite is not, whatever its epochs say", async () => {
        attach(await makeStore("sqlite", 1420, 1420, "sqlite"));
        expect(ledgerStateExact()).toEqual({ exact: false, why: "ledger store seeded from SQLite" });
    });
    test("unmarked stores: an import's epochs (pots initialized = governance seed epoch) count as a snapshot", async () => {
        attach(await makeStore("old-import", 1420, 1420));
        expect(ledgerStateExact().exact).toBe(true);
        attach(await makeStore("genesis-synced", 0, 647)); // the producer's SQLite-rebuilt store of 2026-09-30
        expect(ledgerStateExact()).toEqual({ exact: false, why: "ledger store not imported from a snapshot" });
        configureLedgerStore("sqlite");
    });
});

describe("LedgerStore.viewAt", () => {
    test("reads the state after any held block, whatever the selected tip", async () => {
        const st = LedgerStore.open(join(root, "views"), { persistDiffs: false });
        const w = new StakeWrites(st);
        await st.setAnchor({ slot: 10, hash: h(1) });
        st.applyDirectSync(() => w.setOpcertCounter("ab".repeat(28), 3, 10));
        st.beginBlock(h(2), h(1), 20); w.setOpcertCounter("ab".repeat(28), 4, 20); st.commitBlock();
        st.beginBlock(h(3), h(2), 30); w.setOpcertCounter("ab".repeat(28), 5, 30); st.commitBlock();
        st.beginBlock(h(9), h(2), 31); st.commitBlock(); // a fork from block 2, now the selected tip
        const at = (n: number) => { const v = st.viewAt(h(n)); return v ? new StakeReads(v).opcert("ab".repeat(28))?.counter : "not held"; };
        expect([at(1), at(2), at(3), at(9), at(7)]).toEqual([3, 4, 5, 4, "not held"]);
        const hx = (n: number) => Buffer.from(h(n)).toString("hex");
        expect([1, 2, 3, 9, 7].map((n) => st.knowsHex(hx(n)))).toEqual([true, true, true, true, false]);
        st.close();
    });
});

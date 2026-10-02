import { describe, expect, test } from "bun:test";
import { Cbor } from "@harmoniclabs/cbor";
import { encodeInterpreter, eraShape, reconstructSummary, stabilityWindow, epochOfSlot, slotToRelativeMs, type GenesisGeometry } from "./hfc";
import { HardForkHistory, eraStartsFromBlocks, triggersFrom } from "./HardForkHistory";
import { geometryFromGenesis, resolveEraStarts, type EraProbe } from "./hfcNode";
import { eraIndexAt } from "./eraOfTip";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hex = (o: any) => Buffer.from(Cbor.encode(o).toBuffer()).toString("hex");
const PREVIEW = geometryFromGenesis("src/config/preview/shelley-genesis.json", "src/config/preview/byron-genesis.json");
const MAINNET = geometryFromGenesis("src/config/mainnet/shelley-genesis.json", "src/config/mainnet/byron-genesis.json");
// captured from the cardano-node 11.0.1 preview relay on 2026-09-29 (scripts/hfc-compare.ts --print): GetInterpreter at tip slot 123 992 605 (epoch 1435)
const RELAY_PREVIEW_1435 = "9f838300000083000000841910e0194e2083001903608100190360838300000083000000841a000151801903e883001965408100196540838300000083000000841a000151801903e883001965408100196540838300000083000000841a000151801903e8830019654081001965408383000000831b0398dd06d5c800001a0003f48003841a000151801903e88300196540810019654083831b0398dd06d5c800001a0003f4800383c2490306949515279000001a0353a900190286841a000151801903e8830019654081001965408383c2490306949515279000001a0353a90019028683c24906b9d29b7264a000001a07652a0019059c841a000151801903e883001965408100196540ff";

function history(g: GenesisGeometry, starts: number[], cfg: Record<string, unknown> = {}, network?: string): HardForkHistory {
    const h = new HardForkHistory(g, triggersFrom(cfg, network), 0);
    h.adopt(starts.map((e) => BigInt(e)), "test");
    return h;
}

describe("era parameters from the genesis files", () => {
    test("stability window ⌈3k/f⌉", () => {
        expect(stabilityWindow(2160, 0.05)).toBe(129600n);
        expect(stabilityWindow(432, 0.05)).toBe(25920n);
        expect(stabilityWindow(10, 0.1)).toBe(300n);
        expect(stabilityWindow(7, 0.3)).toBe(70n); // 21/0.3 = 70 exactly (no float rounding up)
    });
    test("preview shape: Byron [4320, 20 s, 864], Shelley+ [86400, 1 s, 25920]", () => {
        const s = eraShape(PREVIEW);
        expect(s[0]).toEqual({ epochSize: 4320n, slotLengthMs: 20000n, safeZone: 864n, genesisWindow: 864n });
        expect(s[6]).toEqual({ epochSize: 86400n, slotLengthMs: 1000n, safeZone: 25920n, genesisWindow: 25920n });
    });
});

describe("GetInterpreter (consensus reconstructSummary + Serialise Summary)", () => {
    test("preview: byte-identical with the relay capture", () => {
        const h = history(PREVIEW, [0, 0, 0, 0, 0, 3, 646]);
        expect(hex(encodeInterpreter(h.summary(123992605n)))).toBe(RELAY_PREVIEW_1435);
    });

    test("the safe zone horizon: epoch after next when the tip is in the last 3k/f slots of its epoch", () => {
        const h = history(PREVIEW, [0, 0, 0, 0, 0, 3, 646]);
        const e1435 = h.firstSlotOfEpoch(1435n);
        expect(h.summary(e1435 + 86400n - 25921n - 1n).at(-1)!.end!.epoch).toBe(1436n); // tip+1+25920 < boundary
        expect(h.summary(e1435 + 86400n - 25921n).at(-1)!.end!.epoch).toBe(1436n); // lands exactly on the boundary
        expect(h.summary(e1435 + 86400n - 25920n).at(-1)!.end!.epoch).toBe(1437n); // one slot later: next-but-one boundary
    });

    test("mainnet era boundaries (slot/time arithmetic across Byron)", () => {
        const h = history(MAINNET, [0, 208, 236, 251, 290, 365, 507]);
        const s = h.summary(null);
        expect(s[1]!.start).toEqual({ timePicos: 89856000n * 1_000_000_000_000n, slot: 4492800n, epoch: 208n });
        expect(s[6]!.start.slot).toBe(4492800n + (507n - 208n) * 432000n);
        expect(epochOfSlot(s, 4492799n)).toBe(207n);
        expect(epochOfSlot(s, 4492800n)).toBe(208n);
        expect(slotToRelativeMs(s, 4492800n)).toBe(89856000000n);
        expect(h.eraOfSlot(4492800n + 28n * 432000n)).toBe(2); // Allegra's first slot
    });

    test("TransitionKnown (Test*HardForkAtEpoch in the future): the next era follows with its own safe zone", () => {
        const h = history(PREVIEW, [0, 0, 0, 0, 0], { TestBabbageHardForkAtEpoch: 10 }, "preview");
        const s = h.summary(5n);
        expect(s.length).toBe(6);
        expect(s[4]!.end!.epoch).toBe(10n);
        expect(s[5]!.start.epoch).toBe(10n);
        expect(s[5]!.end!.epoch).toBe(11n); // 25920 slots from the era start, rounded up to the boundary
    });

    test("an empty ledger (Origin): the safe zone counts from slot 0", () => {
        const s = reconstructSummary(eraShape(PREVIEW), [0n], { kind: "unknown", ledgerTipSlot: null });
        expect(s[0]!.end!.slot).toBe(4320n);
    });
});

describe("ledger-driven transitions", () => {
    test("custom testnet from genesis alone: Test* triggers at epoch 0, then protocol versions", () => {
        const h = new HardForkHistory(PREVIEW, triggersFrom({ TestShelleyHardForkAtEpoch: 0, TestAllegraHardForkAtEpoch: 0, TestMaryHardForkAtEpoch: 0, TestAlonzoHardForkAtEpoch: 0 }), 42);
        expect(h.noteEpochStart(0n, 6)).toEqual([1, 2, 3, 4]);
        expect(h.noteEpochStart(1n, 6)).toEqual([]); // intra-era Alonzo 6
        expect(h.noteEpochStart(2n, 8)).toEqual([]); // 8 ≠ Babbage's 7: consensus guards with ==
        expect(h.noteEpochStart(3n, 7)).toEqual([5]);
        expect(h.noteEpochStart(4n, 8)).toEqual([]);
        expect(h.noteEpochStart(9n, 9)).toEqual([6]);
        expect(h.noteEpochStart(10n, 10)).toEqual([]); // Conway + 1 stays Conway
        expect(h.noteEpochStart(20n, 12)).toEqual([]); // node 11: Conway's successor is NotDuringThisExecution
        expect(h.startEpochs()).toEqual([0n, 0n, 0n, 0n, 0n, 3n, 9n]);
    });

    test("SanchoNet-style: every Test* trigger at 0 → Conway at epoch 0", () => {
        const cfg = Object.fromEntries(["Shelley", "Allegra", "Mary", "Alonzo", "Babbage", "Conway"].map((e) => [`Test${e}HardForkAtEpoch`, 0]));
        const h = new HardForkHistory(PREVIEW, triggersFrom(cfg), 4);
        h.noteEpochStart(0n, null);
        expect(h.currentEra()).toBe(6);
        expect(h.summary(100n).length).toBe(7);
    });

    test("a rollback across a transition undoes it", () => {
        const h = history(PREVIEW, [0, 0, 0, 0, 0, 3]);
        h.noteEpochStart(646n, 9);
        expect(h.currentEra()).toBe(6);
        h.rollbackToSlot(646n * 86400n - 1n);
        expect(h.currentEra()).toBe(5);
    });
});

describe("era starts from the block store", () => {
    test("mainnet-like chain: Byron blocks then Shelley… (first block of each era)", async () => {
        // synthetic chain: one block every 20 slots in Byron, every 20 slots after
        const bE = 21600n, sE = 432000n, S = 208n;
        const starts = [0n, 208n, 236n, 251n, 290n, 365n, 507n];
        const firstSlot = (e: bigint) => (e < S ? e * bE : S * bE + (e - S) * sE);
        const eraOf = (slot: bigint) => { let era = 0; for (let i = 0; i < starts.length; i++) if (slot >= firstSlot(starts[i]!)) era = i; return era; };
        const blocks: bigint[] = [];
        for (let s = 1n; s < firstSlot(520n); s += (s < S * bE ? 20n : 20n)) blocks.push(s);
        const find = (slot: bigint) => { let lo = 0, hi = blocks.length; while (lo < hi) { const m = (lo + hi) >> 1; if (blocks[m]! < slot) lo = m + 1; else hi = m; } return lo; };
        const first = async (slot: bigint) => { const i = find(slot); return i < blocks.length ? { era: eraOf(blocks[i]!), slot: blocks[i]! } : null; };
        const last = async (slot: bigint) => { const i = find(slot) - 1; return i >= 0 ? { era: eraOf(blocks[i]!), slot: blocks[i]! } : null; };
        const out = await eraStartsFromBlocks(first, last, blocks.at(-1)!, { byronEpochSize: bE, shelleyEpochSize: sE });
        expect(out).toEqual(starts);
    });

    test("eras without blocks start with the next era (preview: Alonzo blocks from slot 0)", async () => {
        const first = async (slot: bigint) => ({ era: slot < 3n * 86400n ? 4 : 5, slot: slot + 1n });
        const last = async () => null;
        const out = await eraStartsFromBlocks(first, last, 10n * 86400n, { byronEpochSize: 4320n, shelleyEpochSize: 86400n });
        expect(out.slice(0, 6)).toEqual([0n, 0n, 0n, 0n, 0n, 3n]);
    });
});

describe("bug 237: a Mithril-bootstrapped node whose history never reached the tip's era", () => {
    /** A store holding only Conway blocks from epoch 1400 on (one block every 20 slots), tip in epoch 1435. */
    const first = 1400n * 86400n + 7n, tipSlot = 1435n * 86400n + 100n;
    const conwayOnly: EraProbe = {
        firstAtOrAfter: async (slot) => { const s = slot < first ? first : first + ((slot - first + 19n) / 20n) * 20n; return s <= tipSlot ? { era: 6, slot: s } : null; },
        lastBefore: async (slot) => { if (slot <= first) return null; const s = first + ((slot - first - 1n) / 20n) * 20n; return { era: 6, slot: s }; },
    };

    test("the block-store search cannot see the start of an era already in progress at the store's first block", async () => {
        const out = await eraStartsFromBlocks(conwayOnly.firstAtOrAfter, conwayOnly.lastBefore, tipSlot, { byronEpochSize: 4320n, shelleyEpochSize: 86400n });
        expect(out).toEqual([0n, null, null, null, null, null, null]);
    });

    test("preview: the built-in history completes it (Babbage@3, Conway@646); the tip's era is the floor; only then is the history ready and persisted", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hfc-"));
        const h = new HardForkHistory(PREVIEW, triggersFrom({}, "preview"), 2, join(dir, "hfc-eras.json"));
        h.noteEpochStart(0n, null); // the config eras, as installHardForkHistory does at startup
        expect(h.currentEra()).toBe(4);
        expect(h.ready).toBe(false);
        expect(existsSync(join(dir, "hfc-eras.json"))).toBe(false); // nothing persisted before completion
        // what the live nodes did: resolved without a tip → must NOT become ready
        expect(await resolveEraStarts(h, { probe: conwayOnly, tipSlot: null, tipEra: null })).toBe(false);
        expect(h.ready).toBe(false);
        expect(existsSync(join(dir, "hfc-eras.json"))).toBe(false);
        // with the store's tip (a Conway block)
        expect(await resolveEraStarts(h, { probe: conwayOnly, tipSlot, tipEra: 6 })).toBe(true);
        expect(h.startEpochs()).toEqual([0n, 0n, 0n, 0n, 0n, 3n, 646n]);
        expect(h.sourceOf(6)).toBe("known network history");
        expect(h.eraOfSlot(tipSlot)).toBe(6); // the forged block gets era tag 7
        expect(h.eraOfSlot(646n * 86400n - 1n)).toBe(5);
        const j = JSON.parse(readFileSync(join(dir, "hfc-eras.json"), "utf8"));
        expect(j.complete).toBe(true);
        expect(j.starts.length).toBe(7);
        expect(hex(encodeInterpreter(h.summary(tipSlot)))).toBe(hex(encodeInterpreter(history(PREVIEW, [0, 0, 0, 0, 0, 3, 646]).summary(tipSlot))));
    });

    test("a custom network without a fallback stays not ready, but the tip's era tag floors every answer at or after the tip", async () => {
        const h = new HardForkHistory(PREVIEW, triggersFrom({ TestShelleyHardForkAtEpoch: 0, TestAllegraHardForkAtEpoch: 0, TestMaryHardForkAtEpoch: 0, TestAlonzoHardForkAtEpoch: 0 }), 42);
        expect(await resolveEraStarts(h, { probe: conwayOnly, tipSlot, tipEra: 6 })).toBe(false);
        expect(h.currentEra()).toBe(4);
        expect(h.tipEra()).toBe(6);
        expect(h.eraOfSlot(tipSlot)).toBe(6); // never Alonzo for the block being forged on this tip
        expect(h.eraOfSlot(tipSlot + 5000n)).toBe(6);
        expect(h.eraOfSlot(tipSlot - 1n)).toBe(4); // before the tip the history is all we know
    });

    test("the incomplete file the live nodes wrote (five config eras, no `complete`) is treated as absent", () => {
        const dir = mkdtempSync(join(tmpdir(), "hfc-"));
        const path = join(dir, "hfc-eras.json");
        writeFileSync(path, JSON.stringify({ magic: 2, starts: ["0", "0", "0", "0", "0"], sources: ["genesis", "config (Test*HardForkAtEpoch)", "config (Test*HardForkAtEpoch)", "config (Test*HardForkAtEpoch)", "config (Test*HardForkAtEpoch)"] }));
        const h = new HardForkHistory(PREVIEW, triggersFrom({}, "preview"), 2, path);
        expect(h.load()).toBe(false);
        expect(h.currentEra()).toBe(0);
        // a complete one loads
        writeFileSync(path, JSON.stringify({ magic: 2, starts: ["0", "0", "0", "0", "0", "3", "646"], sources: [], complete: true }));
        const h2 = new HardForkHistory(PREVIEW, triggersFrom({}, "preview"), 2, path);
        expect(h2.load()).toBe(true);
        expect(h2.currentEra()).toBe(6);
        expect(h2.ready).toBe(false); // still needs the tip to be declared ready
    });

    test("a store from genesis (the real preview chunk stores) still yields Babbage@3 and Conway@646 from its blocks", async () => {
        const probe: EraProbe = {
            firstAtOrAfter: async (slot) => ({ era: slot < 3n * 86400n ? 4 : slot < 646n * 86400n ? 5 : 6, slot: slot < 20n ? 20n : slot }),
            lastBefore: async (slot) => (slot <= 20n ? null : { era: slot - 1n < 3n * 86400n ? 4 : slot - 1n < 646n * 86400n ? 5 : 6, slot: slot - 1n }),
        };
        const h = new HardForkHistory(PREVIEW, triggersFrom({}, "preview"), 2);
        expect(await resolveEraStarts(h, { probe, tipSlot, tipEra: 6 })).toBe(true);
        expect(h.startEpochs()).toEqual([0n, 0n, 0n, 0n, 0n, 3n, 646n]);
        expect(h.sourceOf(5)).toBe("block store (first block of the era)");
        expect(h.sourceOf(6)).toBe("block store (first block of the era)");
    });

    test("the forging / tx-submission era against a Conway tip is never below Conway, whatever the history knows", () => {
        const h = new HardForkHistory(PREVIEW, triggersFrom({}, "preview"), 2);
        h.noteEpochStart(0n, null); // the live nodes' state: Byron..Alonzo only, not ready
        expect(eraIndexAt(h, tipSlot, 5)).toBe(5); // no tip era known yet: the table floor (what the coordinator's hot-fix relies on)
        h.noteTipEra(tipSlot, 6);
        expect(eraIndexAt(h, tipSlot, 5)).toBe(6);
        expect(eraIndexAt(h, tipSlot, 0)).toBe(6); // a custom network with no table still forges Conway
        expect(eraIndexAt(null, tipSlot, 6)).toBe(6);
        h.adopt([0n, 0n, 0n, 0n, 0n, 3n, 646n], "test"); h.markReady(6);
        expect(eraIndexAt(h, tipSlot, 0)).toBe(6);
        expect(eraIndexAt(h, 3n * 86400n - 1n, 0)).toBe(4); // before the tip the history answers
    });
});

describe("Byron → Shelley from the Byron update state (byronTransition)", () => {
    const PREPROD = geometryFromGenesis("src/config/preprod/shelley-genesis.json", "src/config/preprod/byron-genesis.json");
    test("while Byron is current the transition is the Byron state's: unknown, then known at epoch 4 (preprod)", () => {
        const h = new HardForkHistory(PREPROD, triggersFrom({}, "preprod"), 1);
        let known: bigint | null = null;
        h.byronTransition = () => known;
        const tip = 56163n;
        // unknown: the Byron era ends at the safe zone (2k slots past the tip, to an epoch boundary)
        expect(h.summary(tip).length).toBe(1);
        expect(h.summary(tip)[0]!.end!.epoch).toBe(3n);
        known = 4n; // the 2.0.0 candidate is stable
        const s = h.summary(60486n);
        expect(s.length).toBe(2);
        expect(s[0]!.end).toEqual({ timePicos: 4n * 21600n * 20_000_000_000_000n, slot: 86400n, epoch: 4n });
        expect(s[1]!.start.slot).toBe(86400n);
        // the chain crosses: Shelley recorded from the Byron state
        expect(h.noteByronTransition(4n, "test")).toBe(true);
        expect(h.startEpochs()).toEqual([0n, 4n]);
        expect(h.sourceOf(1)).toContain("Byron update state");
        expect(h.noteByronTransition(4n, "again")).toBe(false); // Shelley already current
        // a later epoch boundary still asks the Shelley ledger's version for Allegra
        expect(h.noteEpochStart(5n, 3)).toEqual([2]);
    });

    test("a Test*HardForkAtEpoch network keeps its configured epoch; the Byron state is not consulted", () => {
        const h = new HardForkHistory(PREPROD, triggersFrom({ TestShelleyHardForkAtEpoch: 2 }), 1);
        h.byronTransition = () => 4n;
        expect(h.transitionAt(100n)).toEqual({ kind: "known", epoch: 2n });
        expect(h.noteByronTransition(4n, "test")).toBe(false);
    });

    test("a rollback back into Byron undoes the recorded Shelley start", () => {
        const h = new HardForkHistory(PREPROD, triggersFrom({}, "preprod"), 1);
        h.noteByronTransition(4n, "test");
        expect(h.rollbackToSlot(84242n)).toBe(1);
        expect(h.startEpochs()).toEqual([0n]);
    });
});

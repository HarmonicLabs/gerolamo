import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockProducer } from "./BlockProducer";
import { FIRST, fakeNode, fixtureTxs, keyFiles, leadersOf, type FakeNodeOpts } from "./producerTestKit";
import { slotAt, slotStartMs } from "./slotClock";

async function producerAt(dir: string, clock: { now: number }, adopted: Uint8Array[], o: FakeNodeOpts = {}, files = keyFiles(dir)) {
    const node = fakeNode(clock, 300n, adopted, o);
    const producer = new BlockProducer(files, node);
    await producer.start(); await producer.ready; producer.stop();
    const slot = async (s: bigint, offsetMs = 200) => { clock.now = slotStartMs(s, "preview") + offsetMs; await (producer as any).onSlot(s, clock.now); };
    const noteOf = (s: bigint) => producer.stats().leaderSlots.find((r) => r.slot === s.toString())?.note ?? "";
    return { producer, node, slot, noteOf, files };
}

describe("forging safety: one block per slot, also across restarts (456)", () => {
    test("the slot is recorded as signed in the state file before the block is handed out", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-safety-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const seen: Array<{ signedSlot: string | null; lastForgedSlot: string | null }> = [];
        const stateFile = join(dir, "producer-state.json");
        const { producer, slot } = await producerAt(dir, clock, [], { onAdopt: () => { const j = JSON.parse(readFileSync(stateFile, "utf8")); seen.push({ signedSlot: j.signedSlot, lastForgedSlot: j.lastForgedSlot }); } });
        const [l0] = leadersOf(producer);
        await slot(l0!);
        expect(seen).toEqual([{ signedSlot: l0!.toString(), lastForgedSlot: null }]);
        const after = JSON.parse(readFileSync(stateFile, "utf8"));
        expect(after).toMatchObject({ signedSlot: l0!.toString(), lastForgedSlot: l0!.toString() });
        expect(producer.stats().signedSlot).toBe(l0!.toString());
    }, 60_000);

    test("a crash after signing but before recording the block: the restarted producer does not forge that slot again", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-safety-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const first = await producerAt(dir, clock, adopted);
        const [l0] = leadersOf(first.producer);
        await first.slot(l0!);
        expect(adopted).toHaveLength(1);
        // what the disk holds when the process died between the write-ahead and the final record,
        // and a node whose chain does not show the block (it was only on its way out)
        const f = first.files.stateFile;
        const j = JSON.parse(readFileSync(f, "utf8"));
        writeFileSync(f, JSON.stringify({ ...j, lastForgedSlot: null, signedSlot: l0!.toString() }));
        const again = await producerAt(dir, { now: slotStartMs(l0!, "preview") + 50 }, adopted);
        await again.slot(l0!, 300); // still inside the slot: the deadline rule alone would allow it
        expect(adopted).toHaveLength(1);
        expect(again.noteOf(l0!)).toContain(`already forged slot ${l0}`);
    }, 60_000);

    test("an unreadable state file: every slot up to now counts as signed, later slots forge", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-safety-"));
        const files = keyFiles(dir);
        const probe = await producerAt(dir, { now: slotStartMs(FIRST, "preview") + 100 }, []);
        const [l0, l1] = leadersOf(probe.producer);
        writeFileSync(files.stateFile, "{\"lastForgedSlot\": \"12"); // truncated write
        const clock = { now: slotStartMs(l0!, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const p = await producerAt(dir, clock, adopted, {}, files);
        expect(p.producer.stats().signedSlot).toBe(slotAt(slotStartMs(l0!, "preview") + 100, "preview").toString());
        await p.slot(l0!, 300);
        expect(adopted).toHaveLength(0);
        expect(p.noteOf(l0!)).toContain("already forged slot");
        await p.slot(l1!);
        expect(adopted).toHaveLength(1);
    }, 60_000);

    test("adopt fails after it applied the block: no second, different block is signed for the slot", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-safety-"));
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        let calls = 0;
        const txs = (await fixtureTxs()).slice(0, 4);
        const { producer, slot } = await producerAt(dir, clock, adopted, { txs, applyThenThrow: true, onAdopt: () => { calls++; } });
        const [l0] = leadersOf(producer);
        await slot(l0!);
        expect(calls).toBe(1); // without the tip check the retry signed and handed out a second header
        expect(adopted).toHaveLength(1);
        const rep = producer.stats().leaderSlots.find((r) => r.slot === l0!.toString())!;
        expect(rep.outcome).toBe("adopted");
        expect(producer.stats().forged).toBe(1);
        expect(producer.stats().lastForgedSlot).toBe(l0!.toString());
    }, 60_000);

    test("a state file that cannot be written: the slot is given up rather than forged unguarded", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gerolamo-safety-"));
        const files = { ...keyFiles(dir), stateFile: join(dir, "no-such-dir", "producer-state.json") };
        const clock = { now: slotStartMs(FIRST, "preview") + 100 };
        const adopted: Uint8Array[] = [];
        const { producer, slot, noteOf } = await producerAt(dir, clock, adopted, {}, files);
        const [l0] = leadersOf(producer);
        await slot(l0!);
        expect(adopted).toHaveLength(0);
        expect(noteOf(l0!)).toContain("cannot be written");
    }, 60_000);
});

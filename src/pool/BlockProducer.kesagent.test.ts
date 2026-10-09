import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockFetchHeaderIdentity } from "../consensus/blockHeaderParser";
import { tieBreakInfoOf } from "../consensus/tieBreak";
import { BlockProducer, kesSourceOf } from "./BlockProducer";
import { FakeKesAgent } from "./kesAgent/fakeAgent";
import { RecvResult, encodeDropKeyMessageV2, encodeKeyMessageV2 } from "./kesAgent/protocol";
import { evolveKesTo, generateColdKey, generateKesKey, issueOperationalCert, kesEvolution, loadColdSigningKey, loadKesSigningKey, type KesKey } from "./keystore";
import { F, PERIOD, fakeNode, leadersOf } from "./producerTestKit";
import { slotStartMs } from "./slotClock";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function setup() {
    const dir = mkdtempSync(join(tmpdir(), "gka-bp-"));
    const sock = join(dir, "agent.sock");
    const agent = new FakeKesAgent(sock).start();
    const clock = { now: slotStartMs(333n * 86400n, "preview") + 100 };
    const adopted: Uint8Array[] = [];
    const producer = new BlockProducer({ coldVkeyFile: F("cold.vkey"), vrfSkeyFile: F("vrf.skey"), kesAgentSocket: sock, stateFile: join(dir, "producer-state.json") }, fakeNode(clock, 300n, adopted));
    cleanup.push(() => { producer.stop(); agent.stop(); });
    const cold = loadColdSigningKey(F("cold.skey"));
    const cert = (kes: KesKey, counter: bigint, period = PERIOD, by = cold) => issueOperationalCert(kes.vkey, { next: counter, coldVkey: by.vkey }, period, by).opcert.cert;
    let ts = 0n;
    const push = async (kes: KesKey, oc: ReturnType<typeof cert>) => {
        const n = agent.results.length;
        agent.push(encodeKeyMessageV2(++ts, kes.skey, oc));
        await agent.until(() => agent.results.length === n + 1, 20_000, "RecvResult");
        return agent.results[n]!;
    };
    const slot = async (s: bigint) => { clock.now = slotStartMs(s, "preview") + 200; await (producer as any).onSlot(s, clock.now); };
    const noteOf = (s: bigint) => producer.stats().leaderSlots.find((r) => r.slot === s.toString())?.note ?? "";
    return { agent, producer, adopted, cold, cert, push, slot, noteOf, clock, nextTs: () => ++ts };
}

describe("block producer with credentials from a kes-agent (452)", () => {
    test("no forging before the first key; push → install → forge; rotation; outdated / foreign / mismatched pairs refused; drop", async () => {
        const { agent, producer, adopted, cold, cert, push, slot, noteOf, nextTs } = setup();
        await producer.start(); await producer.ready;
        (producer as any).ticker.stop(); // slots are driven by hand
        await agent.until(() => producer.stats().credentials.agent?.connected === true, 5000, "producer to connect");
        expect(agent.answers).toEqual(["Service:2.0"]);
        let st = producer.stats();
        expect(st.credentials).toMatchObject({ source: "kes-agent", installed: false });
        expect(st.credentials.agent?.connected).toBe(true);
        expect(st.opcert).toBeNull();
        expect(st.kes).toBeNull();
        const L = leadersOf(producer);
        expect(L.length).toBeGreaterThan(4);

        // a leader slot before the agent sent anything: missed, with the reason
        await slot(L[0]!);
        expect(adopted).toHaveLength(0);
        expect(noteOf(L[0]!)).toContain("kes-agent");

        // the agent's first key: installed through the same checks as a SIGHUP reload
        const kes0 = loadKesSigningKey(F("kes.skey"));
        expect(await push(kes0, cert(kes0, 0n))).toBe(RecvResult.ok);
        st = producer.stats();
        expect(st.credentials).toMatchObject({ installed: true });
        expect(st.credentials.agent).toMatchObject({ keysAccepted: 1, lastResult: "OK" });
        expect(st.opcert?.counter).toBe("0");
        await slot(L[1]!);
        expect(adopted).toHaveLength(1); // passed our header validator inside fakeNode.adopt

        // rotation: a new KES key with counter + 1
        const kes1 = generateKesKey(new Uint8Array(32).fill(0x21));
        expect(await push(kes1, cert(kes1, 1n))).toBe(RecvResult.ok);
        expect(producer.stats().opcert?.counter).toBe("1");
        // the previous certificate again: older than the installed one
        expect(await push(kes0, cert(kes0, 0n))).toBe(RecvResult.keyOutdated);
        // a certificate from another cold key
        expect(await push(kes1, cert(kes1, 2n, PERIOD, generateColdKey(new Uint8Array(32).fill(9))))).toBe(RecvResult.invalidOpCert);
        // a key that is not the certificate's KES key
        expect(await push(kes0, cert(kes1, 1n))).toBe(RecvResult.invalidOpCert);
        // a certificate whose KES period starts after the current one
        expect(await push(kes1, cert(kes1, 1n, PERIOD + 1n))).toBe(RecvResult.invalidOpCert);
        expect(producer.stats().opcert?.counter).toBe("1");
        expect(producer.stats().lastError).toContain("credential reload rejected (kes-agent)");
        await slot(L[2]!);
        expect(adopted).toHaveLength(2);
        const hdr = tieBreakInfoOf(blockFetchHeaderIdentity(adopted[1]!).rawHeaderBytes)!;
        expect(hdr.opcertCounter).toBe(1n); // forged with the rotated pair

        // DropKey: the producer forgets the key and stops forging
        agent.push(encodeDropKeyMessageV2(nextTs()));
        await agent.until(() => agent.results.length === 7);
        expect(agent.results[6]).toBe(RecvResult.ok);
        expect(producer.stats().credentials.installed).toBe(false);
        expect(producer.stats().opcert).toBeNull();
        await slot(L[3]!);
        expect(adopted).toHaveLength(2);
        expect(noteOf(L[3]!)).toContain("no KES key");

        // SIGHUP has nothing to reload in this mode
        const r = await producer.reloadCredentials();
        expect(r.ok === false && r.reason).toContain("kes-agent");

        producer.stop();
        await agent.until(() => agent.open === 0, 5000, "client to hang up");
        void cold;
    }, 120_000);

    test("an agent key behind the clock is evolved forward on install; an evolved key forges at its evolution", async () => {
        const { agent, producer, adopted, cert, push, slot } = setup();
        await producer.start(); await producer.ready;
        (producer as any).ticker.stop();
        await agent.until(() => producer.stats().credentials.agent?.connected === true);
        // certificate one KES period back: the current slot needs evolution 1, the pushed key is at 0
        const kes = loadKesSigningKey(F("kes.skey"));
        expect(kesEvolution(kes)).toBe(0);
        expect(await push(kes, cert(kes, 0n, PERIOD - 1n))).toBe(RecvResult.ok);
        expect(kesEvolution((producer as any).kes)).toBe(1); // forward security: no older evolution kept
        expect(producer.stats().kes?.evolution).toBe(1);
        // the agent's own evolution (period suffix 1) is accepted as such
        const evolved = loadKesSigningKey(F("kes.skey"));
        evolveKesTo(evolved, 1);
        expect(await push(evolved, cert(evolved, 0n, PERIOD - 1n))).toBe(RecvResult.ok);
        await slot(leadersOf(producer)[0]!);
        expect(adopted).toHaveLength(1);
    }, 60_000);

    test("configuration: a key file or a kes-agent socket, never both", () => {
        expect(kesSourceOf({ kesSkeyFile: "k", opcertFile: "c" })).toBe("file");
        expect(kesSourceOf({ kesAgentSocket: "/run/kes-agent/service.sock" })).toBe("kes-agent");
        expect(() => kesSourceOf({ kesSkeyFile: "k", opcertFile: "c", kesAgentSocket: "/s" })).toThrow(/mutually exclusive/);
        expect(kesSourceOf({ kesAgentSocket: "/s", opcertFile: "c" })).toBe("kes-agent"); // tolerated, as cardano-node's invocation; the agent's certificate is used
        expect(() => kesSourceOf({ kesSkeyFile: "k" })).toThrow(/opcertFile is required/);
        expect(() => kesSourceOf({})).toThrow(/kesSkeyFile \+ opcertFile, or kesAgentSocket/);
        expect(() => kesSourceOf({ kesAgentSocket: "/" + "x".repeat(200) })).toThrow(/sun_path/);
        expect(() => new BlockProducer({ coldVkeyFile: F("cold.vkey"), vrfSkeyFile: F("vrf.skey"), kesSkeyFile: F("kes.skey"), opcertFile: "x", kesAgentSocket: "/s" }, {} as any)).toThrow(/mutually exclusive/);
    });
});

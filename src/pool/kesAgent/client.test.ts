import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByteReader, KesAgentClient, validateKesAgentSocketPath, type KesAgentPushMeta } from "./client";
import { FakeKesAgent } from "./fakeAgent";
import { RecvResult, decodeOpcertWire, encodeDropKeyMessageV2, encodeKeyMessageV1, encodeKeyMessageV2, type AgentBundle } from "./protocol";

const OPCERT = decodeOpcertWire(Buffer.from("df22d655d82015c61cb62c8138dfe7a27238a60c1e1cd5bb18ec71a5dd71f39f" + "0000000000000007" + "0000000000000596" + "41".repeat(64), "hex"));
function key(period: number, fill = 7): Uint8Array {
    const k = new Uint8Array(612).fill(fill);
    new DataView(k.buffer).setUint32(608, period, false);
    return k;
}

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function setup(versions?: string[], onSession?: () => Uint8Array | null) {
    const dir = mkdtempSync(join(tmpdir(), "gka-"));
    const agent = new FakeKesAgent(join(dir, "s.sock"), versions, onSession).start();
    const got: Array<{ period: number; counter: bigint; meta: KesAgentPushMeta; keyByte: number }> = [];
    const drops: KesAgentPushMeta[] = [];
    let answer: number = RecvResult.ok;
    const client = new KesAgentClient({
        socketPath: agent.path,
        minBackoffMs: 20, maxBackoffMs: 80, bodyTimeoutMs: 300,
        onKey: async (b: AgentBundle, meta) => { got.push({ period: b.period, counter: b.opcert.counter, meta, keyByte: b.kesSignKey[0]! }); return answer; },
        onDrop: async (meta) => { drops.push(meta); return RecvResult.ok; },
    });
    cleanup.push(() => { client.stop(); agent.stop(); });
    return { agent, client, got, drops, setAnswer: (c: number) => { answer = c; } };
}

describe("kes-agent client against an in-process agent (451)", () => {
    test("connect → current key → rotation → outdated push → drop → disconnect → reconnect", async () => {
        const { agent, client, got, drops } = setup(undefined, () => encodeKeyMessageV2(1_000n, key(0), OPCERT));
        client.start();
        // handshake: the client picks Service:2.0 from the offer, the agent echoes it and pushes its current key
        await agent.until(() => agent.results.length === 1, 5000, "first RecvResult");
        expect(agent.answers).toEqual(["Service:2.0"]);
        expect(agent.results).toEqual([RecvResult.ok]);
        expect(got).toHaveLength(1);
        expect(got[0]!.period).toBe(0);
        expect(got[0]!.counter).toBe(7n);
        expect(got[0]!.meta).toEqual({ version: "Service:2.0", timestamp: 1_000n });
        expect(client.state()).toMatchObject({ connected: true, version: "Service:2.0", keysReceived: 1, keysAccepted: 1, lastResult: "OK" });
        // the agent evolved / rotated: a newer push is installed
        agent.push(encodeKeyMessageV2(2_000n, key(1, 9), OPCERT));
        await agent.until(() => agent.results.length === 2);
        expect(got.map((g) => g.period)).toEqual([0, 1]);
        expect(got[1]!.keyByte).toBe(9);
        // not newer than the last push of the session: KeyOutdated, never handed to the producer
        agent.push(encodeKeyMessageV2(2_000n, key(2), OPCERT));
        await agent.until(() => agent.results.length === 3);
        expect(agent.results[2]).toBe(RecvResult.keyOutdated);
        expect(got).toHaveLength(2);
        // DropKey
        agent.push(encodeDropKeyMessageV2(3_000n));
        await agent.until(() => agent.results.length === 4);
        expect(agent.results[3]).toBe(RecvResult.ok);
        expect(drops).toEqual([{ version: "Service:2.0", timestamp: 3_000n }]);
        // the agent restarts: the client notices, backs off, reconnects, and gets the current key again
        agent.disconnectAll();
        await agent.until(() => !client.state().connected, 5000, "client to notice the disconnect");
        expect(client.state().disconnects).toBe(1);
        await agent.until(() => agent.results.length === 5, 5000, "key after reconnect");
        expect(agent.connections).toBe(2);
        expect(client.state()).toMatchObject({ connected: true, connects: 2, keysAccepted: 3, keysRejected: 1, drops: 1 });
        // a new session starts a new timestamp order (kes-agent ServiceClient keeps it per session)
        expect(got.at(-1)!.meta.timestamp).toBe(1_000n);
    }, 20_000);

    test("a rejected key is answered with the producer's code and does not reset the backoff", async () => {
        const { agent, client, setAnswer } = setup();
        setAnswer(RecvResult.invalidOpCert);
        client.start();
        await agent.until(() => agent.answers.length === 1);
        agent.push(encodeKeyMessageV2(5n, key(0), OPCERT));
        await agent.until(() => agent.results.length === 1);
        expect(agent.results).toEqual([RecvResult.invalidOpCert]);
        expect(client.state()).toMatchObject({ keysAccepted: 0, keysRejected: 1, lastResult: "InvalidOpCert" });
    }, 10_000);

    test("Service:1.0 when that is all the agent offers: bare bundles, no timestamps", async () => {
        const { agent, client, got } = setup(["Service:1.0"]);
        client.start();
        await agent.until(() => agent.answers.length === 1);
        expect(agent.answers).toEqual(["Service:1.0"]);
        agent.push(encodeKeyMessageV1(key(3), OPCERT));
        agent.push(encodeKeyMessageV1(key(4), OPCERT));
        await agent.until(() => agent.results.length === 2);
        expect(agent.results).toEqual([RecvResult.ok, RecvResult.ok]);
        expect(got.map((g) => [g.period, g.meta.version, g.meta.timestamp])).toEqual([[3, "Service:1.0", null], [4, "Service:1.0", null]]);
    }, 10_000);

    test("no common version: the client answers Nothing and keeps retrying with backoff", async () => {
        const { agent, client } = setup(["Service:9.9"]);
        client.start();
        await agent.until(() => agent.answers.length >= 2, 5000, "two attempts");
        expect(agent.answers.slice(0, 2)).toEqual([null, null]);
        expect(client.state().lastError).toContain("no common protocol version");
        expect(client.state().connected).toBe(false);
    }, 10_000);

    test("protocol errors end the session: unknown push kind, a push body that stalls", async () => {
        const { agent, client } = setup();
        client.start();
        await agent.until(() => agent.answers.length === 1);
        agent.push(new Uint8Array([7]));
        await agent.until(() => agent.connections === 2, 5000, "reconnect after a bad kind");
        await agent.until(() => client.state().connected, 5000, "second session");
        expect(agent.open).toBe(1); // the broken session's socket was closed by the client
        expect(client.state().lastError).toBeNull(); // cleared by the new handshake
        expect(client.state().disconnects).toBe(1);
        agent.push(new Uint8Array([0, 0, 0])); // a key push that never completes
        await agent.until(() => agent.connections === 3 && client.state().connected, 5000, "reconnect after a stalled body");
        expect(client.state().disconnects).toBe(2);
        expect(agent.open).toBe(1);
    }, 10_000);

    test("an agent that is not there yet: the client keeps trying and connects once it appears", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gka-"));
        const path = join(dir, "late.sock");
        const keys: number[] = [];
        const client = new KesAgentClient({ socketPath: path, minBackoffMs: 20, maxBackoffMs: 40, onKey: async (b) => { keys.push(b.period); return RecvResult.ok; } });
        client.start();
        cleanup.push(() => client.stop());
        await Bun.sleep(120);
        expect(client.state().connected).toBe(false);
        expect(client.state().lastError).toContain("cannot connect");
        const agent = new FakeKesAgent(path, undefined, () => encodeKeyMessageV2(1n, key(2), OPCERT)).start();
        cleanup.push(() => agent.stop());
        await agent.until(() => agent.results.length === 1, 5000, "late key");
        expect(keys).toEqual([2]);
    }, 10_000);

    test("socket path validation (Linux sun_path limit, no abstract names)", () => {
        expect(validateKesAgentSocketPath("/run/kes-agent/service.socket")).toBe("/run/kes-agent/service.socket");
        expect(() => validateKesAgentSocketPath("/" + "a".repeat(107))).toThrow(/107-byte/);
        expect(() => validateKesAgentSocketPath("@kes-agent")).toThrow(/abstract/);
        expect(() => validateKesAgentSocketPath("")).toThrow();
    });

    test("ByteReader: exact reads across chunks, consumed bytes zeroed, timeout and close", async () => {
        const r = new ByteReader();
        const a = Uint8Array.from([1, 2, 3]), b = Uint8Array.from([4, 5]);
        const p = r.read(4);
        r.push(a); r.push(b);
        expect([...(await p)]).toEqual([1, 2, 3, 4]);
        expect([...a]).toEqual([0, 0, 0]); // the pushed chunk is wiped once copied
        expect(r.buffered).toBe(1);
        await expect(r.read(5, 30)).rejects.toThrow(/timed out/);
        const q = r.read(2);
        r.close();
        await expect(q).rejects.toThrow(/closed/);
    });
});

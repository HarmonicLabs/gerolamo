/**
 * Optional interop test against the real Haskell kes-agent (input-output-hk/kes-agent). Skipped
 * unless KES_AGENT_BIN and KES_AGENT_CONTROL_BIN point at the `kes-agent` and `kes-agent-control`
 * executables. Uses only the throwaway fixture cold key.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KesAgentClient } from "./client";
import { RecvResult, type AgentBundle } from "./protocol";
import { encodeOperationalCert, envelopeBytes, issueOperationalCert, kesKeyFromAgent, kesPeriodOfSlot, kesProbe, loadColdSigningKey, readTextEnvelope, writeTextEnvelope } from "../keystore";
import { slotAt } from "../slotClock";

const AGENT = process.env.KES_AGENT_BIN, CONTROL = process.env.KES_AGENT_CONTROL_BIN;
const F = (n: string) => new URL(`../__fixtures__/cli-keys/${n}`, import.meta.url).pathname;

describe("kes-agent interop (optional)", () => {
    test.skipIf(!AGENT || !CONTROL)("the real agent's bundle installs: key matches the certificate and signs", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gka-io-"));
        const service = join(dir, "service.sock"), control = join(dir, "control.sock");
        const agent = Bun.spawn([AGENT!, "run", "--service-address", service, "--control-address", control, "--cold-verification-key", F("cold.vkey"), "--genesis-file", "src/config/preview/shelley-genesis.json"], { stdout: "ignore", stderr: "ignore" });
        try {
            await Bun.sleep(1000);
            const run = async (...args: string[]) => { const p = Bun.spawn([CONTROL!, "--control-address", control, ...args], { stdout: "pipe", stderr: "pipe" }); if ((await p.exited) !== 0) throw new Error(`${args[0]}: ${await new Response(p.stderr).text()}`); };
            await run("gen-staged-key", "--kes-verification-key-file", join(dir, "kes.vkey"));
            const vkey = envelopeBytes(readTextEnvelope(join(dir, "kes.vkey")), 32);
            const cold = loadColdSigningKey(F("cold.skey"));
            const period = kesPeriodOfSlot(slotAt(Date.now(), "preview"), 129600n);
            const { opcert } = issueOperationalCert(vkey, { next: 0n, coldVkey: cold.vkey }, period, cold);
            writeTextEnvelope(join(dir, "opcert.cert"), encodeOperationalCert(opcert));
            await run("install-key", "--opcert-file", join(dir, "opcert.cert"));
            const got: AgentBundle[] = [];
            const client = new KesAgentClient({ socketPath: service, onKey: async (b) => { got.push({ ...b, kesSignKey: Uint8Array.from(b.kesSignKey) }); return RecvResult.ok; } });
            client.start();
            for (let i = 0; i < 100 && !got.length; i++) await Bun.sleep(100);
            client.stop();
            expect(got.length).toBeGreaterThan(0);
            const b = got[0]!;
            expect(Buffer.from(b.opcert.kesVkey).toString("hex")).toBe(Buffer.from(vkey).toString("hex"));
            const key = kesKeyFromAgent(b.kesSignKey);
            expect(Buffer.from(key.vkey).toString("hex")).toBe(Buffer.from(vkey).toString("hex"));
            expect(kesProbe(key, vkey)).toBe(true);
        } finally {
            agent.kill();
        }
    }, 60_000);
});

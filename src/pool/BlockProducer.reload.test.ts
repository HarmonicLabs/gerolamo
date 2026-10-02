import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockProducer, type ProducerNode } from "./BlockProducer";
import {
    encodeOperationalCert, envelopeOfBytes, EnvelopeType, generateColdKey, generateKesKey, issueOperationalCert, kesSecretForEnvelope,
    loadColdSigningKey, loadKesSigningKey, writeTextEnvelope, type ColdKey, type KesKey,
} from "./keystore";
import { slotStartMs } from "./slotClock";

// Test-only fixture keys (src/pool/__fixtures__/cli-keys), never a real pool's.
const F = (n: string) => new URL(`./__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const genesis = { activeSlotsCoeff: 0.05, slotsPerKESPeriod: 129600, maxKESEvolutions: 62 };
const SLOT = 333n * 86400n + 1000n;
const PERIOD = SLOT / 129600n;

function node(chainCounter: { v: bigint | null }): ProducerNode {
    return {
        network: "preview", era: 7, genesis, now: () => slotStartMs(SLOT, "preview") + 10,
        nonceFor: async () => null, sigmaFor: async () => null, tip: async () => null,
        protocolVersion: async () => ({ major: 10, minor: 0 }), maxBlockBodySize: async () => 90_112,
        lastOnChainOpcertCounter: async () => chainCounter.v,
        mempoolTxs: async () => [], dropFromMempool: async () => {}, adopt: async () => {},
        schedule: async () => [],
    };
}

/** Write a KES key + an opcert for it, issued by `cold` with `counter` at `period`, into `dir`. */
function writeCreds(dir: string, cold: ColdKey, kes: KesKey, counter: bigint, period = PERIOD) {
    const kesFile = join(dir, "kes.skey"), certFile = join(dir, "node.cert");
    writeTextEnvelope(kesFile, envelopeOfBytes(EnvelopeType.kesSigningKey, "KES Signing Key", kesSecretForEnvelope(kes)));
    const { opcert } = issueOperationalCert(kes.vkey, { next: counter, coldVkey: cold.vkey }, period, cold);
    writeTextEnvelope(certFile, encodeOperationalCert(opcert));
    return { kesFile, certFile };
}

function setup(chain: bigint | null = 0n) {
    const dir = mkdtempSync(join(tmpdir(), "gerolamo-kes-reload-"));
    const cold = loadColdSigningKey(F("cold.skey"));
    const first = writeCreds(dir, cold, loadKesSigningKey(F("kes.skey")), 0n);
    const counter = { v: chain };
    const bp = new BlockProducer({ coldVkeyFile: F("cold.vkey"), kesSkeyFile: first.kesFile, vrfSkeyFile: F("vrf.skey"), opcertFile: first.certFile }, node(counter));
    return { dir, cold, bp, counter };
}

describe("KES / operational certificate hot reload (SIGHUP)", () => {
    test("a rotated key + certificate (counter + 1) replaces the running pair", async () => {
        const { dir, cold, bp } = setup(0n);
        expect(bp.stats().opcert.counter).toBe("0");
        const kes = generateKesKey(new Uint8Array(32).fill(7));
        const vkey = Uint8Array.from(kes.vkey);
        writeCreds(dir, cold, kes, 1n);
        const r = await bp.reloadCredentials();
        expect(r).toEqual({ ok: true, counter: 1n, kesPeriod: PERIOD, evolution: 0 });
        expect(bp.stats().opcert.counter).toBe("1");
        expect(Buffer.from((bp as any).kes.vkey).toString("hex")).toBe(Buffer.from(vkey).toString("hex"));
        // reloading the same files again is fine (counter equal to the chain's + 1 still allowed)
        expect((await bp.reloadCredentials()).ok).toBe(true);
    }, 30_000);

    test("rejections keep the old credentials", async () => {
        const { dir, cold, bp, counter } = setup(0n);
        const before = (bp as any).kes;
        const cases: Array<[string, () => void]> = [
            ["different cold key", () => writeCreds(dir, generateColdKey(new Uint8Array(32).fill(9)), generateKesKey(new Uint8Array(32).fill(1)), 1n)],
            ["skips ahead", () => writeCreds(dir, cold, generateKesKey(new Uint8Array(32).fill(2)), 5n)],
            ["starts after the current period", () => writeCreds(dir, cold, generateKesKey(new Uint8Array(32).fill(3)), 1n, PERIOD + 1n)],
            ["expired", () => writeCreds(dir, cold, generateKesKey(new Uint8Array(32).fill(4)), 1n, PERIOD - 62n)],
        ];
        for (const [what, write] of cases) {
            write();
            const r = await bp.reloadCredentials();
            expect(r.ok).toBe(false);
            expect((bp as any).kes).toBe(before);
            expect(bp.stats().opcert.counter).toBe("0");
            void what;
        }
        // certificate for a KES key other than the one in kes.skey
        const kesA = generateKesKey(new Uint8Array(32).fill(5)), kesB = generateKesKey(new Uint8Array(32).fill(6));
        const { kesFile } = writeCreds(dir, cold, kesA, 1n);
        writeTextEnvelope(kesFile, envelopeOfBytes(EnvelopeType.kesSigningKey, "KES Signing Key", kesSecretForEnvelope(kesB)));
        const r = await bp.reloadCredentials();
        expect(r.ok === false && r.reason).toContain("different KES key");
        // the chain moved on (counter 3 seen): a certificate with counter 1 is now below it
        counter.v = 3n;
        writeCreds(dir, cold, generateKesKey(new Uint8Array(32).fill(8)), 1n);
        const low = await bp.reloadCredentials();
        expect(low.ok === false && low.reason).toContain("below last on-chain counter 3");
        expect(bp.stats().lastError).toContain("credential reload rejected");
        expect((bp as any).kes).toBe(before);
    }, 60_000); // KES key generation is slow (pure TS)

    test("waits for a forge in progress before swapping", async () => {
        const { dir, cold, bp } = setup(null);
        (bp as any).forging = true;
        writeCreds(dir, cold, generateKesKey(new Uint8Array(32).fill(11)), 1n);
        const p = bp.reloadCredentials();
        await Bun.sleep(120);
        expect(bp.stats().opcert.counter).toBe("0");
        (bp as any).forging = false;
        expect((await p).ok).toBe(true);
        expect(bp.stats().opcert.counter).toBe("1");
    }, 30_000);
});

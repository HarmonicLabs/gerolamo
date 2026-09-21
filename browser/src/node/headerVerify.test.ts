import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ChunkStore } from "../../../src/storage/chunkStore";
import { parseHeaderCrypto, verifyHeaderCrypto } from "./headerVerify";
import { epochOfSlot, networkByMagic } from "./networks";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const API = process.env.GEROLAMO_RELAY_API ?? "http://127.0.0.1:3036";
const net = networkByMagic(2)!;

async function nonceOf(epoch: number): Promise<Uint8Array | null> {
    try {
        const r = await fetch(`${API}/api/v0/epochs/${epoch}`);
        const j = r.ok ? await r.json() : null;
        const h: string | undefined = j?.epoch_nonce;
        return h && /^[0-9a-f]{64}$/i.test(h) ? Uint8Array.from(Buffer.from(h, "hex")) : null;
    } catch { return null; }
}

describe.skipIf(!existsSync(`${PREVIEW}/28400.primary`))("header cryptography against real Conway headers", () => {
    test("opcert, KES and VRF verify for a chunk of preview blocks with the relay's epoch nonce", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const tip = await src.tip();
        const epoch = epochOfSlot(net, tip!.slot);
        const nonce = await nonceOf(epoch);
        if (!nonce) { console.log(`no nonce for epoch ${epoch} from ${API}; skipping`); return; }
        let n = 0, ok = 0;
        const from = Math.max(tip!.slot - 3000, (epoch - net.shelleyStartEpoch) * net.epochLength + net.shelleyStartSlot);
        for await (const b of src.iterate(from, tip!.slot)) {
            const h = parseHeaderCrypto(b.bytes.slice(b.headerOffset, b.headerOffset + b.headerSize), b.bytes[1]!);
            expect(h.slot).toBe(b.slot);
            const r = verifyHeaderCrypto(h, nonce, net.slotsPerKESPeriod, net.maxKESEvolutions);
            if (r.opcertOk && r.kesOk && r.vrfOk) ok++; else console.log(`slot ${b.slot}: ${r.detail.join("; ")}`);
            n++;
        }
        expect(n).toBeGreaterThan(20);
        expect(ok).toBe(n);
        // a tampered body must fail KES; a wrong nonce must fail VRF
        const last = await src.blockAt(tip!.slot);
        const h = parseHeaderCrypto(last!.bytes.slice(last!.headerOffset, last!.headerOffset + last!.headerSize), last!.bytes[1]!);
        const bad = new Uint8Array(nonce); bad[0] ^= 1;
        expect(verifyHeaderCrypto(h, bad, net.slotsPerKESPeriod, net.maxKESEvolutions).vrfOk).toBe(false);
        const tampered = { ...h, bodyBytes: (() => { const c = new Uint8Array(h.bodyBytes); c[c.length - 1] ^= 1; return c; })() };
        expect(verifyHeaderCrypto(tampered, nonce, net.slotsPerKESPeriod, net.maxKESEvolutions).kesOk).toBe(false);
    }, 120_000);
});

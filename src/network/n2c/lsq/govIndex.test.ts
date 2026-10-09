// Bug 389: the pulser snapshot reads DRep anchors "as of the epoch's boundary block"; once that block was
// immutable (below the index base) the index answered with the immutable tip's facts, so an anchor updated
// after the boundary leaked into GetGovState (preview 2026-10-09, DRep 1cf23799…, 63/64 parity).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbor, CborArray, CborBytes, CborMap, CborText, CborUInt } from "@harmoniclabs/cbor";
import { GovIndex, credKey } from "./govIndex";
import { setEpochNetwork } from "../../../utils/epochFromSlotCalculations";

const DREP = "1cf23799b2104ad911416d492a8163cf9c8006fdcfa6d34c3074b179";
const hashOf = (n: number) => new Uint8Array(32).fill(n);
const anchor = (url: string) => new CborArray([new CborText(url), new CborBytes(new Uint8Array(32).fill(url.length))]);
const cred = () => new CborArray([new CborUInt(0), new CborBytes(Buffer.from(DREP, "hex"))]);
/** `[eraTag 7, [header, [txBody], [], {}, []]]` with one certificate. */
function block(cert: CborArray): Uint8Array {
    const body = new CborMap([{ k: new CborUInt(4), v: new CborArray([cert]) }]);
    const blk = new CborArray([new CborArray([]), new CborArray([body]), new CborArray([]), new CborMap([]), new CborArray([])]);
    return Cbor.encode(new CborArray([new CborUInt(7), blk])).toBuffer();
}
const reg = (url: string) => block(new CborArray([new CborUInt(16), cred(), new CborUInt(500_000_000), anchor(url)]));
const upd = (url: string) => block(new CborArray([new CborUInt(18), cred(), anchor(url)]));

// preview geometry: 86 400 slots per epoch
const A = { slot: 1445 * 86400 + 100, hash: hashOf(1), bytes: reg("https://x/Maci") };
const B = { slot: 1445 * 86400 + 86000, hash: hashOf(2), bytes: block(new CborArray([new CborUInt(0), cred()])) }; // last block of 1445
const C = { slot: 1446 * 86400 + 5000, hash: hashOf(3), bytes: upd("https://x/Jeff") }; // anchor update in 1446

function fakeStore(blocks: typeof A[]) {
    return {
        immutableTip: async () => ({ slot: blocks[blocks.length - 1]!.slot, hash: blocks[blocks.length - 1]!.hash }),
        chunks: { async *iterate(from: number, to: number) { for (const b of blocks) if (b.slot >= from && b.slot <= to) yield b; } },
        volatileChain: () => [],
    } as never;
}
const urlOf = (a: Uint8Array | null | undefined): string | null => (a ? ((Cbor.parse(a) as CborArray).array[0] as CborText).text : null);

const dir = mkdtempSync(join(tmpdir(), "gov-index-"));
beforeAll(() => { setEpochNetwork("preview"); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("GovIndex facts at an immutable epoch boundary (bug 389)", () => {
    test("the boundary block answers with the anchor as of the boundary, not the tip's", async () => {
        const ix = new GovIndex(fakeStore([A, B, C]), 0, join(dir, "cache.json"));
        const key = credKey(0, DREP);
        expect(urlOf((await ix.at(Buffer.from(C.hash).toString("hex"), C.slot)).drepAnchor.get(key))).toBe("https://x/Jeff");
        expect(urlOf((await ix.at(Buffer.from(B.hash).toString("hex"), B.slot)).drepAnchor.get(key))).toBe("https://x/Maci");
    });

    test("the boundary facts survive a restart through the cache", async () => {
        const path = join(dir, "cache2.json");
        const first = new GovIndex(fakeStore([A, B, C]), 0, path);
        await first.at(Buffer.from(C.hash).toString("hex"), C.slot); // walks A, B, C and writes the cache (first save)
        // a store whose chunks yield nothing: everything must come from the cache
        const empty = { immutableTip: async () => ({ slot: C.slot, hash: C.hash }), chunks: { async *iterate() {} }, volatileChain: () => [] } as never;
        const again = new GovIndex(empty, 0, path);
        expect(urlOf((await again.at(Buffer.from(B.hash).toString("hex"), B.slot)).drepAnchor.get(credKey(0, DREP)))).toBe("https://x/Maci");
    });
});

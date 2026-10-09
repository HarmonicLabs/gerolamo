import { describe, expect, test } from "bun:test";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { localRollForwardMessage } from "./blockHeaderParser";
import { EquivocationDetector, type EquivocationRecord } from "./equivocation";
import { preferByTieBreak, tieBreakInfoOf } from "./tieBreak";
import { runHeaderValidationJob } from "./workers/validationJob";
import { issueOperationalCert, loadColdSigningKey, loadKesSigningKey, loadVrfSigningKey, poolIdOf } from "../pool/keystore";
import { EMPTY_BODY, forgeBlock } from "../pool/forge";

const F = (n: string) => new URL(`../pool/__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const nonceHex = "aa72206c1e2884c06e32970f7d383c59f28b2046434c5bb456c105f344ca154c"; // preview epoch 333 η0
const config = { networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", network: "preview" };
const h = (c: string) => c.repeat(64);

describe("equivocation detector (455)", () => {
    test("two different headers from one pool in one slot are reported once; repeats and other pools are not", () => {
        const seen: unknown[] = [];
        const d = new EquivocationDetector({ onEquivocation: (r) => seen.push(r) });
        d.setSelfPoolId("bb".repeat(28));
        const pool = "aa".repeat(28);
        expect(d.observe({ slot: 100n, hash: h("1"), poolId: pool, opcertCounter: 3, source: "peerA" })).toBeNull();
        // the same header again (every verifier re-delivers every header): nothing
        expect(d.observe({ slot: 100n, hash: h("1"), poolId: pool, opcertCounter: 3, source: "peerB" })).toBeNull();
        // another pool in the same slot (a slot battle): nothing
        expect(d.observe({ slot: 100n, hash: h("2"), poolId: "cc".repeat(28), source: "peerB" })).toBeNull();
        // our pool's block at the same slot number as theirs, different pool: nothing
        expect(d.observe({ slot: 100n, hash: h("3"), poolId: "bb".repeat(28), source: "self" })).toBeNull();
        // the same pool, same slot, a different header: equivocation
        const r = d.observe({ slot: 100n, hash: h("4"), poolId: pool.toUpperCase(), opcertCounter: 4, source: "peerC" });
        expect(r).toMatchObject({ slot: "100", poolId: pool, self: false, hashes: [h("1"), h("4")], sources: ["peerA", "peerC"], opcertCounters: ["3", "4"] });
        // the competitor again from another peer: already reported
        expect(d.observe({ slot: 100n, hash: h("4"), poolId: pool, source: "peerD" })).toBeNull();
        // a third distinct header in that slot: a second pair
        expect(d.observe({ slot: 100n, hash: h("5"), poolId: pool, source: "peerD" })).not.toBeNull();
        // same pool, different slot: fine
        expect(d.observe({ slot: 101n, hash: h("6"), poolId: pool, source: "peerA" })).toBeNull();
        const st = d.stats();
        expect(st.total).toBe(2);
        expect(st.self).toBe(0);
        expect(st.recent).toHaveLength(2);
        expect(seen).toHaveLength(2);
    });

    test("our own pool's key in two headers for one slot is flagged as self", () => {
        const d = new EquivocationDetector();
        const ours = "bb".repeat(28);
        d.setSelfPoolId(ours);
        d.observe({ slot: 7n, hash: h("a"), poolId: ours, source: "self" });
        const r = d.observe({ slot: 7n, hash: h("b"), poolId: ours, source: "peerX" });
        expect(r?.self).toBe(true);
        expect(d.stats()).toMatchObject({ total: 1, self: 1 });
    });

    test("memory is bounded: the oldest (slot, pool) entries are forgotten", () => {
        const d = new EquivocationDetector({ trackMax: 3 });
        for (let s = 0n; s < 5n; s++) d.observe({ slot: s, hash: h("1"), poolId: "aa".repeat(28), source: "p" });
        expect(d.stats().tracked).toBe(3);
        // slot 0 was evicted: a different header there is a new first sighting, not a pair
        expect(d.observe({ slot: 0n, hash: h("2"), poolId: "aa".repeat(28), source: "p" })).toBeNull();
        expect(d.observe({ slot: 4n, hash: h("2"), poolId: "aa".repeat(28), source: "p" })).not.toBeNull();
    });

    test("real forged headers: both pass the header validation job, the detector pairs them, chain selection still ranks them by opcert counter", async () => {
        const slot = 333n * 86400n + 4242n;
        const cold = loadColdSigningKey(F("cold.skey"));
        const vrf = loadVrfSigningKey(F("vrf.skey"));
        const kesPeriod = slot / 129600n;
        const forge = (prevByte: number, counter: bigint) => {
            const kes = loadKesSigningKey(F("kes.skey"));
            const { opcert } = issueOperationalCert(kes.vkey, { next: counter, coldVkey: cold.vkey }, kesPeriod, cold);
            return forgeBlock({
                era: 6, blockNumber: 1_000n, slot, prevHash: new Uint8Array(32).fill(prevByte), nonce: Uint8Array.from(Buffer.from(nonceHex, "hex")), coldVkey: cold.vkey, vrf, kes, opcert: opcert.cert,
                protocolVersion: { major: 8, minor: 0 }, slotsPerKESPeriod: 129600n, body: EMPTY_BODY,
            });
        };
        const a = forge(1, 0n), b = forge(2, 1n); // same slot, same cold key, different parents (and a re-keyed certificate)
        const d = new EquivocationDetector();
        const found: EquivocationRecord[] = [];
        for (const [blk, peer] of [[a, "peerA"], [b, "peerB"]] as const) {
            const r = await runHeaderValidationJob({ rollForward: localRollForwardMessage(blk.blockFetchBytes).bytes, nonceHex, config });
            expect(r.ok).toBe(true);
            expect(r.shelley?.issuerHash).toBe(poolIdOf(cold.vkey));
            // exactly what ConsensusOrchestrator.noteEquivocationCandidate feeds the detector
            const rec = d.observe({ slot: BigInt(r.slot), hash: r.hashHex, poolId: r.shelley!.issuerHash, vrfKeyHash: r.shelley!.vrfKeyHash, opcertCounter: r.shelley!.opcertCounter, source: peer });
            if (rec) found.push(rec);
        }
        expect(found).toHaveLength(1);
        expect(found[0]!.hashes).toEqual([Buffer.from(a.headerHash).toString("hex"), Buffer.from(b.headerHash).toString("hex")]);
        expect(found[0]!.opcertCounters).toEqual(["0", "1"]);
        // the self-forged path (adoptLocalBlock) derives the same pool id from the raw header
        const tb = tieBreakInfoOf(b.headerBytes)!;
        expect(Buffer.from(blake2b_224(Buffer.from(tb.issuer, "hex"))).toString("hex")).toBe(poolIdOf(cold.vkey));
        // not invalid: Praos chain selection prefers the higher opcert counter for a same-slot, same-issuer pair
        expect(preferByTieBreak(tieBreakInfoOf(a.headerBytes)!, tieBreakInfoOf(b.headerBytes)!)).toBe("b");
    }, 30_000);
});

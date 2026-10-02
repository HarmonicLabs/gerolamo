import { describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import chain from "./__fixtures__/preprod-byron-chain.json";
import preprodGenesis from "../../config/preprod/byron-genesis.json";
import { splitEraBlock } from "../bodyHash";
import { byronKeyHash, type ByronDelegationCertificate } from "./ByronCrypto";
import {
    applyByronBoundary,
    applyByronMainBlock,
    byronBoundaryFacts,
    byronLedgerConfigFromGenesis,
    byronMainBlockFacts,
    byronTransitionEpoch,
    decodeByronLedger,
    delegatorOf,
    encodeByronLedgerCore,
    encodeByronLedgerTip,
    initialByronLedgerState,
    initialDelegationState,
    tickByronLedger,
    tickDelegation,
    updateDelegation,
    type ByronLedgerConfig,
    type ByronLedgerState,
} from "./ByronLedger";
import { pvKey } from "./ByronUpdate";

const cfg = byronLedgerConfigFromGenesis(preprodGenesis);
const k = cfg.k; // 2160

/** Every block of the preprod Byron era through tick + apply, as the node steps it. */
function replayPreprod(c: ByronLedgerConfig = cfg): { st: ByronLedgerState; errors: string[]; adoptions: string[]; knownAt: bigint | null; states: ByronLedgerState[] } {
    let st = initialByronLedgerState(c);
    const errors: string[] = [], adoptions: string[] = [], states: ByronLedgerState[] = [];
    let knownAt: bigint | null = null;
    for (const b of chain.blocks) {
        const { era, rawBlock } = splitEraBlock(fromHex(b.hex));
        if (era === 0) {
            const r = applyByronBoundary(c, st, byronBoundaryFacts(rawBlock, c.epochSlots));
            errors.push(...r.errors);
            st = r.state;
        } else {
            const f = byronMainBlockFacts(rawBlock, c.epochSlots);
            const ticked = tickByronLedger(c, st, f.slot);
            if (ticked.update.adoptedProtocolVersion !== st.update.adoptedProtocolVersion) adoptions.push(`${pvKey(ticked.update.adoptedProtocolVersion)}@${f.slot / c.epochSlots}`);
            const r = applyByronMainBlock(c, ticked, f);
            errors.push(...r.errors);
            st = r.state;
        }
        if (knownAt == null && byronTransitionEpoch(c, st, 2) != null) knownAt = st.lastSlot;
        states.push(st);
    }
    return { st, errors, adoptions, knownAt, states };
}

describe("Byron ledger: the real preprod Byron era", () => {
    test("46 blocks, signatures checked: no rule failure, 1.0.0 adopted at epoch 2, Shelley transition at epoch 4", () => {
        const { st, errors, adoptions, knownAt } = replayPreprod();
        expect(errors).toEqual([]);
        expect(adoptions).toEqual(["1.0.0@2"]);
        expect(st.tipBlockNo).toBe(45n); // the epoch-0 EBB is block 0, the 45 main blocks 1..45
        expect(st.update.candidateProtocolUpdates.map((c) => `${pvKey(c.protocolVersion)}@${c.slot}`)).toEqual(["2.0.0@56163"]);
        // candidate at slot 56163: stable 2k = 4320 slots later; succ (epoch (56163 + 4k)) = 4
        expect(knownAt).toBe(60486n);
        expect(byronTransitionEpoch(cfg, st, 2)).toBe(BigInt(chain.firstShelleySlot) / cfg.epochSlots);
        // the hard fork's tick into the first Shelley slot adopts 2.0.0 (the candidate missed epoch 3 by 3 slots)
        expect(pvKey(tickByronLedger(cfg, st, BigInt(chain.firstShelleySlot)).update.adoptedProtocolVersion)).toBe("2.0.0");
        expect(pvKey(tickByronLedger(cfg, st, 3n * cfg.epochSlots).update.adoptedProtocolVersion)).toBe("1.0.0");
    });

    test("the persisted form reads back as the same state after every block", () => {
        for (const s of replayPreprod().states) {
            const back = decodeByronLedger(encodeByronLedgerCore(s), encodeByronLedgerTip(s));
            expect(encodeByronLedgerCore(back)).toBe(encodeByronLedgerCore(s));
            expect(back.lastSlot).toBe(s.lastSlot);
            expect(back.tipBlockNo).toBe(s.tipBlockNo);
        }
        // a state restored mid-way continues exactly like the original
        const all = replayPreprod().states;
        const mid = decodeByronLedger(encodeByronLedgerCore(all[20]!), encodeByronLedgerTip(all[20]!));
        let st = mid;
        for (const b of chain.blocks.slice(21)) {
            const { era, rawBlock } = splitEraBlock(fromHex(b.hex));
            expect(era).toBe(1);
            const f = byronMainBlockFacts(rawBlock, cfg.epochSlots);
            st = applyByronMainBlock(cfg, tickByronLedger(cfg, st, f.slot), f).state;
        }
        expect(encodeByronLedgerCore(st)).toBe(encodeByronLedgerCore(all[all.length - 1]!));
    });

    test("the EBB moves cvsLastSlot to its epoch's first slot and the boundary limit is 2·10⁶ bytes", () => {
        const { rawBlock } = splitEraBlock(fromHex(chain.blocks[0]!.hex));
        const f = byronBoundaryFacts(rawBlock, cfg.epochSlots);
        expect(f.slot).toBe(0n);
        expect(f.blockNo).toBe(0n);
        const st = initialByronLedgerState(cfg);
        expect(applyByronBoundary(cfg, { ...st, lastSlot: 5n }, { slot: 21600n, blockNo: 3n, blockSize: 100 }).state.lastSlot).toBe(21600n);
        expect(applyByronBoundary(cfg, st, { ...f, blockSize: 2_000_001 }).errors).toEqual(["ChainValidationBoundaryTooLarge 2000001"]);
    });

    test("header and block size limits read the adopted parameters after the tick", () => {
        const { rawBlock } = splitEraBlock(fromHex(chain.blocks[1]!.hex));
        const f = byronMainBlockFacts(rawBlock, cfg.epochSlots);
        const st = initialByronLedgerState(cfg);
        const small = { ...st, update: { ...st.update, adoptedProtocolParameters: { ...st.update.adoptedProtocolParameters, maxHeaderSize: BigInt(f.headerSize - 1), maxBlockSize: BigInt(f.blockSize - 1) } } };
        const r = applyByronMainBlock(cfg, tickByronLedger(cfg, small, f.slot), f);
        expect(r.errors).toEqual([`ChainValidationHeaderTooLarge ${f.headerSize - 1} ${f.headerSize}`, `ChainValidationBlockTooLarge ${f.blockSize - 1} ${f.blockSize}`]);
        // a failing block moves the slot and block number, never the update / delegation state
        expect(r.state.lastSlot).toBe(f.slot);
        expect(r.state.update).toBe(small.update);
        const exact = { ...st, update: { ...st.update, adoptedProtocolParameters: { ...st.update.adoptedProtocolParameters, maxHeaderSize: BigInt(f.headerSize), maxBlockSize: BigInt(f.blockSize) } } };
        expect(applyByronMainBlock(cfg, tickByronLedger(cfg, exact, f.slot), f).errors).toEqual([]);
    });
});

// ───────────────────────────── delegation ─────────────────────────────

const xpub = (seed: number) => new Uint8Array(64).fill(seed);
const kh = (seed: number) => byronKeyHash(xpub(seed));
function cert(issuer: number, delegate: number, epoch: bigint): ByronDelegationCertificate {
    return { epoch, issuerXPub: xpub(issuer), delegateXPub: xpub(delegate), signature: new Uint8Array(64) };
}
const synth: ByronLedgerConfig = { ...cfg, genesisKeys: new Set([kh(1), kh(2), kh(3)]), genesisCerts: [cert(1, 11, 0n), cert(2, 12, 0n), cert(3, 13, 0n)], skipSignatures: true };
const denv = (slot: bigint) => ({ protocolMagic: synth.protocolMagic, allowedDelegators: synth.genesisKeys, k, currentEpoch: slot / synth.epochSlots, currentSlot: slot, skipSignatures: true });

describe("Byron ledger: delegation (Delegation.Validation.*)", () => {
    test("initial state: the genesis certificates are active at slot 0; their epoch pairs pruned in epoch 1", () => {
        const d = initialDelegationState(synth);
        expect([...d.map]).toEqual([[kh(1), kh(11)], [kh(2), kh(12)], [kh(3), kh(13)]]);
        expect(d.scheduled).toEqual([]);
        expect(d.keyEpochs.size).toBe(3);
        expect(tickDelegation(0n, 100n, d)).toBe(d); // nothing due: same object
        expect(tickDelegation(1n, synth.epochSlots, d).keyEpochs.size).toBe(0);
    });

    test("a certificate activates 2k slots later; the update rules see the map before it", () => {
        const d0 = initialDelegationState(synth);
        // epoch 0 is taken by the genesis certificate: the next one is for epoch 1
        expect(() => updateDelegation(denv(1000n), d0, [cert(1, 21, 0n)])).toThrow(/MultipleDelegationsForEpoch/);
        const d1 = updateDelegation(denv(1000n), d0, [cert(1, 21, 1n)]);
        expect(d1.scheduled).toEqual([{ slot: 1000n + 2n * BigInt(k), delegator: kh(1), delegate: kh(21) }]);
        expect(d1.map.get(kh(1))).toBe(kh(11));
        expect(tickDelegation(0n, 1000n + 2n * BigInt(k) - 1n, d1).map.get(kh(1))).toBe(kh(11));
        const d2 = tickDelegation(0n, 1000n + 2n * BigInt(k), d1);
        expect(d2.map.get(kh(1))).toBe(kh(21));
        expect(d2.scheduled).toEqual([]);
        expect(delegatorOf(d2, kh(21))).toBe(kh(1));
        expect(delegatorOf(d2, kh(11))).toBeUndefined();
    });

    test("scheduling rejections: non-genesis delegator, wrong epoch, twice per epoch, twice per slot", () => {
        const d0 = initialDelegationState(synth);
        expect(() => updateDelegation(denv(1000n), d0, [cert(9, 21, 0n)])).toThrow(/NonGenesisDelegator/);
        expect(() => updateDelegation(denv(1000n), d0, [cert(1, 21, 2n)])).toThrow(/WrongEpoch/);
        expect(() => updateDelegation(denv(synth.epochSlots + 5n), d0, [cert(1, 21, 0n)])).toThrow(/WrongEpoch/);
        // the genesis certificates already used (epoch 0, delegator) in epoch 0
        expect(() => updateDelegation(denv(1000n), { ...d0, keyEpochs: new Set([`0|${kh(1)}`]) }, [cert(1, 21, 0n)])).toThrow(/MultipleDelegationsForEpoch/);
        expect(() => updateDelegation(denv(1000n), { ...d0, keyEpochs: new Set() }, [cert(1, 21, 0n), cert(1, 22, 1n)])).toThrow(/MultipleDelegationsForSlot/);
        // the input state is untouched by a failure
        expect(d0.scheduled).toEqual([]);
        // a bad signature when signatures are checked
        expect(() => updateDelegation({ ...denv(1000n), skipSignatures: false }, { ...d0, keyEpochs: new Set() }, [cert(1, 21, 0n)])).toThrow(/InvalidCertificate/);
    });

    test("activation is skipped for a delegate already delegating for another key", () => {
        const d0 = { ...initialDelegationState(synth), keyEpochs: new Set<string>() };
        const d1 = updateDelegation(denv(1000n), d0, [cert(1, 12, 1n)]); // kh(12) is kh(2)'s delegate
        const d2 = tickDelegation(0n, 1000n + 2n * BigInt(k), d1);
        expect(d2.map.get(kh(1))).toBe(kh(11));
    });
});

// ───────────────────────────── transition ─────────────────────────────

describe("Byron ledger: byronTransition (ByronHFC)", () => {
    const base = initialByronLedgerState(cfg);
    const withCandidate = (slot: bigint, major: number, lastSlot: bigint, tipBlockNo: bigint | null, becameAt?: bigint): ByronLedgerState => ({
        ...base,
        lastSlot,
        tipBlockNo,
        update: { ...base.update, candidateProtocolUpdates: [{ slot, protocolVersion: { major, minor: 0, alt: 0 }, protocolParameters: base.update.adoptedProtocolParameters }] },
        transition: becameAt === undefined ? new Map() : new Map([[`${major}.0.0`, becameAt]]),
    });

    test("stable after 2k slots: succ (epoch (slot + 4k))", () => {
        expect(byronTransitionEpoch(cfg, withCandidate(56163n, 2, 56163n + 4319n, 40n), 2)).toBeNull();
        expect(byronTransitionEpoch(cfg, withCandidate(56163n, 2, 56163n + 4320n, 40n), 2)).toBe(4n);
        // slot + 4k exactly on a boundary: the next epoch after it (cpuEpoch = succ)
        expect(byronTransitionEpoch(cfg, withCandidate(3n * 21600n - 4n * 2160n, 2, 3n * 21600n, 40n), 2)).toBe(4n);
    });

    test("or k blocks past the block that made it a candidate; a different major never counts", () => {
        expect(byronTransitionEpoch(cfg, withCandidate(1000n, 2, 1100n, 100n + BigInt(k) - 1n, 100n), 2)).toBeNull();
        expect(byronTransitionEpoch(cfg, withCandidate(1000n, 2, 1100n, 100n + BigInt(k), 100n), 2)).toBe(1n);
        expect(byronTransitionEpoch(cfg, withCandidate(1000n, 1, 1000n + 99999n, 9999n, 0n), 2)).toBeNull();
    });

    test("the transition info records the block in which a candidate appeared and drops it once adopted", () => {
        const { states } = replayPreprod();
        const at = states.find((s) => s.transition.size > 0)!;
        expect([...at.transition]).toEqual([["1.0.0", 8n]]);
        const last = states[states.length - 1]!;
        expect([...last.transition]).toEqual([["2.0.0", 30n]]);
    });
});

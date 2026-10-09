/**
 * Test support for BlockProducer tests (not used by the node): fixture keys, a fake node whose
 * `adopt` runs our own header validator, and transactions from a real preview block.
 */
import { join } from "node:path";
import { BabbageHeader, MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborArray, CborSimple, LazyCborArray } from "@harmoniclabs/cbor";
import { validateHeader } from "../consensus/BlockHeaderValidator";
import { blockFetchHeaderIdentity } from "../consensus/blockHeaderParser";
import { splitEraBlock, verifyBlockBodyHash } from "../consensus/bodyHash";
import type { ProducerNode } from "./BlockProducer";
import { encodeOperationalCert, issueOperationalCert, loadColdSigningKey, loadKesSigningKey, writeTextEnvelope } from "./keystore";
import { leaderSlotsForEpoch } from "./leaderSchedule";

export const F = (n: string) => new URL(`./__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
export const nonceHex = "aa72206c1e2884c06e32970f7d383c59f28b2046434c5bb456c105f344ca154c"; // preview epoch 333
export const EPOCH = 333, FIRST = 333n * 86400n;
export const PERIOD = FIRST / 129600n;
export const genesis = { activeSlotsCoeff: 0.05, slotsPerKESPeriod: 129600, maxKESEvolutions: 62 };
export const headerConfig = { networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", network: "preview" };

/** File-mode producer keys: cli fixtures plus an opcert (counter 0) for the test epoch's KES period. */
export function keyFiles(dir: string) {
    const cold = loadColdSigningKey(F("cold.skey"));
    const kes = loadKesSigningKey(F("kes.skey"));
    const { opcert } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, PERIOD, cold);
    const opcertFile = join(dir, "node.cert");
    writeTextEnvelope(opcertFile, encodeOperationalCert(opcert));
    return { coldVkeyFile: F("cold.vkey"), kesSkeyFile: F("kes.skey"), vrfSkeyFile: F("vrf.skey"), opcertFile, stateFile: join(dir, "producer-state.json") };
}

export interface FakeNodeOpts {
    /** Mempool contents offered for every block. */
    txs?: Uint8Array[];
    /** adopt applies the block (tip moves, block counted) and then throws: an error after the block went out. */
    applyThenThrow?: boolean;
    /** Called with each block before it is checked. */
    onAdopt?: (bytes: Uint8Array) => void;
}

/** A fake node: schedule over `window` slots of epoch 333 (σ = 1), adopt = our own header validator. */
export function fakeNode(clock: { now: number }, window: bigint, adopted: Uint8Array[], o: FakeNodeOpts = {}): ProducerNode & { tipRef: { slot: bigint; blockNumber: bigint; hashHex: string } } {
    const tipRef = { slot: FIRST - 3n, blockNumber: 1_000_000n, hashHex: "11".repeat(32) };
    return {
        tipRef,
        network: "preview", era: 6, genesis, now: () => clock.now,
        nonceFor: async (e) => (e === EPOCH ? nonceHex : null),
        sigmaFor: async () => ({ num: 1n, den: 1n }),
        tip: async () => ({ ...tipRef }),
        protocolVersion: async () => ({ major: 8, minor: 0 }),
        maxBlockBodySize: async () => 90_112,
        lastOnChainOpcertCounter: async () => null,
        mempoolTxs: async () => (o.txs ?? []).map((bytes, i) => ({ hash: new Uint8Array(32).fill(i + 1), bytes })),
        dropFromMempool: async () => {},
        adopt: async (bytes) => {
            o.onAdopt?.(bytes);
            const id = blockFetchHeaderIdentity(bytes);
            const hdr = BabbageHeader.fromCbor(id.rawHeaderBytes);
            if (!(await validateHeader(new MultiEraHeader({ era: 6, header: hdr }), Uint8Array.from(Buffer.from(nonceHex, "hex")), headerConfig))) throw new Error("header invalid");
            if (!verifyBlockBodyHash(bytes).ok) throw new Error("body hash");
            if (Buffer.from(hdr.body.prevHash!).toString("hex") !== tipRef.hashHex) throw new Error("does not extend tip");
            adopted.push(bytes);
            Object.assign(tipRef, { slot: hdr.body.slot, blockNumber: hdr.body.blockNumber, hashHex: Buffer.from(id.hash).toString("hex") });
            if (o.applyThenThrow) throw new Error("tx[0]: simulated failure after the block was applied");
        },
        schedule: async ({ epoch, nonceHex: n, sigma, vrf }) => leaderSlotsForEpoch({ epoch, nonceHex: n, sigma, activeSlotsCoeff: 0.05, vrf, network: "preview", fromSlot: FIRST, toSlot: FIRST + window }),
    };
}

/** Whole transactions ([body, witnesses, valid, aux]) from a real preview block, for a fake mempool. */
export async function fixtureTxs(): Promise<Uint8Array[]> {
    const hex = (await Bun.file(new URL("../consensus/__fixtures__/preview-block-11663879.hex", import.meta.url)).text()).trim();
    const { rawBlock } = splitEraBlock(Uint8Array.from(Buffer.from(hex, "hex")));
    const lazy = Cbor.parseLazy(rawBlock) as LazyCborArray;
    const [, bodiesRaw, witsRaw, auxRaw, invalidRaw] = lazy.array;
    const bodies = (Cbor.parseLazy(bodiesRaw!) as LazyCborArray).array;
    const wits = (Cbor.parseLazy(witsRaw!) as LazyCborArray).array;
    const aux = Cbor.parse(auxRaw!) as any;
    const auxByIx = new Map<number, Uint8Array>();
    for (const e of aux.map) auxByIx.set(Number(e.k.num), Cbor.encode(e.v).toBuffer());
    const invalid = new Set(((Cbor.parse(invalidRaw!) as CborArray).array as any[]).map((x) => Number(x.num)));
    return bodies.map((b, i) => {
        const parts = [b, wits[i]!, Cbor.encode(new CborSimple(!invalid.has(i))).toBuffer(), auxByIx.get(i) ?? new Uint8Array([0xf6])];
        const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0)); out[0] = 0x84;
        let off = 1; for (const p of parts) { out.set(p, off); off += p.length; }
        return out;
    });
}

/** Leader slots of the fake node's window for a producer (sorted). */
export function leadersOf(producer: unknown): bigint[] {
    return [...(producer as any).leaderSlots.keys()].map(BigInt).sort((a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0));
}

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MultiEraBlock, TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { blockFacts, shelleyTxFacts, txCbor, txFactsOfCbor } from "./blockFacts";
import { redeemerScriptHash } from "./writer";
import { outputLike } from "../../consensus/rules/blockRulesPure";
import { epochParamsFromRecord } from "../../consensus/epochParams";
import { evaluatePhase2Sync } from "../../consensus/rules/phase2";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";
import type { ResolvedUtxo } from "../../consensus/rules/resolvedUtxo";
import { hex } from "./cborWalk";

const FIX = join(import.meta.dir, "../../consensus/__fixtures__");
const blockFiles = readdirSync(FIX).filter((f) => f.endsWith(".hex") && f.includes("-block-"));

describe("blockFacts on real preview / preprod blocks", () => {
    test("transaction hashes, fees, outputs and certificates equal the ledger library's decoding", () => {
        expect(blockFiles.length).toBeGreaterThanOrEqual(20);
        for (const f of blockFiles) {
            const bytes = Uint8Array.from(Buffer.from(readFileSync(join(FIX, f), "utf8").trim(), "hex"));
            const facts = blockFacts(bytes);
            const lib: any = MultiEraBlock.fromCbor(bytes);
            const bodies: any[] = lib.block.transactionBodies ?? [];
            expect(facts.txs.map((t) => t.hash)).toEqual(bodies.map((b) => b.hash.toString()));
            expect(facts.txs.map((t) => t.fee)).toEqual(bodies.map((b) => BigInt(b.fee)));
            expect(facts.txs.map((t) => t.outputs.length)).toEqual(bodies.map((b) => (b.outputs ?? []).length));
            expect(facts.txs.map((t) => t.certs.length)).toEqual(bodies.map((b) => (b.certs ?? []).length));
            expect(facts.blockNo).toBe(Number(lib.block.header.body.blockNumber));
            expect(facts.slot).toBe(Number(lib.block.header.body.slot));
            expect(facts.opCertCounter).toBe(Number(lib.block.header.body.opCert.sequenceNumber));
            // the transaction CBOR rebuilt from the block parts decodes back to the same facts
            for (const t of facts.txs) expect(txFactsOfCbor(txCbor(t, facts.era), facts.era).hash).toBe(t.hash);
        }
    });
});

describe("blockFacts on a Byron main block", () => {
    test("mainnet's first transaction: id, base58 output address, amount, chain height and delegate key", async () => {
        const { getByronTxPayloads } = await import("../../utils/eraAccessors");
        const j = JSON.parse(readFileSync(join(FIX, "byron-mainnet-first-tx.json"), "utf8"));
        const bytes = Uint8Array.from(Buffer.from(j.block, "hex"));
        const f = blockFacts(bytes);
        expect(f.era).toBe(1);
        expect(f.blockNo).toBe(3314);
        expect(f.leader).toMatch(/^[0-9a-f]{56}$/);
        const lib: any = getByronTxPayloads((MultiEraBlock.fromCbor(bytes) as any).block);
        expect(f.txs.map((t) => t.hash)).toEqual(lib.map((p: any) => String(p.tx.hash.call ? p.tx.hash.call(p.tx) : p.tx.hash)));
        expect(f.txs[0]!.outputs.map((o) => [o.address.slice(0, 6), o.lovelace])).toEqual([["DdzFFz", 1_000_000n]]);
        expect(f.txs[0]!.byron).toBe(true);
    });
});

function loadJob(name: string) {
    const job = JSON.parse(readFileSync(join(FIX, name), "utf8"));
    setEpochNetwork(job.network);
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [ref, h] of job.resolved as Array<[string, string]>) {
        const o = outputLike(TxOut.fromCbor(h));
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    }
    return { job, resolved };
}

describe("redeemer script hashes (Blockfrost script_hash) agree with the phase-2 evaluator", () => {
    for (const f of readdirSync(FIX).filter((x) => x.startsWith("plutus-preview-") && x.endsWith(".json"))) {
        test(f, async () => {
            const { job, resolved } = loadJob(f);
            const tx = shelleyTxFacts(0, Buffer.from(job.bodyHex, "hex"), Buffer.from(job.witnessHex, "hex"), null, job.valid, job.era);
            expect(tx.hash).toBe(job.txHash);
            const r = evaluatePhase2Sync({ era: job.era, bodyBytes: tx.body, witnessSetBytes: tx.witness, resolved, params: epochParamsFromRecord(0, job.params), markedInvalid: !job.valid });
            // a stand-in for the projection: spent outputs' addresses from the resolved set
            const db: any = (strings: TemplateStringsArray, ...v: unknown[]) => {
                const q = strings.join("?");
                const out = q.includes("FROM mb_tx_out") ? [[null, resolved.get(`${v[0]}:${v[1]}`)?.address ?? ""]] : [];
                return Object.assign(Promise.resolve(out), { values: () => Promise.resolve(out) });
            };
            for (const x of r.redeemers) expect(await redeemerScriptHash(db, tx, x.tag, x.index)).toBe(x.scriptHash);
            expect(r.redeemers.length).toBe(tx.redeemers.length);
            void hex;
        });
    }
});

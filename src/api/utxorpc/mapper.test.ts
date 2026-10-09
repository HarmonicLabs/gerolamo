import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { cardano } from "@utxorpc/spec";
import { bigIntMsg, bigIntValue, blockHeaderFacts, blockTxs, plutusDataFromBytes, txFromBytes, txIdOf } from "./mapper";
import { pparamsFromRecord, genesisMsg } from "./params";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { getByronTxPayloads } from "../../utils/eraAccessors";

const FIX = new URL("../../consensus/__fixtures__/", import.meta.url).pathname;
const blockFixtures = readdirSync(FIX).filter((f) => /^(preview|preprod)-block-\d+\.hex$/.test(f)).sort();
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const len = (v: any): number => (Array.isArray(v) ? v.length : Array.isArray(v?.map) ? v.map.length : v ? 1 : 0);

describe("CBOR → UTxO RPC Cardano messages", () => {
    test(`${blockFixtures.length} real preview / preprod blocks (Allegra to Conway) agree with cardano-ledger-ts`, () => {
        let txs = 0, outputs = 0, certs = 0, proposals = 0;
        for (const f of blockFixtures) {
            const bytes = Buffer.from(readFileSync(FIX + f, "utf8").trim(), "hex");
            const ref: any = MultiEraBlock.fromCbor(bytes);
            const bodies: any[] = ref.block.transactionBodies ?? [];
            const ours = blockTxs(bytes);
            expect(ours.length).toBe(bodies.length);
            const invalid = new Set<number>((ref.block.invalidTransactions ?? []).map(Number));
            ours.forEach((t, i) => {
                const b = bodies[i];
                const what = `${f} tx ${i}`;
                expect(t.id, what).toBe(String(b.hash.toString()));
                expect(t.msg.inputs.length, what).toBe(len(b.inputs));
                expect(t.msg.outputs.length, what).toBe(len(b.outputs));
                expect(bigIntValue(t.msg.fee), what).toBe(BigInt(b.fee));
                expect(t.msg.certificates.length, what).toBe(len(b.certs));
                expect(t.msg.withdrawals.length, what).toBe(len(b.withdrawals));
                expect(t.msg.referenceInputs.length, what).toBe(len(b.refInputs));
                expect(t.msg.collateral!.collateral.length, what).toBe(len(b.collateralInputs));
                expect(t.msg.proposals.length, what).toBe(len(b.proposalProcedures));
                expect(t.msg.successful, what).toBe(!invalid.has(i));
                const lovelace = (b.outputs as any[]).reduce((s, o) => s + BigInt(o.value.lovelaces), 0n);
                expect(t.msg.outputs.reduce((s, o) => s + bigIntValue(o.coin), 0n), what).toBe(lovelace);
                // inputs come in ledger order (sorted), each a 32-byte id
                const keys = t.msg.inputs.map((x) => `${hexOf(x.txHash)}:${String(x.outputIndex).padStart(5, "0")}`);
                expect(keys, what).toEqual([...keys].sort());
                // the standalone bytes are a transaction with the same id
                expect(hexOf(txIdOf(t.nativeBytes)), what).toBe(t.id);
                expect(hexOf(txFromBytes(t.nativeBytes).hash), what).toBe(t.id);
                txs++; outputs += t.msg.outputs.length; certs += t.msg.certificates.length; proposals += t.msg.proposals.length;
            });
            const facts = blockHeaderFacts(bytes);
            expect(facts.eraTag).toBe(bytes[1]!);
        }
        expect(txs).toBeGreaterThan(100);
        expect(outputs).toBeGreaterThan(txs);
        expect(certs + proposals).toBeGreaterThan(0);
    });

    test("Conway governance: an UpdateCommittee proposal with a 6/19 threshold (preview 64848165)", () => {
        const bytes = Buffer.from(readFileSync(FIX + "preview-block-64848165.hex", "utf8").trim(), "hex");
        const [t] = blockTxs(bytes);
        expect(t!.msg.proposals.length).toBe(5);
        const a = t!.msg.proposals[0]!.govAction!.governanceAction;
        expect(a.case).toBe("updateCommitteeAction");
        const u = a.value as cardano.UpdateCommitteeAction;
        expect(u.newCommitteeThreshold).toMatchObject({ numerator: 6, denominator: 19 });
        expect(u.newCommitteeCredentials.length).toBe(3);
        expect(u.removeCommitteeCredentials.length).toBe(0);
    });

    test("a Plutus transaction: redeemers, datums, scripts and the tx id (preview 124008114)", () => {
        const job = JSON.parse(readFileSync(FIX + "plutus-preview-124008114-0.json", "utf8"));
        const tx = Buffer.concat([Buffer.of(0x84), Buffer.from(job.bodyHex, "hex"), Buffer.from(job.witnessHex, "hex"), Buffer.of(0xf5, 0xf6)]);
        const m = txFromBytes(tx);
        expect(hexOf(m.hash)).toBe(job.txHash);
        const spends = m.inputs.filter((i) => i.redeemer);
        expect(spends.length).toBeGreaterThan(0);
        const r = spends[0]!.redeemer!;
        expect(r.purpose).toBe(cardano.RedeemerPurpose.SPEND);
        expect(r.exUnits!.steps).toBe(468052646n);
        expect(r.exUnits!.memory).toBe(1534186n);
        expect(r.originalCbor.length).toBeGreaterThan(4);
    });

    test("Byron: the first mainnet transaction (inputs, outputs, id as ledger-ts computes it), the preprod EBB has none", () => {
        const fx = JSON.parse(readFileSync(FIX + "byron-mainnet-first-tx.json", "utf8"));
        const bytes = Buffer.from(fx.block, "hex");
        const block: any = MultiEraBlock.fromCbor(bytes);
        const entries = getByronTxPayloads(block.block);
        const [t, ...rest] = blockTxs(bytes);
        expect(rest.length).toBe(entries.length - 1);
        expect(t!.id).toBe(hexOf(blake2b_256((entries[0] as any).tx.toCborBytes())));
        expect(t!.msg.inputs.length).toBe(1);
        expect(t!.msg.outputs.length).toBeGreaterThan(0);
        expect(t!.msg.outputs[0]!.address[0]).toBe(0x82); // a Byron address is its CBOR
        expect(blockHeaderFacts(bytes).height).toBeGreaterThan(0n);
        const pre = JSON.parse(readFileSync(FIX + "byron-preprod.json", "utf8"));
        const ebb = Buffer.from(pre.blocks[0], "hex");
        expect(blockTxs(ebb)).toEqual([]);
        expect(blockHeaderFacts(ebb)).toEqual({ eraTag: 0, height: null });
    });

    test("BigInt: int64 range as int, beyond as big-endian bytes", () => {
        expect(bigIntMsg(5n)!.bigInt).toEqual({ case: "int", value: 5n });
        expect(bigIntMsg((1n << 63n) - 1n)!.bigInt.case).toBe("int");
        const big = bigIntMsg(1n << 64n)!;
        expect(big.bigInt.case).toBe("bigUInt");
        expect(hexOf(big.bigInt.value as Uint8Array)).toBe("010000000000000000");
        expect(bigIntValue(big)).toBe(1n << 64n);
        expect(bigIntValue(bigIntMsg(-(1n << 70n)))).toBe(-(1n << 70n));
    });

    test("Plutus data: constructors (121…127, 1280+, 102), maps, lists, bignums", () => {
        const d = plutusDataFromBytes(Buffer.from("d8799f4568656c6c6fd905009f01ffd8669f1903e880ffa1010220c249010000000000000000ff", "hex"));
        const c = d.plutusData.value as cardano.Constr;
        expect(d.plutusData.case).toBe("constr");
        expect(c.tag).toBe(121);
        expect(c.fields.map((f) => f.plutusData.case)).toEqual(["boundedBytes", "constr", "constr", "map", "bigInt", "bigInt"]);
        expect((c.fields[1]!.plutusData.value as cardano.Constr).tag).toBe(1280);
        const alt = c.fields[2]!.plutusData.value as cardano.Constr;
        expect([alt.tag, alt.anyConstructor]).toEqual([102, 1000n]);
        expect(bigIntValue(c.fields[4]!.plutusData.value as cardano.BigInt)).toBe(-1n);
        expect((c.fields[5]!.plutusData.value as cardano.BigInt).bigInt.case).toBe("bigUInt");
    });

    test("protocol parameters from the stored record (preview epoch 841)", () => {
        const raw = JSON.parse(readFileSync(FIX + "preview-params-841.json", "utf8"));
        const p = pparamsFromRecord(raw);
        expect(bigIntValue(p.minFeeCoefficient)).toBe(BigInt(raw.min_fee_a));
        expect(bigIntValue(p.coinsPerUtxoByte)).toBe(BigInt(raw.coins_per_utxo_size));
        expect(p.maxTxSize).toBe(BigInt(raw.max_tx_size));
        expect(p.protocolVersion!.major).toBe(Number(raw.protocol_major_ver));
        expect(p.costModels!.plutusV3!.values.length).toBeGreaterThan(200);
        expect(p.poolVotingThresholds!.thresholds.length).toBe(5);
        expect(p.drepVotingThresholds!.thresholds.length).toBe(10);
    });

    test("genesis: preview files, hash of the Shelley genesis", () => {
        const g = genesisMsg({ byron: "src/config/preview/byron-genesis.json", shelley: "src/config/preview/shelley-genesis.json", alonzo: "src/config/preview/alonzo-genesis.json", conway: "src/config/preview/conway-genesis.json" });
        expect(g.caip2).toBe("cardano:preview");
        expect(g.genesis.networkMagic).toBe(2);
        expect(g.genesis.securityParam).toBe(432);
        expect(g.genesis.costModels!.plutusV1!.values.length).toBeGreaterThan(100);
        expect(g.genesis.committee).toBeDefined();
        expect(g.genesis.drepVotingThresholds!.ppGovGroup).toMatchObject({ numerator: 3, denominator: 4 });
        expect(g.hash.length).toBe(32);
    });
});

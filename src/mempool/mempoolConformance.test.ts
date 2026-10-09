/**
 * Mempool admission on Blueprint conformance vectors (cardano-ledger ImpSpec transactions with their
 * ledger state, src/conformance): bugs 403 and 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { logger, LogLevel } from "../utils/logger";
import { readFileSync } from "node:fs";
import { readTarGz } from "../conformance/tar";
import { bodyParamsOf, epochEstimate, IMP_EPOCH_LENGTH, mempoolViewOf, runVectorMempool, vectorsOf, withImpGeometry } from "../conformance/blueprint/harness";
import { decodeBlueprintLedgerState, pparamsArrayOf } from "../conformance/blueprint/ledgerState";
import { conwayPParamsToRaw } from "../mithril/nesDecoder";
import { ValidatingMempool } from "./ValidatingMempool";

const { vectors, pparams } = vectorsOf(readTarGz(new Uint8Array(readFileSync(new URL("../conformance/__vectors__/blueprint-vectors.tar.gz", import.meta.url)))));
const vector = (test: string, index: number) => vectors.find((v) => v.test === `Conway.Imp.${test}` && v.index === index)!;

describe("mempool admission (Blueprint vectors)", () => {
    // the mempool and the ChainSync host log every transaction / message at info level
    let level = LogLevel.INFO;
    beforeAll(() => { level = logger.logLevel; logger.setLogLevel(LogLevel.WARN); });
    afterAll(() => logger.setLogLevel(level));

    test("bug 403: is_valid = false without any script is rejected (ValidationTagMismatch PassedUnexpectedly)", async () => {
        for (const lang of [1, 2, 3]) {
            const v = vector(`AlonzoImpSpec.UTXOS.PlutusV${lang}.Valid transaction marked as invalid`, 0);
            expect(v.success).toBe(false);
            const r = await withImpGeometry(() => runVectorMempool(v, pparams));
            expect(r.accepted).toBe(false);
            expect(r.reasons.join(" ")).toContain("is_valid = false but every script succeeded");
        }
    });

    test("bug 404: withdrawal amounts are checked against exact balances, script accounts by their typed key", async () => {
        const wrong = vector("ConwayImpSpec - Version 10.CERTS.Withdrawals.Withdrawing the wrong amount", 6);
        const r = await withImpGeometry(() => runVectorMempool(wrong, pparams));
        expect(r.accepted).toBe(false);
        expect(r.reasons.join(" ")).toContain("WithdrawalsNotInRewardsCERTS");

        // the withdraw-zero trick from a Plutus script account: admitted, its balance read as "01" + hash
        const ok = vector("AlonzoImpSpec.UTXOW.Valid transactions.PlutusV2.Validating WITHDRAWAL script", 2);
        expect(ok.success).toBe(true);
        const asked: string[] = [];
        const accepted = await withImpGeometry(async () => {
            const s = decodeBlueprintLedgerState(ok.oldLedgerState);
            const epoch = epochEstimate(s, ok.newLedgerState ? decodeBlueprintLedgerState(ok.newLedgerState) : null);
            const view = mempoolViewOf(s, BigInt(epoch) * IMP_EPOCH_LENGTH, bodyParamsOf(epoch, conwayPParamsToRaw(pparamsArrayOf(pparams.get(s.gov.curPParamsHash)!))));
            const rewardBalances = view.rewardBalances.bind(view);
            view.rewardBalances = (creds) => { asked.push(...creds); return rewardBalances(creds); };
            return (await new ValidatingMempool({ view, rejectFailedPlutus: true }).addTx(Uint8Array.from(Buffer.from(ok.txHex, "hex")))).ok;
        });
        expect(accepted).toBe(true);
        expect(asked).toEqual(["01e9cb0fab4b34b2a1c8b62f3a4a9c33f10f63f0d47fc07ed65240a76a"]);
    });
});

import { validateHeader } from "./BlockHeaderValidator";
// import { expect, test } from "bun:test";
import { expect, test } from "bun:test";

import { default as vector } from "./test-vector.json";
import {
    BabbageHeader,
    MultiEraHeader,
    VRFKeyHash,
} from "@harmoniclabs/cardano-ledger-ts";
import { RawNewEpochState } from "../rawNES";
import { fromHex } from "@harmoniclabs/uint8array-utils";

function genTestCase(testData: unknown, i: number) {
    test(`Test case #${i}`, async () => {
        const testData = vector[i];

        expect(testData[0].vrfVKeyHash).toBeDefined();
        const vrfVKeyHash = VRFKeyHash.fromAscii(
            testData[0].vrfVKeyHash as string,
        );

        expect(testData[0].ocertCounters).toBeDefined();
        const ocs = testData[0].ocertCounters as object;
        const ocertCounters: [string, bigint][] = Object.entries(ocs).map((
            s,
        ) => [
            s[0],
            BigInt(s[1]).valueOf(),
        ]);

        expect(testData[0].praosSlotsPerKESPeriod).toBeDefined();
        const slotsPerKESPeriod = testData[0].praosSlotsPerKESPeriod as number;

        expect(testData[0].praosMaxKESEvo).toBeDefined();
        const maxKESEvo = testData[0].praosMaxKESEvo as number;

        expect(testData[1].header).toBeDefined();
        const header = BabbageHeader.fromCbor(testData[1].header as string);

        const lState = RawNewEpochState.init(0n, slotsPerKESPeriod, maxKESEvo);

        expect(testData[0].activeSlotCoeff).toBeDefined();
        const asc = testData[0].activeSlotCoeff as number;

        expect(testData[0].nonce).toBeDefined();
        const nonce = fromHex(testData[0].nonce as string);

        const sum = validateHeader(
            new MultiEraHeader({ era: 6, header }),
            lState,
            ocertCounters,
            asc,
            nonce,
        );

        const mutation = testData[1].mutation;
        expect(sum).toBe(mutation === "NoMutation");
    });
}

vector.forEach((value, index) => genTestCase(value, index));

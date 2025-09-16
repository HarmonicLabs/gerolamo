import { validateHeader } from "./BlockHeaderValidator";
// import { expect, test } from "bun:test";
import { expect, test } from "bun:test";

// import { default as vector } from "./test";
import {
    BabbageHeader,
    isKesPubKey,
    KesPubKey,
    MultiEraHeader,
    PoolOperationalCert,
    VRFKeyHash,
} from "@harmoniclabs/cardano-ledger-ts";
import { RawNewEpochState } from "../rawNES";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

const testVectorFile = Bun.file("./src/consensus/test-vector.json");
const vector = await testVectorFile.json();

function genTestCase(testData: unknown, i: number) {
    test(`Test case #${i}`, async () => {
        const testData = vector[i];
        expect(testData[0].vrfVKeyHash).toBeDefined();
        const vrfVKeyHash = VRFKeyHash.fromAscii(
            testData[0].vrfVKeyHash as string,
        );

        expect(testData[0].ocertCounters).toBeDefined();
        const ocs = testData[0].ocertCounters as object;
        const ocertCounters = Object.entries(ocs).map((
            entry: [string, bigint],
        ) => [
            entry[0],
            entry[1],
        ]);

        expect(testData[0].praosSlotsPerKESPeriod).toBeDefined();
        const slotsPerKESPeriod: bigint = BigInt(
            testData[0].praosSlotsPerKESPeriod as number,
        );

        expect(testData[0].praosMaxKESEvo).toBeDefined();
        const maxKESEvo: bigint = BigInt(testData[0].praosMaxKESEvo as number);

        expect(testData[1].header).toBeDefined();
        let header = BabbageHeader.fromCbor(testData[1].header as string);

        const lState = RawNewEpochState.init(
            0n,
            BigInt(slotsPerKESPeriod),
            BigInt(maxKESEvo),
        );

        expect(testData[0].activeSlotCoeff).toBeDefined();
        const asc = testData[0].activeSlotCoeff as number;

        expect(testData[0].nonce).toBeDefined();
        const nonce = fromHex(testData[0].nonce as string);

        const shelleyGenesisFile = Bun.file(
            "./src/config/preprod-shelley-genesis.json",
        );
        let shelleyGenesis = await shelleyGenesisFile.json();

        shelleyGenesis.activeSlotsCoeff = asc;
        shelleyGenesis.slotsPerKESPeriod = slotsPerKESPeriod;
        shelleyGenesis.maxKESEvolutions = maxKESEvo;
        shelleyGenesis.praosMaxKESEvo = maxKESEvo;
        const mutation = testData[1].mutation;
        let sequenceNumber = BigInt(ocertCounters[0][1]);
        if (mutation === "MutateCounterOver1") {
            sequenceNumber -= 1n;
        }

        const sum = await validateHeader(
            new MultiEraHeader({ era: 6, header }),
            nonce,
            shelleyGenesis,
            lState,
            sequenceNumber,
        );
        expect(sum).toBe(mutation === "NoMutation");
    });
}

vector.forEach((value, index) => genTestCase(value, index));

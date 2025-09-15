import { validateHeader } from "./BlockHeaderValidator";
// import { expect, test } from "bun:test";
import { expect, test } from "bun:test";

// import { default as vector } from "./test";
import {
    BabbageHeader,
    MultiEraHeader,
    VRFKeyHash,
    KesPubKey,
    isKesPubKey,
    PoolOperationalCert
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
            entry: [string, bigint]
        ) => [
            entry[0],
            entry[1],
        ]);

        expect(testData[0].praosSlotsPerKESPeriod).toBeDefined();
        const slotsPerKESPeriod: bigint  = BigInt(testData[0].praosSlotsPerKESPeriod as number);

        expect(testData[0].praosMaxKESEvo).toBeDefined();
        const maxKESEvo: bigint = BigInt(testData[0].praosMaxKESEvo as number);

        expect(testData[1].header).toBeDefined();
        let header = BabbageHeader.fromCbor(testData[1].header as string);

        const lState = RawNewEpochState.init(0n, slotsPerKESPeriod, maxKESEvo);

        expect(testData[0].activeSlotCoeff).toBeDefined();
        const asc = testData[0].activeSlotCoeff as number;

        expect(testData[0].nonce).toBeDefined();
        const nonce = fromHex(testData[0].nonce as string);

        const shelleyGenesisFile = Bun.file("./src/config/preprod-shelley-genesis.json");
        let shelleyGenesis = await shelleyGenesisFile.json();

        shelleyGenesis.activeSlotsCoeff = asc;
        shelleyGenesis.slotsPerKESPeriod = slotsPerKESPeriod;
        shelleyGenesis.maxKESEvolutions = maxKESEvo;
        shelleyGenesis.praosMaxKESEvo = maxKESEvo;

        const kesPubKey = ocertCounters[0][0] as string;
        const kesPeriod = ocertCounters[0][1] as bigint;
        
        console.log("kesPubKey", fromHex(kesPubKey).length);


        const originalOpCert = header.body.opCert;
        
        const newOpCert: PoolOperationalCert = {
            kesPubKey: kesPubKey,
            sequenceNumber: originalOpCert.sequenceNumber,
            kesPeriod: kesPeriod,
            signature: originalOpCert.signature
        };

        // preserve BabbageHeader and BabbageHeaderBody prototypes by mutating opCert in place (bypass readonly for testing)
        (header.body as any).opCert = newOpCert;
        const sum = await validateHeader(
            new MultiEraHeader({ era: 6, header }),
            nonce,
            shelleyGenesis,
            lState
        );

        const mutation = testData[1].mutation;
        expect(sum).toBe(mutation === "NoMutation");
    });
}

vector.forEach((value, index) => genTestCase(value, index));

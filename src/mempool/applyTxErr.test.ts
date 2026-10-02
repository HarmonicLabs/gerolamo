import { describe, expect, test } from "bun:test";
import { ALL_INPUTS_SPENT, LedgerF, RuleRun, UtxoF, UtxowF, rejectMessageBytes, txOutCbor } from "./applyTxErr";
import { Cbor } from "@harmoniclabs/cbor";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ADDR = "00ffd8145d817163e82a9ae40ffe4968ddf396299b32b64344b9d25c754d4967db3ddeb6b764db064b87f59765d742b78a2a8409cbad23487c";
const KEY = "ffd8145d817163e82a9ae40ffe4968ddf396299b32b64344b9d25c75";
const FAKE = "ff".repeat(32);

/** One UTXO failure list and one UTXOW own failure, nested the way the ledger nests them. */
function run(utxoErrs: Array<ReturnType<typeof UtxoF.badInputs>[]>, utxowOwn: Array<ReturnType<typeof UtxowF.missingVKeyWitnesses>[]>) {
    const utxo = new RuleRun(UtxowF.utxo), utxow = new RuleRun(LedgerF.utxow), ledger = new RuleRun(), mempool = new RuleRun();
    for (const errs of utxowOwn) utxow.fail(...errs);
    for (const errs of utxoErrs) utxo.fail(...errs);
    utxow.sub(utxo); ledger.sub(utxow); mempool.sub(ledger);
    return mempool.failures;
}

// Replies captured from the cardano-node 11.0.1 preview relay (2026-09-28) for unsigned test transactions.
describe("Conway ApplyTxErr (relay captures)", () => {
    test("all inputs spent: the MEMPOOL rule's text alone", () => {
        const m = new RuleRun();
        m.fail(LedgerF.mempoolFailure(ALL_INPUTS_SPENT));
        expect(hex(rejectMessageBytes(m.failures))).toBe("82028182068182077844416c6c20696e7075747320617265207370656e742e205472616e73616374696f6e206861732070726f6261626c7920616c7265616479206265656e20696e636c75646564");
    });

    test("small-steps order: UTXO failures (in execution order) before the UTXOW failure that ran first", () => {
        const consumed = new Map([["lovelace", 4209459734n]]), produced = new Map([["lovelace", 4209459734n + 2_000_000n + 1000n]]);
        const small = { out: { address: Uint8Array.from(Buffer.from(ADDR, "hex")), value: new Map([["lovelace", 1000n]]) }, minCoin: 0xecc16n };
        const failures = run(
            [[UtxoF.badInputs([`${FAKE}:3`])], [UtxoF.valueNotConserved(consumed, produced)], [UtxoF.outputTooSmall([small])]],
            [[UtxowF.missingVKeyWitnesses([KEY])]],
        );
        expect(hex(rejectMessageBytes(failures))).toBe(
            "820281820684820182008201d9010281825820" + FAKE + "03" +
            "8201820083061afae742161afb05ca7e" +
            "820182008215818282583900" + ADDR.slice(2) + "1903e81a000ecc16" +
            "82018202d9010281581c" + KEY,
        );
    });

    test("expired + fee too small: validity interval, then fee (swapped mismatch), then the witness", () => {
        const failures = run([[UtxoF.outsideValidityInterval(null, 0x0763f6afn, 0x0763f714n)], [UtxoF.feeTooSmall(0x27445n, 1000n)]], [[UtxowF.missingVKeyWitnesses([KEY])]]);
        expect(hex(rejectMessageBytes(failures))).toBe("8202818206838201820083028280811a0763f6af1a0763f7148201820083051a000274451903e882018202d9010281581c" + KEY);
    });

    test("one feesOK Validation with two errors keeps their order", () => {
        const failures = run([[UtxoF.insufficientCollateral(0n, 3_000_000n), UtxoF.noCollateralInputs()]], []);
        expect(hex(rejectMessageBytes(failures))).toBe("82028182068282018200830c001a002dc6c0820182008113");
    });

    test("ledger TxOut re-encoding: map-form output without datum becomes [addr, value]", () => {
        const out = txOutCbor({ address: Uint8Array.from(Buffer.from(ADDR, "hex")), value: new Map([["lovelace", 100000n]]) });
        expect(hex(Cbor.encode(out).toBuffer())).toBe("82583900" + ADDR.slice(2) + "1a000186a0");
    });
});

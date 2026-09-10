import { describe, expect, test } from "bun:test";
import { Address, Credential, StakeCredentials } from "@harmoniclabs/cardano-ledger-ts";
import { encodeBech32 } from "@harmoniclabs/crypto";
import { bech32Encode, shelleyAddressBech32 } from "./stakeCred";

const hex = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0")).join("");

describe("bech32Encode", () => {
    test("matches ledger-ts / @harmoniclabs/crypto for base, script and enterprise addresses on both networks", () => {
        for (let seed = 1; seed < 40; seed++) {
            const pay = hex(28, seed), stake = hex(28, seed + 100);
            const forms = [
                Address.testnet(Credential.keyHash(pay), StakeCredentials.keyHash(stake)),
                Address.testnet(Credential.script(pay), StakeCredentials.keyHash(stake)),
                Address.testnet(Credential.keyHash(pay), StakeCredentials.script(stake)),
                Address.testnet(Credential.script(pay), StakeCredentials.script(stake)),
                Address.testnet(Credential.keyHash(pay)),
                Address.testnet(Credential.script(pay)),
                Address.mainnet(Credential.keyHash(pay), StakeCredentials.keyHash(stake)),
                Address.mainnet(Credential.keyHash(pay)),
            ];
            for (const a of forms) {
                const raw = new Uint8Array(a.toBytes());
                expect(shelleyAddressBech32(raw)).toBe(a.toString());
            }
        }
    });
    test("agrees with the library encoder on arbitrary byte lengths", () => {
        for (let len = 0; len < 80; len++) {
            const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
            expect(bech32Encode("stake_test", bytes)).toBe(encodeBech32("stake_test", bytes));
        }
    });
});

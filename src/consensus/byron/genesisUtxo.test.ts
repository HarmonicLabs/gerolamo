import { describe, expect, test } from "bun:test";
import { avvmGenesisAddress, base58Decode, byronGenesisUtxoId, byronGenesisUtxos, countFundedGenesisEntries } from "./genesisUtxo";
import genesis from "../../config/preprod/byron-genesis.json";

describe("Byron genesis UTxO", () => {
    test("base58 decodes with leading-zero handling", () => {
        expect(Array.from(base58Decode("11"))).toEqual([0, 0]);
        expect(Array.from(base58Decode("2g"))).toEqual([0x61]); // "a"
        expect(() => base58Decode("0OIl")).toThrow();
    });

    test("preprod: the funded genesis address hashes to the id spent by the first preprod tx", () => {
        const funded = Object.entries((genesis as any).nonAvvmBalances as Record<string, string>).find(([, v]) => BigInt(v) > 0n)!;
        expect(byronGenesisUtxoId(funded[0])).toBe("5526b1373acfc774794a62122f95583ff17febb2ca8a0fe948d097e29cf99099");
    });

    test("only positive balances become UTxOs", () => {
        const r = byronGenesisUtxos(genesis as any);
        expect(r.utxos).toHaveLength(1);
        expect(r.nonAvvm).toBe(1);
        expect(r.avvm).toBe(0);
        expect(r.utxos[0]!.lovelace).toBe(30_000_000_000_000_000n);
        expect(r.utxos[0]!.utxoRef.endsWith(":0")).toBe(true);
        expect(byronGenesisUtxos({ nonAvvmBalances: { [funded()]: "0" } }).utxos).toHaveLength(0);
    });

    test("mainnet AVVM entries derive the redeem addresses seen on chain", () => {
        // Verified via Blockfrost mainnet: each address received exactly this lovelace.
        const vectors = [
            { pk: "-0BJDi-gauylk4LptQTgjMeo7kY9lTCbZv12vwOSTZk=", lovelace: "9999300000000", addr: "Ae2tdPwUPEZHFQnrr2dYB4GEQ8WVKspEyrg29pJ3f7qdjzaxjeShEEokF5f", id: "8ee33c9906974706223d7d500d63bbee2369d7150f972757a9fdded2f706b938" },
            { pk: "-0Np4pyTOWF26iXWVIvu6fhz9QupwWRS2hcCaOEYlw0=", lovelace: "3760024000000", addr: "Ae2tdPwUPEZFF5MA48FeLbPhKPbC9pG5DpzReXzzoFhofPR7nZQ8DSR3A4G", id: "2d8208189f58f59c674fbe8f8c421f84c9060aa4b790d498c5f6083819f3e131" },
            { pk: "-0_pjw54ACGTrCsH3SXreedq-Cj9pFBcZDbxT9sXaqQ=", lovelace: "411085000000", addr: "Ae2tdPwUPEZEESRbZwe58ZcwLRD7P9kxCLad3gxBVNdFRCP4En5z8eh5QCF", id: "cec733c7d6c052103194446440669995adb76f13a70eed526e2d1241b16feda3" },
        ];
        for (const v of vectors) {
            const a = avvmGenesisAddress(v.pk, 764824073);
            expect(a.address).toBe(v.addr);
            expect(a.txId).toBe(v.id);
        }
        const r = byronGenesisUtxos({
            avvmDistr: Object.fromEntries(vectors.map((v) => [v.pk, v.lovelace])),
            protocolConsts: { protocolMagic: 764824073 },
        });
        expect(r.avvm).toBe(3);
        expect(r.utxos.map((u) => u.utxoRef)).toEqual(vectors.map((v) => `${v.id}:0`));
        expect(r.utxos[0]!.address).toBe(vectors[0]!.addr);
    });

    // 14,505 redeem-address derivations (~1 ms each): a one-off cost at first start on mainnet.
    test("mainnet genesis yields one UTxO per funded AVVM entry", () => {
        const mainnet = require("../../config/mainnet/byron-genesis.json");
        const t0 = performance.now();
        const r = byronGenesisUtxos(mainnet);
        const ms = performance.now() - t0;
        expect(r.avvm).toBe(Object.values(mainnet.avvmDistr as Record<string, string>).filter((v) => BigInt(v) > 0n).length);
        expect(r.avvm).toBeGreaterThan(14_000);
        expect(new Set(r.utxos.map((u) => u.utxoRef)).size).toBe(r.utxos.length);
        expect(ms).toBeLessThan(60_000);
    }, 90_000);
});

function funded(): string {
    return Object.keys((genesis as any).nonAvvmBalances)[0]!;
}

describe("countFundedGenesisEntries", () => {
    test("matches the number of UTxOs produced, without deriving addresses", () => {
        expect(countFundedGenesisEntries(genesis as any)).toBe(1);
        const mainnet = require("../../config/mainnet/byron-genesis.json");
        expect(countFundedGenesisEntries(mainnet)).toBe(Object.values(mainnet.avvmDistr as Record<string, string>).filter((v) => BigInt(v) > 0n).length);
    });
});

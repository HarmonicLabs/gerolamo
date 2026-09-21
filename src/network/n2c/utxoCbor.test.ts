import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { addressBytes, addressString, txInCbor, txInRef, txOutCbor, utxoMapCbor } from "./utxoCbor";

const ADDR = "addr_test1wzq6xa0xug63xmxnx6edzpczla4vr2a2ew5a5uq7wc5cwuc7m6spp";

describe("utxoCbor", () => {
    test("address round-trips through bytes", () => {
        const raw = addressBytes(ADDR)!;
        expect(raw.length).toBe(29);
        expect(raw[0]).toBe(0x70);
        expect(addressString(raw)).toBe(ADDR);
        const base = "addr_test1qrwanxlqh9k668ap485rqtxxrlhaj8vs56atpu6ykgw9yu0l0dw5r75vk42mv3ykq8vyjeaanvpytg79xqzymqy5acmqt58ltc";
        expect(addressString(addressBytes(base)!)).toBe(base);
    });

    test("tx in round-trips", () => {
        const ref = "fef6ad0624356926178af71483ab1b137d6a5900a0398961e3502e1329e42ae6:44";
        expect(txInRef(txInCbor(ref))).toBe(ref);
    });

    test("map-form output with multi-asset value, inline datum and script ref", () => {
        const out = txOutCbor({
            address: ADDR, amount: "1176630",
            assets: { "": { "": "1176630" }, "4f751c2d1a0b470f01d58d13c64fce0d6ac4a7b879f90897841763ba": { "5354414b494e475f4d414e414745525f4e4654": "1" } },
            inline_datum: "d8799f00d8799fd8799f00ffffff", reference_script_cbor: "82025820" + "00".repeat(32),
        })!;
        const back = Cbor.parse(Cbor.encode(out).toBuffer()) as CborMap;
        expect(back.map.length).toBe(4);
        const value = back.map[1]!.v as CborArray;
        expect((value.array[0] as CborUInt).num).toBe(1176630n);
        expect((value.array[1] as CborMap).map.length).toBe(1);
        const datum = back.map[2]!.v as CborArray;
        expect((datum.array[0] as CborUInt).num).toBe(1n);
        expect((datum.array[1] as CborTag).tag).toBe(24n);
        expect((back.map[3]!.v as CborTag).tag).toBe(24n);
    });

    test("plain lovelace output and datum hash; whole map", () => {
        const m = utxoMapCbor([
            { utxo_ref: "aa".repeat(32) + ":0", tx_out: JSON.stringify({ address: ADDR, amount: "5000000", assets: {}, datum_hash: "bb".repeat(32) }) },
            { utxo_ref: "cc".repeat(32) + ":1", tx_out: { address: "not-an-address", amount: "1" } },
        ]);
        expect(m.map.length).toBe(1);
        const out = m.map[0]!.v as CborMap;
        expect(out.map[1]!.v).toBeInstanceOf(CborUInt);
        const datum = out.map[2]!.v as CborArray;
        expect((datum.array[0] as CborUInt).num).toBe(0n);
        expect(datum.array[1]).toBeInstanceOf(CborBytes);
    });
});

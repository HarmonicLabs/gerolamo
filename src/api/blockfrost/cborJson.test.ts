import { describe, expect, test } from "bun:test";
import { datumJson, metadataJson, nativeScriptJson } from "./cborJson";
import { toJson } from "./http";
import { a, b, enc, m, t, tag, u } from "./__fixtures__/chain";

describe("CBOR renderings", () => {
    test("metadata: db-sync no-schema JSON (bytes as 0x text, integer keys as strings, big integers as numbers)", () => {
        const v = enc(m([u(1), t("one")], [t("k"), a(b("cafe"), u(-5), tag(2, b("400000000000000000")))]));
        const j = metadataJson(v) as any;
        expect(j["1"]).toBe("one");
        expect(j.k[0]).toBe("0xcafe");
        expect(j.k[1]).toBe(-5);
        expect(toJson(j)).toBe('{"1":"one","k":["0xcafe",-5,1180591620717411303424]}');
    });

    test("datums: the detailed schema (constructors 0–6, 7–127, general form, maps, lists, bytes, ints)", () => {
        expect(datumJson(enc(tag(121, a(u(1), b("ab")))))).toEqual({ constructor: 0, fields: [{ int: 1 }, { bytes: "ab" }] });
        expect(datumJson(enc(tag(1280, a())))).toEqual({ constructor: 7, fields: [] });
        expect(datumJson(enc(tag(102, a(u(200), a(u(0))))))).toEqual({ constructor: 200, fields: [{ int: 0 }] });
        expect(datumJson(enc(m([b("01"), a(u(1), u(2))])))).toEqual({ map: [{ k: { bytes: "01" }, v: { list: [{ int: 1 }, { int: 2 }] } }] });
        expect(datumJson(enc(t("text is not plutus data")))).toBeNull();
    });

    test("native scripts as cardano-cli JSON", () => {
        const s = enc(a(u(1), a(a(u(0), b("aa".repeat(28))), a(u(3), u(1), a(a(u(4), u(10)), a(u(5), u(20)))), a(u(2), a()))));
        expect(nativeScriptJson(s)).toEqual({
            type: "all",
            scripts: [
                { type: "sig", keyHash: "aa".repeat(28) },
                { type: "atLeast", required: 1, scripts: [{ type: "after", slot: 10 }, { type: "before", slot: 20 }] },
                { type: "any", scripts: [] },
            ],
        });
    });
});

import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborMap, CborSimple, CborText, CborUInt } from "@harmoniclabs/cbor";
import { N2NLightQueryHost, QUERY_MAX_BODY, QUERY_RATE } from "./N2NLightQueryHost";

/** A multiplexer stand-in: captures the host's handler and every payload it sends back. */
function fakeMux() {
    let handler: ((p: Uint8Array) => void) | null = null;
    const sent: Uint8Array[] = [];
    const mux = {
        on: (_proto: unknown, cb: (p: Uint8Array) => void) => { handler = cb; },
        off: () => { handler = null; },
        send: (payload: Uint8Array) => { sent.push(Uint8Array.from(payload)); },
    };
    return { mux, sent, deliver: (msg: CborArray) => handler!(Cbor.encode(msg).toBuffer()) };
}

const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };
const replyOf = (b: Uint8Array) => (Cbor.parse(b) as CborArray).array;
const query = (id: number, path: string) => new CborArray([new CborUInt(8), new CborUInt(id), new CborText(path)]);

describe("light query: Blockfrost queries (tag 8)", () => {
    test("answers [9, id, status, body] from the node's Blockfrost API", async () => {
        const seen: string[] = [];
        const { mux, sent, deliver } = fakeMux();
        new N2NLightQueryHost(mux as any, {
            networkMagic: 2, activeSlotsCoeff: 0.05,
            blockfrost: async (path) => { seen.push(path); return { status: 200, body: JSON.stringify({ path }) }; },
        });
        deliver(query(7, "/addresses/addr_test1x/utxos?page=2"));
        await until(() => sent.length === 1);
        const r = replyOf(sent[0]!);
        expect(Number((r[0] as CborUInt).num)).toBe(9);
        expect(Number((r[1] as CborUInt).num)).toBe(7);
        expect(Number((r[2] as CborUInt).num)).toBe(200);
        expect(JSON.parse((r[3] as CborText).text)).toEqual({ path: "/addresses/addr_test1x/utxos?page=2" });
        expect(seen).toEqual(["/addresses/addr_test1x/utxos?page=2"]);
    });

    test("refuses paths that leave /api/v0, oversized answers and floods", async () => {
        const { mux, sent, deliver } = fakeMux();
        new N2NLightQueryHost(mux as any, {
            networkMagic: 2, activeSlotsCoeff: 0.05,
            blockfrost: async (path) => ({ status: 200, body: path === "/big" ? "x".repeat(QUERY_MAX_BODY + 1) : "{}" }),
        });
        const status = (i: number) => Number(((replyOf(sent[i]!)[2]) as CborUInt).num);
        deliver(query(1, "../../etc/passwd"));
        deliver(query(2, "/blocks/../../x"));
        deliver(query(3, "/big"));
        await until(() => sent.length === 3);
        expect([status(0), status(1), status(2)]).toEqual([400, 400, 413]);
        for (let i = 0; i < QUERY_RATE; i++) deliver(query(10 + i, "/blocks/latest"));
        await until(() => sent.length === 3 + QUERY_RATE);
        expect(status(sent.length - 1)).toBe(429); // the /big query counts against the same window
        // replies come back in request order (clients match them by order)
        expect(sent.map((b) => Number((replyOf(b)[1] as CborUInt).num))).toEqual([1, 2, 3, ...Array.from({ length: QUERY_RATE }, (_, i) => 10 + i)]);
    });

    test("the hello announces the request types and their limits", async () => {
        const { mux, sent, deliver } = fakeMux();
        new N2NLightQueryHost(mux as any, { networkMagic: 2, activeSlotsCoeff: 0.05 });
        deliver(new CborArray([new CborUInt(4)]));
        await until(() => sent.length === 1);
        const r = replyOf(sent[0]!);
        expect(Number((r[0] as CborUInt).num)).toBe(5);
        expect(Number((r[2] as CborUInt).num)).toBe(1);
        const caps = new Map((r[3] as CborMap).map.map(({ k, v }) => [(k as CborText).text, v]));
        expect((caps.get("nonce") as CborSimple).simple).toBe(true);
        expect((caps.get("stake") as CborSimple).simple).toBe(true);
        const bf = new Map((caps.get("blockfrost") as CborMap).map.map(({ k, v }) => [(k as CborText).text, Number((v as CborUInt).num)]));
        expect(bf.get("rate")).toBe(QUERY_RATE);
        expect(bf.get("max_body")).toBe(QUERY_MAX_BODY);
    });

    test("an older client's unknown tag still gets [255, text]", async () => {
        const { mux, sent, deliver } = fakeMux();
        new N2NLightQueryHost(mux as any, { networkMagic: 2, activeSlotsCoeff: 0.05 });
        deliver(new CborArray([new CborUInt(42)]));
        await until(() => sent.length === 1);
        expect(Number((replyOf(sent[0]!)[0] as CborUInt).num)).toBe(255);
    });
});

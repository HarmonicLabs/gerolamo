import { afterEach, describe, expect, it } from "bun:test";
import { absoluteTime, explorer, explorerHref, lovelaceOf, lovelaceToAda, parseExplorerRoute, relativeTime, shortHash } from "@/lib/explorer";

describe("explorer routes", () => {
  it("parses every page and round-trips through explorerHref", () => {
    const cases = [
      ["#/explorer", { page: "blocks" }],
      ["#/explorer?before=abc", { page: "blocks", before: "abc" }],
      ["#/explorer/block/123", { page: "block", id: "123" }],
      ["#/explorer/tx/ABCDEF", { page: "tx", hash: "abcdef" }],
      ["#/explorer/address/addr_test1vq%2Fx", { page: "address", address: "addr_test1vq/x" }],
      ["#/explorer/epoch/42", { page: "epoch", epoch: 42 }],
      ["#/explorer/search?q=hello%20world", { page: "search", q: "hello world" }],
      ["#/explorer/epoch/notanumber", { page: "blocks" }],
      ["", { page: "blocks" }],
    ] as const;
    for (const [hash, route] of cases) expect(parseExplorerRoute(hash)).toEqual(route as any);
    for (const [, route] of cases) expect(parseExplorerRoute(explorerHref(route as any))).toEqual(route as any);
  });
});

describe("explorer client", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("hits the Mini-Blockfrost paths and surfaces the BF error message", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: any) => {
      seen.push(String(input));
      if (String(input).includes("/txs/dead")) return new Response(JSON.stringify({ status_code: 404, error: "Not Found", message: "Transaction not in mb_tx" }), { status: 404 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as any;
    await explorer.blocks(10, "abc");
    await explorer.epochBlocks(3, 2, 50);
    await explorer.address("addr/1");
    await expect(explorer.tx("dead")).rejects.toThrow("Transaction not in mb_tx");
    expect(seen[0]).toBe("/api/v0/blocks?limit=10&before=abc");
    expect(seen[1]).toBe("/api/v0/epochs/3/blocks?page=2&count=50");
    expect(seen[2]).toBe("/api/v0/addresses/addr%2F1");
  });
});

describe("formatting", () => {
  it("lovelace, hashes, times", () => {
    expect(lovelaceToAda("1500000")).toBe("1.5 ₳");
    expect(lovelaceToAda("0")).toBe("0 ₳");
    expect(lovelaceToAda("123456789012")).toBe("123,456.789012 ₳");
    expect(shortHash("0123456789abcdef0123456789abcdef")).toBe("01234567…abcdef");
    expect(shortHash(null)).toBe("—");
    const now = 1_700_000_000_000;
    expect(relativeTime(1_700_000_000 - 30, now)).toBe("30s ago");
    expect(relativeTime(1_700_000_000 - 3600 * 5, now)).toBe("5h ago");
    expect(absoluteTime(1_596_059_091)).toBe("2020-07-29 21:44:51 UTC");
    expect(lovelaceOf([{ unit: "lovelace", quantity: "5" }, { unit: "abc", quantity: "9" }, { unit: "lovelace", quantity: "7" }])).toBe(12n);
  });
});

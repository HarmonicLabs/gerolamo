import { describe, it, expect, test } from "bun:test";
import {
  API_BASE_URL,
  ApiError,
  NetworkError,
  fetchStatus,
  fetchPeers,
  fetchRecentBlocks,
  fetchLogs,
  fetchUtxos,
  fetchRecentDeltas,
  fetchChainState,
  fetchMempool,
  fetchBlockDetail,
  fetchTxDetail,
  useSSE,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// API_BASE_URL
// ---------------------------------------------------------------------------

describe("API_BASE_URL", () => {
  it("is defined as a string", () => {
    expect(typeof API_BASE_URL).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe("ApiError", () => {
  it("stores status, statusText, and path", () => {
    const err = new ApiError(404, "Not Found", "/api/status");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(404);
    expect(err.statusText).toBe("Not Found");
    expect(err.path).toBe("/api/status");
    expect(err.message).toContain("404");
    expect(err.message).toContain("Not Found");
    expect(err.message).toContain("/api/status");
  });

  it("includes optional body in message", () => {
    const err = new ApiError(500, "Internal Server Error", "/api/blocks", "db error");
    expect(err.message).toContain("db error");
  });
});

describe("NetworkError", () => {
  it("stores path and cause", () => {
    const cause = new TypeError("fetch failed");
    const err = new NetworkError("/api/peers", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NetworkError");
    expect(err.path).toBe("/api/peers");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("fetch failed");
  });

  it("handles non-Error cause", () => {
    const err = new NetworkError("/api/peers", "timeout");
    expect(err.message).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// Fetch functions exist and are callable
// ---------------------------------------------------------------------------

describe("API fetch functions", () => {
  test("fetchStatus is a function", () => {
    expect(typeof fetchStatus).toBe("function");
  });

  test("fetchPeers is a function", () => {
    expect(typeof fetchPeers).toBe("function");
  });

  test("fetchRecentBlocks is a function", () => {
    expect(typeof fetchRecentBlocks).toBe("function");
  });

  test("fetchLogs is a function", () => {
    expect(typeof fetchLogs).toBe("function");
  });

  test("fetchUtxos is a function", () => {
    expect(typeof fetchUtxos).toBe("function");
  });

  test("fetchRecentDeltas is a function", () => {
    expect(typeof fetchRecentDeltas).toBe("function");
  });

  test("fetchChainState is a function", () => {
    expect(typeof fetchChainState).toBe("function");
  });

  test("fetchMempool is a function", () => {
    expect(typeof fetchMempool).toBe("function");
  });

  test("fetchBlockDetail is a function", () => {
    expect(typeof fetchBlockDetail).toBe("function");
  });

  test("fetchTxDetail is a function", () => {
    expect(typeof fetchTxDetail).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// useSSE hook shape
// ---------------------------------------------------------------------------

describe("useSSE", () => {
  test("is a function", () => {
    expect(typeof useSSE).toBe("function");
  });
});

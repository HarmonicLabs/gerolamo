import { describe, expect, test } from "bun:test";
import { classifyPeerNetError } from "./peerNetError";

describe("classifyPeerNetError", () => {
  test("treats ECONNREFUSED (wrapped mux socket error) as expected", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 136.157.114.167:3000"), {
      code: "ECONNREFUSED",
    });
    const wrapped = Object.assign(new Error("socket error"), { data: cause, cause });
    const result = classifyPeerNetError(wrapped, "136.157.114.167:3000");
    expect(result.expected).toBe(true);
    expect(result.code).toBe("ECONNREFUSED");
    expect(result.line).toContain("ECONNREFUSED");
    expect(result.line).toContain("136.157.114.167:3000");
  });

  test("keeps unexpected mux failures as not-expected", () => {
    const result = classifyPeerNetError(new Error("unexpected protocol"), "1.2.3.4:3001");
    expect(result.expected).toBe(false);
  });

  test("treats the governor handshake deadline as expected peer churn", () => {
    const result = classifyPeerNetError(
      new Error("handshake 1.2.3.4:3001 timed out after 12000ms"),
      "1.2.3.4:3001",
    );
    expect(result.expected).toBe(true);
    expect(result.line).toContain("timed out after 12000ms");
  });
});

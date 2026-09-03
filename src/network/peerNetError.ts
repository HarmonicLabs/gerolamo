/** Classify expected TCP/peer-discovery failures so they don't dump stacks. */

const EXPECTED_NET =
  /ECONNREFUSED|ETIMEDOUT|timed out after|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ENOTFOUND|EPIPE|ECONNABORTED/i;

export type PeerNetFailure = {
  expected: boolean;
  code: string | undefined;
  message: string;
  line: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function unwrapPeerNetError(err: unknown): { code?: string; message: string } {
  const rec = asRecord(err);
  const cause = rec?.cause ?? rec?.data ?? err;
  const causeRec = asRecord(cause);
  const code =
    (typeof causeRec?.code === "string" && causeRec.code) ||
    (typeof rec?.code === "string" && rec.code) ||
    undefined;
  const message = String(
    (cause instanceof Error && cause.message) ||
      (err instanceof Error && err.message) ||
      causeRec?.message ||
      rec?.message ||
      err,
  );
  return { code, message };
}

export function classifyPeerNetError(err: unknown, peerKey?: string): PeerNetFailure {
  const { code, message } = unwrapPeerNetError(err);
  const blob = `${code ?? ""} ${message}`;
  const expected = EXPECTED_NET.test(blob);
  const where = peerKey ? `peer ${peerKey}` : "peer";
  const line = expected
    ? `${where} ${code ?? "net"} ${message}`
    : `${where} multiplexer error: ${message}`;
  return { expected, code, message, line };
}

/**
 * Minimal node-to-client LocalStateQuery client for oracle scripts: handshake, acquire (volatile tip,
 * immutable tip or a point), queries with a timeout, and connection-loss detection (a cardano-node
 * drops the connection on a query it cannot decode instead of answering).
 *   openLsq(sock, magic)                               → acquired at the volatile tip
 *   openLsq(sock, magic, { acquire: false })           → handshake only; call acquire() yourself
 */
import { connect } from "node:net";
import { Cbor, CborArray, CborUInt, CborMap, CborSimple, CborBytes, type CborObj } from "@harmoniclabs/cbor";

export type AcquireTarget = "tip" | "immutable" | "origin" | { slot: bigint | number; hash: string };
export type AcquireResult = { ok: true } | { ok: false; failure: string };

export async function openLsq(sockPath: string, magic: number, opts: { versions?: number[]; acquire?: boolean; timeoutMs?: number } = {}) {
  const sock = connect({ path: sockPath });
  await new Promise<void>((r, j) => { sock.once("connect", () => r()); sock.once("error", j); });
  let closed = false;
  const waiters: Array<{ proto: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void }> = [];
  sock.on("close", () => { closed = true; for (const w of waiters.splice(0)) w.reject(new Error("connection closed")); });
  sock.on("error", () => { /* surfaced as close */ });
  let inbox = new Uint8Array(0);
  // per protocol: segments of the message being received, their byte count, the size at the last scan
  const partial = new Map<number, { parts: Uint8Array[]; n: number; scanned: number; maxSeg: number }>();
  const deliver = (proto: number, all: Uint8Array) => { partial.delete(proto); const w = waiters.findIndex((x) => x.proto === proto); if (w >= 0) waiters.splice(w, 1)[0]!.resolve(all); };
  const tryComplete = (proto: number, force: boolean) => {
    const st = partial.get(proto); if (!st) return;
    const last = st.parts[st.parts.length - 1]!;
    // a big answer arrives in many full-size segments: scan (linear in the bytes) only after a short
    // segment, or when the buffer doubled since the last scan, so a 100 MB answer is not scanned per segment
    if (!force && last.length >= st.maxSeg && st.n < 2 * st.scanned) return;
    const all = st.parts.length === 1 ? st.parts[0]! : new Uint8Array(Buffer.concat(st.parts.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
    st.parts = [all]; st.scanned = st.n;
    if (cborEnd(all, 0) === all.length) deliver(proto, all);
  };
  sock.on("data", (chunk: Buffer) => {
    const j = new Uint8Array(inbox.length + chunk.length); j.set(inbox); j.set(chunk, inbox.length); inbox = j;
    let o = 0;
    while (inbox.length - o >= 8) {
      const dv = new DataView(inbox.buffer, inbox.byteOffset + o, 8); const proto = dv.getUint16(4) & 0x7fff, len = dv.getUint16(6);
      if (inbox.length - o < 8 + len) break;
      const p = inbox.slice(o + 8, o + 8 + len); o += 8 + len;
      let st = partial.get(proto);
      if (!st) partial.set(proto, (st = { parts: [], n: 0, scanned: 0, maxSeg: 0 }));
      st.parts.push(p); st.n += p.length; st.maxSeg = Math.max(st.maxSeg, p.length);
      tryComplete(proto, false);
    }
    inbox = inbox.slice(o);
  });
  const t0 = Date.now();
  const send = (proto: number, payload: Uint8Array) => { for (let o = 0; o < payload.length; o += 12288) { const part = payload.subarray(o, Math.min(payload.length, o + 12288)); const h = Buffer.alloc(8); h.writeUInt32BE((Date.now() - t0) & 0xffffffff, 0); h.writeUInt16BE(proto, 4); h.writeUInt16BE(part.length, 6); sock.write(Buffer.concat([h, Buffer.from(part)])); } };
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const recv = (proto: number, ms = timeoutMs) => {
    const p = new Promise<Uint8Array>((resolve, reject) => {
      if (closed) return reject(new Error("connection closed"));
      const w = { proto, resolve: (b: Uint8Array) => { clearTimeout(t); resolve(b); }, reject: (e: Error) => { clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { tryComplete(proto, true); const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout after ${ms} ms`)); } }, ms);
      waiters.push(w);
    });
    p.catch(() => undefined); // a reply nobody awaits any more (the peer closed on us mid-run) is not an unhandled rejection
    return p;
  };
  const versions = opts.versions ?? [19, 20, 21, 22, 23];
  send(0, Cbor.encode(new CborArray([new CborUInt(0), new CborMap(versions.map((v) => ({ k: new CborUInt(0x8000 | v), v: new CborArray([new CborUInt(magic), new CborSimple(false)]) })))])).toBuffer());
  const hs = Cbor.parse(await recv(0)) as CborArray;
  const version = hs.array[0] instanceof CborUInt && Number(hs.array[0].num) === 1 && hs.array[1] instanceof CborUInt ? Number(hs.array[1].num) & 0x7fff : -1;
  let acquired = false;
  const acquire = async (target: AcquireTarget = "tip"): Promise<AcquireResult> => {
    const again = acquired;
    const msg = target === "tip" ? [new CborUInt(again ? 9 : 8)] : target === "immutable" ? [new CborUInt(again ? 11 : 10)] : target === "origin" ? [new CborUInt(again ? 6 : 0), new CborArray([])]
      : [new CborUInt(again ? 6 : 0), new CborArray([new CborUInt(BigInt(target.slot)), new CborBytes(Uint8Array.from(Buffer.from(target.hash, "hex")))])];
    send(7, Cbor.encode(new CborArray(msg)).toBuffer());
    const r = Cbor.parse(await recv(7)) as CborArray;
    const tag = Number((r.array[0] as CborUInt).num);
    if (tag === 1) { acquired = true; return { ok: true }; }
    acquired = false;
    const f = r.array[1] instanceof CborUInt ? Number(r.array[1].num) : -1;
    return { ok: false, failure: f === 0 ? "PointTooOld" : f === 1 ? "PointNotOnChain" : `failure ${f}` };
  };
  if (opts.acquire !== false) { const a = await acquire("tip"); if (!a.ok) throw new Error(`acquire failed: ${a.failure}`); }
  /** The raw bytes of the answer inside MsgResult [4, result], for byte comparison. */
  const queryRaw = async (q: CborObj, ms?: number): Promise<Uint8Array> => {
    send(7, Cbor.encode(new CborArray([new CborUInt(3), q])).toBuffer());
    const bytes = await recv(7, ms);
    if (bytes[0] !== 0x82 || bytes[1] !== 0x04) throw new Error(`unexpected reply ${Buffer.from(bytes.subarray(0, 16)).toString("hex")}`);
    return bytes.subarray(2);
  };
  return {
    version,
    acquire,
    isClosed: () => closed,
    queryRaw,
    query: async (q: CborObj, ms?: number) => Cbor.parse(await queryRaw(q, ms)),
    release: () => { send(7, Cbor.encode(new CborArray([new CborUInt(5)])).toBuffer()); acquired = false; },
    // MsgDone is valid only in StIdle: an acquired client releases first (a cardano-node logs a DecoderFailure otherwise)
    close: () => { if (!closed) { try { if (acquired) send(7, Cbor.encode(new CborArray([new CborUInt(5)])).toBuffer()); send(7, Cbor.encode(new CborArray([new CborUInt(7)])).toBuffer()); } catch { /* gone */ } sock.end(); } },
  };
}
export type LsqClient = Awaited<ReturnType<typeof openLsq>>;

/** End offset of the CBOR item starting at `o`, or -1 when the bytes stop before it ends. */
export function cborEnd(b: Uint8Array, o: number): number {
  if (o >= b.length) return -1;
  const ib = b[o]!, mt = ib >> 5, ai = ib & 31;
  let p = o + 1, n = 0n;
  if (ai < 24) n = BigInt(ai);
  else if (ai <= 27) { const w = 1 << (ai - 24); if (p + w > b.length) return -1; for (let i = 0; i < w; i++) n = (n << 8n) | BigInt(b[p + i]!); p += w; }
  else if (ai === 31) {
    if (mt === 7) return p; // break
    if (mt < 2 || mt === 6) return -1;
    for (;;) { if (p >= b.length) return -1; if (b[p] === 0xff) return p + 1; p = cborEnd(b, p); if (p < 0) return -1; }
  } else return -1;
  switch (mt) {
    case 0: case 1: case 7: return p;
    case 2: case 3: { const e = p + Number(n); return e <= b.length ? e : -1; }
    case 4: { for (let i = 0n; i < n; i++) { p = cborEnd(b, p); if (p < 0) return -1; } return p; }
    case 5: { for (let i = 0n; i < 2n * n; i++) { p = cborEnd(b, p); if (p < 0) return -1; } return p; }
    case 6: return cborEnd(b, p);
  }
  return -1;
}

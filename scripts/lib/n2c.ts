/**
 * Minimal node-to-client multiplexer client for oracle scripts: handshake, then raw
 * request/response per mini-protocol (LocalTxSubmission 6, LocalStateQuery 7, LocalTxMonitor 9).
 * Messages are returned as the exact bytes the node sent (byte comparisons need them).
 */
import { connect } from "node:net";
import { Cbor, CborArray, CborMap, CborSimple, CborUInt } from "@harmoniclabs/cbor";

export interface N2cConn {
    version: number;
    send(proto: number, payload: Uint8Array): void;
    recv(proto: number, timeoutMs?: number): Promise<Uint8Array>;
    close(): void;
}

export async function openN2c(sockPath: string, magic: number, versions: number[] = [16, 17, 18, 19, 20, 21, 22, 23]): Promise<N2cConn> {
    const sock = connect({ path: sockPath });
    await new Promise<void>((r, j) => { sock.once("connect", () => r()); sock.once("error", j); });
    let inbox = new Uint8Array(0);
    const partial = new Map<number, Uint8Array[]>();
    const ready = new Map<number, Uint8Array[]>();
    const waiters: Array<{ proto: number; resolve: (b: Uint8Array) => void }> = [];
    sock.on("data", (chunk: Buffer) => {
        const j = new Uint8Array(inbox.length + chunk.length); j.set(inbox); j.set(chunk, inbox.length); inbox = j;
        while (inbox.length >= 8) {
            const dv = new DataView(inbox.buffer, inbox.byteOffset, inbox.byteLength);
            const proto = dv.getUint16(4) & 0x7fff, len = dv.getUint16(6);
            if (inbox.length < 8 + len) break;
            const p = inbox.slice(8, 8 + len); inbox = inbox.slice(8 + len);
            const acc = partial.get(proto) ?? []; acc.push(p);
            const all = new Uint8Array(Buffer.concat(acc.map((x) => Buffer.from(x))));
            try {
                const { offset } = Cbor.parseWithOffset(all);
                partial.delete(proto);
                const msgs = [all.subarray(0, offset)];
                let rest = all.subarray(offset);
                while (rest.length) { try { const o = Cbor.parseWithOffset(rest).offset; msgs.push(rest.subarray(0, o)); rest = rest.subarray(o); } catch { partial.set(proto, [rest]); break; } }
                for (const m of msgs) {
                    const w = waiters.findIndex((x) => x.proto === proto);
                    if (w >= 0) waiters.splice(w, 1)[0]!.resolve(new Uint8Array(m));
                    else { const q = ready.get(proto) ?? []; q.push(new Uint8Array(m)); ready.set(proto, q); }
                }
            } catch { partial.set(proto, acc); }
        }
    });
    const t0 = Date.now();
    const send = (proto: number, payload: Uint8Array) => {
        for (let o = 0; o < payload.length; o += 12288) {
            const part = payload.subarray(o, Math.min(payload.length, o + 12288));
            const h = Buffer.alloc(8); h.writeUInt32BE((Date.now() - t0) & 0xffffffff, 0); h.writeUInt16BE(proto, 4); h.writeUInt16BE(part.length, 6);
            sock.write(Buffer.concat([h, Buffer.from(part)]));
        }
    };
    const recv = (proto: number, timeoutMs = 30_000) => new Promise<Uint8Array>((resolve, reject) => {
        const q = ready.get(proto);
        if (q?.length) { resolve(q.shift()!); return; }
        const timer = setTimeout(() => { const i = waiters.findIndex((w) => w.resolve === done); if (i >= 0) waiters.splice(i, 1); reject(new Error(`n2c recv timeout on protocol ${proto}`)); }, timeoutMs);
        const done = (b: Uint8Array) => { clearTimeout(timer); resolve(b); };
        waiters.push({ proto, resolve: done });
    });
    send(0, Cbor.encode(new CborArray([new CborUInt(0), new CborMap(versions.map((v) => ({ k: new CborUInt(0x8000 | v), v: new CborArray([new CborUInt(magic), new CborSimple(false)]) })))])).toBuffer());
    const hs = Cbor.parse(await recv(0)) as CborArray;
    const tag = Number((hs.array[0] as CborUInt).num);
    if (tag !== 1) throw new Error(`handshake refused: ${Buffer.from(Cbor.encode(hs).toBuffer()).toString("hex")}`);
    const version = Number((hs.array[1] as CborUInt).num) & 0x7fff;
    return { version, send, recv, close: () => { try { sock.end(); } catch { /* */ } } };
}

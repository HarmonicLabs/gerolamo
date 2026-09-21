/**
 * Live N2N probe: handshake, ChainSync intersect + a few headers, BlockFetch a range, against a
 * Gerolamo (or cardano-node) relay, and check the bytes against a chunk directory when given.
 *
 *   bun scripts/n2n-probe.ts --host 127.0.0.1 --port 3002 --magic 2 [--immutable <dir>] [--slot <intersect slot>]
 */
import { connect } from "node:net";
import { BlockFetchClient, ChainPoint, ChainSyncClient, ChainSyncIntersectFound, ChainSyncRollBackwards, ChainSyncRollForward, HandshakeAcceptVersion, HandshakeClient, Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { ChunkStore } from "../src/storage/chunkStore";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const host = opt("host") ?? "127.0.0.1", port = Number(opt("port") ?? 3001), magic = Number(opt("magic") ?? 2);
const imm = opt("immutable");
const store = imm ? await ChunkStore.open(imm, { chunkSlots: 4320, readOnly: true, hashIndexPath: false }) : null;
const tip = store ? await store.tip() : null;
const startSlot = Number(opt("slot") ?? (tip ? tip.slot - 200 : 0));
let start = store ? await store.blockAt(startSlot) : null;
if (store && !start) for await (const b of store.iterate(startSlot)) { start = b; break; }
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const mux = new Multiplexer({ protocolType: "node-to-node", connect: () => connect({ host, port }) as any });
const t0 = Date.now();
const accepted = await new HandshakeClient(mux).propose({ networkMagic: magic, query: false });
console.log(`handshake: ${accepted instanceof HandshakeAcceptVersion ? `accepted v${(accepted as any).versionNumber}` : "REFUSED"} (${Date.now() - t0} ms)`);
const cs = new ChainSyncClient(mux);
const points = start ? [new ChainPoint({ blockHeader: { slotNumber: BigInt(start.slot), hash: start.hash } })] : [ChainPoint.origin];
const isect = await cs.findIntersect(points);
if (!(isect instanceof ChainSyncIntersectFound)) { console.log("intersect: NOT FOUND", JSON.stringify(isect)); process.exit(1); }
console.log(`intersect: slot ${isect.point.blockHeader?.slotNumber ?? "origin"}; server tip slot ${isect.tip.point.blockHeader?.slotNumber} blockNo ${isect.tip.blockNo}`);
const first = await cs.requestNext();
console.log(`first reply: ${first instanceof ChainSyncRollBackwards ? "RollBackward (spec §3.7)" : first.constructor.name}`);
let ok = 0, checked = 0;
const fetched: { slot: bigint; hash: Uint8Array }[] = [];
for (let i = 0; i < 5; i++) {
    const m = await cs.requestNext();
    if (!(m instanceof ChainSyncRollForward)) { console.log(`requestNext ${i}: ${m.constructor.name}`); break; }
    const data: any = m.data;
    const eraIdx = Number(data.array[0].num), hdr: Uint8Array = data.array[1].data.bytes;
    // header body [block_no, slot, …]
    const { Cbor } = await import("@harmoniclabs/cbor");
    const parsed: any = Cbor.parse(hdr);
    const slot = BigInt(parsed.array[0].array[1].num), blockNo = BigInt(parsed.array[0].array[0].num);
    const { blake2b_256 } = await import("@harmoniclabs/crypto");
    const hash = new Uint8Array(blake2b_256(hdr));
    fetched.push({ slot, hash });
    let verdict = "";
    if (store) {
        const b = await store.blockAt(Number(slot));
        checked++;
        if (b && hex(b.hash) === hex(hash) && hex(b.bytes.subarray(b.headerOffset, b.headerOffset + b.headerSize)) === hex(hdr)) { ok++; verdict = "= chunk header"; } else verdict = b ? "MISMATCH vs chunk" : "(not in chunks: volatile)";
    }
    console.log(`header ${i}: era ${eraIdx + 1} slot ${slot} blockNo ${blockNo} hash ${hex(hash).slice(0, 16)} ${verdict}`);
}
if (fetched.length >= 2) {
    const bf = new BlockFetchClient(mux);
    const from = new ChainPoint({ blockHeader: { slotNumber: fetched[0]!.slot, hash: fetched[0]!.hash } });
    const to = new ChainPoint({ blockHeader: { slotNumber: fetched[fetched.length - 1]!.slot, hash: fetched[fetched.length - 1]!.hash } });
    const t1 = Date.now();
    const blocks = await bf.requestRange(from, to);
    if (!Array.isArray(blocks)) console.log("block-fetch: NO BLOCKS", JSON.stringify(blocks));
    else {
        let same = 0;
        for (let i = 0; store && i < blocks.length; i++) {
            const want = await store.blockAt(Number(fetched[i]!.slot));
            if (want && hex(want.bytes) === hex(blocks[i]!.blockData)) same++;
        }
        console.log(`block-fetch: ${blocks.length} block(s) in ${Date.now() - t1} ms${store ? `, ${same}/${blocks.length} byte-identical to the chunk files` : ""}; first ${blocks[0]!.blockData.length} B head ${hex(blocks[0]!.blockData.subarray(0, 4))}`);
    }
}
console.log(`headers checked against chunks: ${ok}/${checked}`);
process.exit(0);

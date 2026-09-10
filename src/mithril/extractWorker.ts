/**
 * Extractor worker: decodes one immutable chunk into explorer deltas and posts them to the
 * writer on the main thread. Pure CPU (CBOR + address encoding); no database access.
 */
process.env.GEROLAMO_DB_PATH = ":memory:"; // db.ts opens the shared client at import; keep it off any ledger file
import { format } from "node:path";
import { parseChunk } from "../state/legacy";
import { extractBlock, type ExtractedBlock } from "./extractDelta";

declare const self: Worker;

async function readTrio(dir: string, chunkNo: number): Promise<[DataView, DataView, DataView]> {
    const n = chunkNo.toString().padStart(5, "0");
    const [p, s, c] = await Promise.all([
        Bun.file(format({ dir, base: `${n}.primary` })).arrayBuffer(),
        Bun.file(format({ dir, base: `${n}.secondary` })).arrayBuffer(),
        Bun.file(format({ dir, base: `${n}.chunk` })).arrayBuffer(),
    ]);
    return [new DataView(p), new DataView(s), new DataView(c)];
}

self.onmessage = async (ev: MessageEvent<{ t: "chunk"; dir: string; chunkNo: number }>) => {
    const m = ev.data;
    if (m.t !== "chunk") return;
    try {
        const [primary, secondary, chunk] = await readTrio(m.dir, m.chunkNo);
        if (primary.getUint8(0) !== 1) throw new Error(`invalid primary version in chunk ${m.chunkNo}`);
        const raw = parseChunk(primary, secondary, chunk);
        const blocks: ExtractedBlock[] = [];
        let errors = 0;
        for (const b of raw) {
            try { blocks.push(await extractBlock(b.blockCbor, b.blockHash, b.slotNo)); } catch { errors++; }
        }
        self.postMessage({ t: "done", chunkNo: m.chunkNo, blocks, errors });
    } catch (err) {
        self.postMessage({ t: "error", chunkNo: m.chunkNo, message: err instanceof Error ? err.message : String(err) });
    }
};

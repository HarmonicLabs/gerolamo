import { Database } from 'bun:sqlite';
import { toHex } from "@harmoniclabs/uint8array-utils";
interface BlockRow {
  block_fetch_RawCbor?: Uint8Array;
}

const DB_PATH = './src/db/chain/Gerolamo.db';
const db = new Database(DB_PATH);

Bun.serve({
    port: 3030,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/block/')) {
        return new Response('Endpoints: /block/{slot} /block/{hash}', { status: 200 });
        }
        const id = decodeURIComponent(url.pathname.slice(7));
        let row: BlockRow | null;
        if (/^\d+n?$/.test(id)) {
        const slot = BigInt(id.replace('n', ''));
        row = db.query<BlockRow, [bigint, bigint]>(`
            SELECT block_fetch_RawCbor FROM immutable_blocks WHERE slot = ?
            UNION ALL SELECT block_fetch_RawCbor FROM volatile_blocks WHERE slot = ?
            LIMIT 1
        `).get(slot, slot);
        } else {
        row = db.query<BlockRow, [string, string]>(`
            SELECT block_fetch_RawCbor FROM immutable_blocks WHERE block_hash = ?
            UNION ALL SELECT block_fetch_RawCbor FROM volatile_blocks WHERE block_hash = ?
            LIMIT 1
        `).get(id, id);
        }
        if (!row?.block_fetch_RawCbor) {
        return new Response('Block not found', { status: 404 });
        }
        return new Response(toHex(row.block_fetch_RawCbor), {
        headers: { 'Content-Type': 'application/cbor' }
        });
    },
});
console.log('Serving blocks on http://localhost:8080');
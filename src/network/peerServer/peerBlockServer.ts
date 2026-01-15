import { toHex } from "@harmoniclabs/uint8array-utils";
import { getBasePath } from '../../utils/paths';
import { DB } from '../../db/DB';
import { logger } from '../../utils/logger';

const BASE_PATH = getBasePath();
const network = process.env.NETWORK ?? "preprod";
const loadConfigFile = Bun.file(`${BASE_PATH}/config/${network}/config.json`);
const configText = await loadConfigFile.text();
const config = JSON.parse(configText);
const dbInstance = new DB(config.dbPath);

interface BlockRow {
    block_fetch_RawCbor?: Uint8Array;
};

Bun.serve({
    port: config.port || 3030,
    // unix: `${BASE_PATH}/Gerolamo.sock`,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/block/')) {
            return new Response('Endpoints: /block/{slot} /block/{hash}', { status: 200 });
        }
        const id = decodeURIComponent(url.pathname.slice(7));
        let row: BlockRow | null;
        if (/^\d+n?$/.test(id)) 
        {
            const slot = BigInt(id.replace('n', ''));
            row = dbInstance.getBlockBySlot(slot) ?? null;
        } else {
            row = dbInstance.getBlockByHash(id) ?? null;
        }
        if (!row?.block_fetch_RawCbor) 
        {
            return new Response('Block not found', { status: 404 });
        }
            return new Response(toHex(row.block_fetch_RawCbor), {
            headers: { 'Content-Type': 'application/cbor' }
        });
    },
});
logger.log(`Serving blocks on http://localhost:${config.port || 3030}`);
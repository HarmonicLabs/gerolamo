import { toHex } from "@harmoniclabs/uint8array-utils";
import { getBasePath } from '../../utils/paths';
import { DB } from '../../db/DB';
import { logger } from '../../utils/logger';
import { Worker } from "worker_threads";
import type { GerolamoConfig } from "../peerManagerWorkers/peerManagerWorker";

export async function startPeerBlockServer(config: GerolamoConfig, managerWorker: Worker | null) {
    const BASE_PATH = getBasePath();
    const dbInstance = new DB(config.dbPath);

    interface BlockRow {
        block_fetch_RawCbor?: Uint8Array;
    };

    Bun.serve({
        ...(config.unixSocket ? { unix: "./src/gerolamo.socket", } : { port: config.port || 3030 }),
        async fetch(req: Request): Promise<Response> {
            const url = new URL(req.url);
            if (req.method === "POST" && url.pathname === "/txsubmit") {
                if (!managerWorker) {
                    return new Response("Peer manager not available", { status: 500 });
                }
                try {
                    const txCbor = new Uint8Array(await req.arrayBuffer());
                    if (txCbor.length === 0) {
                        return new Response("Empty tx body", { status: 400 });
                    }
                    logger.info(`HTTP txsubmit: ${txCbor.length} bytes from ${req.headers.get("user-agent") || "unknown"}`);
                    managerWorker.postMessage({ type: "submitTx", txCbor });
                    return new Response(JSON.stringify({ status: "relayed to hot peers" }), {
                        status: 202,
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (e: any) {
                    logger.error("txsubmit error:", e.message || e);
                    return new Response("Invalid request", { status: 400 });
                }
            }
            if (url.pathname.startsWith('/utxo/')) {
                const ref = decodeURIComponent(url.pathname.slice(6));
                const utxo = await dbInstance.getUtxoByRef(ref);
                if (!utxo) {
                    return new Response('UTXO not found', { status: 404 });
                }
                return new Response(utxo.tx_out, {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (!url.pathname.startsWith('/block/') && !url.pathname.startsWith('/utxo/')) {
                return new Response('Endpoints: GET /block/{slot|hash} GET /utxo/{txhash:index} POST /txsubmit (CBOR tx body)', { status: 200 });
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
    logger.info(`Serving blocks and txsubmit on http://localhost:${config.port || 3030}`);
}
import { toHex } from "@harmoniclabs/uint8array-utils";
import { getBasePath } from "../../utils/paths";
import { DB } from "../db";
import { logger } from "../../utils/logger";

import type { GerolamoConfig } from "../peerManager";

export async function startPeerBlockServer(
    config: GerolamoConfig,
    manager: any,
) {
    const BASE_PATH = getBasePath();
    const dbInstance = new DB(config.dbPath);

    interface BlockRow {
        block_fetch_RawCbor?: Uint8Array;
    }

    Bun.serve({
        ...(config.unixSocket
            ? { unix: "./src/gerolamo.socket" }
            : { port: config.port || 3030 }),
        async fetch(req: Request): Promise<Response> {
            const url = new URL(req.url);
            if (req.method === "POST" && url.pathname === "/txsubmit") {
                if (!manager) {
                    return new Response("Peer manager not available", {
                        status: 500,
                    });
                }
                try {
                    const txCbor = new Uint8Array(await req.arrayBuffer());
                    if (txCbor.length === 0) {
                        return new Response("Empty tx body", { status: 400 });
                    }
                    logger.info(
                        `HTTP txsubmit: ${txCbor.length} bytes from ${
                            req.headers.get("user-agent") || "unknown"
                        }`,
                    );
                    manager.submitTx({ txCbor });
                    return new Response(
                        JSON.stringify({ status: "relayed to hot peers" }),
                        {
                            status: 202,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                } catch (e: any) {
                    logger.error("txsubmit error:", e.message || e);
                    return new Response("Invalid request", { status: 400 });
                }
            }
            if (url.pathname.startsWith("/utxo/")) {
                const ref = decodeURIComponent(url.pathname.slice(6));
                logger.info(`UTXO query for ref: ${ref}`);

                // Validate format: txhash (64 hex) or txhash:index (digits)
                if (!/^[0-9a-f]{64}(:\d+)?$/i.test(ref)) {
                    return new Response(
                        "Invalid format: /utxo/{64hex-txhash} or /utxo/{64hex-txhash}:{index}",
                        { status: 400 },
                    );
                }

                const parts = ref.split(":");
                let responseBody: string;
                let status = 200;

                if (parts.length === 1) {
                    // txhash only: all outputs
                    const txHash = parts[0];
                    const utxos = await dbInstance.getUtxosByTxHash(txHash);
                    if (utxos.length === 0) {
                        return new Response("No UTXOs found for tx hash", {
                            status: 404,
                        });
                    }
                    logger.info(
                        `Found ${utxos.length} UTXOs for tx ${
                            txHash.slice(0, 8)
                        }...`,
                    );
                    responseBody = JSON.stringify(
                        utxos.map((u: any) => u.tx_out),
                    );
                } else {
                    // specific utxo_ref
                    const idx = parseInt(parts[1], 10);
                    if (isNaN(idx) || idx < 0) {
                        return new Response("Invalid output index", {
                            status: 400,
                        });
                    }
                    const utxo = await dbInstance.getUtxoByRef(ref);
                    if (!utxo) {
                        return new Response("UTXO not found", { status: 404 });
                    }
                    responseBody = utxo.tx_out;
                }

                return new Response(responseBody, {
                    status,
                    headers: { "Content-Type": "application/json" },
                });
            }
            if (
                !url.pathname.startsWith("/block/") &&
                !url.pathname.startsWith("/utxo/")
            ) {
                return new Response(
                    "Endpoints: GET /block/{slot|hash} GET /utxo/{txhash:index} POST /txsubmit (CBOR tx body)",
                    { status: 200 },
                );
            }
            const id = decodeURIComponent(url.pathname.slice(7));
            let row: BlockRow | null;

            if (/^\d+n?$/.test(id)) {
                const slot = BigInt(id.replace("n", ""));
                row = dbInstance.getBlockBySlot(slot) ?? null;
            } else {
                row = dbInstance.getBlockByHash(id) ?? null;
            }

            if (!row?.block_fetch_RawCbor) {
                return new Response("Block not found", { status: 404 });
            }
            return new Response(toHex(row.block_fetch_RawCbor), {
                headers: { "Content-Type": "application/cbor" },
            });
        },
    });
    logger.info(
        `Serving blocks and txsubmit on http://localhost:${
            config.port || 3030
        }`,
    );
}

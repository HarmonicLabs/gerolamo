// src/blockfrost/server.ts
import { type Serve } from "bun";
import { MultiEraBlock, MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import {
    getBlockByHash,
    getHeaderByHash,
    resolveToHash,
} from "../sqlWorkers/sql"; // Adjust path as needed
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../utils/logger"; // Adjust path as needed

Bun.serve({
    port: 3000,
    routes: {
        "/headers/:id": async (req) => {
            const id = req.params.id;
            try {
                let hash: Uint8Array | undefined;
                try {
                    hash = await resolveToHash(id);
                } catch (error) {
                    return responseError("Invalid identifier");
                }
                if (!hash) return responseError("Header not found");

                const headerBytes = await getHeaderByHash(hash);
                if (!headerBytes) return responseError("Header not found");

                const multiHeader = MultiEraHeader.fromCbor(headerBytes);
                return Response.json(multiHeader.toJson());
            } catch (error) {
                logger.error("Error fetching header:", error);
                return responseError("Internal server error");
            }
        },

        "/blocks/:id": async (req) => {
            const id = req.params.id;
            console.log("Fetching block for id:", id);
            try {
                let hash: Uint8Array | undefined;
                try {
                    hash = await resolveToHash(id);
                    console.log("Resolved hash:", hash);
                } catch (error) {
                    return responseError("Invalid identifier");
                }
                if (!hash) return responseError("Block not found");

                const blockBytes = await getBlockByHash(hash);
                if (!blockBytes) return responseError("Block not found");
                console.log("Fetched block bytes:", blockBytes);

                const multiBlock = MultiEraBlock.fromCbor(blockBytes);
                console.log(
                    "Parsed MultiEraBlock:",
                    multiBlock.toCbor().toString(),
                );
                const result = {
                    block: multiBlock.toCbor().toString(),
                };
                return Response.json(result);
            } catch (error) {
                logger.error("Error fetching block:", error);
                return responseError("Internal server error");
            }
        },
    },

    fetch(req) {
        return new Response("Not Found", { status: 404 });
    },

    error(error) {
        logger.error("Server error:", error);
        return responseError("Internal server error");
    },
});

// Helper to handle BigInt serialization
function serializeBigInt(obj: any): any {
    return JSON.parse(
        JSON.stringify(
            obj,
            (key, value) =>
                typeof value === "bigint" ? value.toString() : value,
        ),
    );
}
function responseError(msg: string): Response {
    return Response.json({ error: msg }, {
        headers: { "Content-Type": "application/json" },
        status: 400,
    });
}

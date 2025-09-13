// src/blockfrost/server.ts
import { type Serve } from "bun";
import { MultiEraHeader, MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { getHeaderByHash, getBlockByHash, resolveToHash } from "../lmdbWorkers/lmdb"; // Adjust path as needed
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
					return new Response(JSON.stringify({ error: "Invalid identifier" }), { status: 400 });
				}
				if (!hash) return new Response(JSON.stringify({ error: "Header not found" }), { status: 404 });

				const headerBytes = await getHeaderByHash(hash);
				if (!headerBytes) return new Response(JSON.stringify({ error: "Header not found" }), { status: 404 });

				const multiHeader = MultiEraHeader.fromCbor(headerBytes);
				return Response.json(multiHeader.toJson());
			} catch (error) {
				logger.error("Error fetching header:", error);
				return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
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
					return new Response(JSON.stringify({ error: "Invalid identifier" }), { status: 400 });
				}
				if (!hash) return new Response(JSON.stringify({ error: "Block not found" }), { status: 404 });

				const blockBytes = await getBlockByHash(hash);
				if (!blockBytes) return new Response(JSON.stringify({ error: "Block not found" }), { status: 404 });
				console.log("Fetched block bytes:", blockBytes);

				const multiBlock = MultiEraBlock.fromCbor(blockBytes);
				console.log("Parsed MultiEraBlock:", multiBlock.toCbor().toString());
				const result = {
					block: multiBlock.toCbor().toString()
				}
				return Response.json(result);
				
			} catch (error) {
				logger.error("Error fetching block:", error);
				return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
			}
		},
	},

	fetch(req) {
		return new Response("Not Found", { status: 404 });
	},

	error(error) {
		logger.error("Server error:", error);
		return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
	},
});


// Helper to handle BigInt serialization
function serializeBigInt(obj: any): any {
	return JSON.parse(
	  JSON.stringify(obj, (key, value) =>
		typeof value === "bigint" ? value.toString() : value
	  )
	);
  }
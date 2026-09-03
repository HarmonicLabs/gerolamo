/**
 * OpenAPI 3.0 spec + Swagger UI docs for Gerolamo MiniBF.
 *
 * Served at:
 *   GET /openapi.json          — raw OpenAPI 3 document
 *   GET /api/v0/openapi.json   — alias under MiniBF root
 *   GET /docs                  — Swagger UI (CDN)
 *   GET /dashboard/docs        — alias
 *   GET /swagger               — alias
 *   GET /dashboard/ai|/ai      — redirect → /docs (old mistaken route)
 *
 * Local Blockfrost-subset explorer only. No external LLM. No ledger writes.
 */

export type OpenApiCtx = {
    network?: string;
    port?: number;
};

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, project_id, X-Requested-With",
    "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Gerolamo-Api": "openapi",
            ...CORS_HEADERS,
        },
    });
}

function buildSpec(ctx: OpenApiCtx = {}): Record<string, unknown> {
    const port = ctx.port ?? 3040;
    const network = ctx.network ?? process.env.NETWORK ?? "unknown";
    const serverUrl =
        port > 0 ? `http://localhost:${port}` : "/";

    const pathParam = (name: string, description: string) => ({
        name,
        in: "path" as const,
        required: true,
        schema: { type: "string" },
        description,
    });

    const okJson = (description: string, schema?: Record<string, unknown>) => ({
        description,
        content: {
            "application/json": {
                schema: schema ?? { type: "object" },
            },
        },
    });

    return {
        openapi: "3.0.3",
        info: {
            title: "Gerolamo MiniBF",
            version: "0.5.0",
            description: [
                "Blockfrost-compatible **subset** for dApps/wallets on this Gerolamo node.",
                "",
                "- Forward index writes `mb_*` projections (+ legacy `tx_index` / `address_tx` / `block_tx`).",
                "- History needs Phase-3 backfill on `.live` only (`scripts/backfill-minibf.mjs`).",
                "- Consensus never reads `mb_*`. Empty history ≠ broken route when lag > 0.",
                `- Network: \`${network}\`.`,
            ].join("\n"),
            contact: { name: "Harmonic Labs / Gerolamo" },
        },
        servers: [
            { url: serverUrl, description: "This Gerolamo HTTP server" },
            { url: "/api/v0", description: "MiniBF root (relative)" },
        ],
        tags: [
            { name: "root", description: "API meta" },
            { name: "network", description: "Tip + index density" },
            { name: "epochs", description: "Epoch helpers" },
            { name: "blocks", description: "Block queries" },
            { name: "addresses", description: "Address / UTxO" },
            { name: "scripts", description: "Reference scripts" },
            { name: "txs", description: "Transactions (mb_* when indexed)" },
            { name: "mempool", description: "Local mempool" },
            { name: "submit", description: "Tx submission" },
        ],
        paths: {
            "/api/v0/": {
                get: {
                    tags: ["root"],
                    summary: "API root",
                    operationId: "getRoot",
                    responses: {
                        "200": okJson("version + endpoint list", {
                            type: "object",
                            properties: {
                                url: { type: "string" },
                                version: { type: "string", example: "0.5.0" },
                                node: { type: "string" },
                                network: { type: "string" },
                                endpoints: {
                                    type: "array",
                                    items: { type: "string" },
                                },
                                note: { type: "string" },
                            },
                        }),
                    },
                },
            },
            "/api/v0/health": {
                get: {
                    tags: ["root"],
                    summary: "Health",
                    operationId: "getHealth",
                    responses: {
                        "200": okJson("is_healthy", {
                            type: "object",
                            properties: {
                                is_healthy: { type: "boolean" },
                            },
                        }),
                    },
                },
            },
            "/api/v0/network": {
                get: {
                    tags: ["network"],
                    summary: "Network snapshot",
                    description:
                        "Tip + UTxO count + mb_*/legacy index density and lag_slots.",
                    operationId: "getNetwork",
                    responses: {
                        "200": okJson("tip + index", {
                            type: "object",
                            properties: {
                                supply: { type: "object" },
                                stake: { type: "object" },
                                tip: {
                                    type: "object",
                                    properties: {
                                        slot: { type: "string" },
                                        hash: {
                                            type: "string",
                                            nullable: true,
                                        },
                                        epoch: {
                                            type: "integer",
                                            nullable: true,
                                        },
                                        epoch_nonce: {
                                            type: "string",
                                            nullable: true,
                                        },
                                    },
                                },
                                utxo_count: { type: "integer" },
                                index: {
                                    type: "object",
                                    properties: {
                                        tx_index: { type: "integer" },
                                        address_tx: { type: "integer" },
                                        mb_tx: { type: "integer" },
                                        mb_cursor_slot: { type: "integer" },
                                        lag_slots: { type: "integer" },
                                    },
                                },
                                note: { type: "string" },
                            },
                        }),
                    },
                },
            },
            "/api/v0/epochs/latest": {
                get: {
                    tags: ["epochs"],
                    summary: "Latest epoch",
                    operationId: "getEpochsLatest",
                    responses: {
                        "200": okJson("epoch derived from tip slot"),
                    },
                },
            },
            "/api/v0/epochs/latest/parameters": {
                get: {
                    tags: ["epochs"],
                    summary: "Latest epoch parameters",
                    description:
                        "From protocol_params table when populated; else sparse/null fields.",
                    operationId: "getEpochsLatestParameters",
                    responses: {
                        "200": okJson("protocol parameters subset"),
                    },
                },
            },
            "/api/v0/blocks/latest": {
                get: {
                    tags: ["blocks"],
                    summary: "Latest block",
                    operationId: "getBlocksLatest",
                    responses: {
                        "200": okJson("tip block summary"),
                        "404": okJson("no tip"),
                    },
                },
            },
            "/api/v0/blocks/{hash_or_slot}": {
                get: {
                    tags: ["blocks"],
                    summary: "Block by slot or hash",
                    operationId: "getBlock",
                    parameters: [
                        pathParam(
                            "hash_or_slot",
                            "Decimal slot or 64-hex block hash",
                        ),
                    ],
                    responses: {
                        "200": okJson("block summary"),
                        "404": okJson("not found"),
                    },
                },
            },
            "/api/v0/blocks/{hash_or_slot}/txs": {
                get: {
                    tags: ["blocks"],
                    summary: "Tx hashes in block",
                    description: "Prefers mb_block_tx; falls back to legacy block_tx.",
                    operationId: "getBlockTxs",
                    parameters: [
                        pathParam(
                            "hash_or_slot",
                            "Decimal slot or 64-hex block hash",
                        ),
                    ],
                    responses: {
                        "200": okJson("array of tx hashes"),
                        "404": okJson("block not found"),
                    },
                },
            },
            "/api/v0/addresses/{address}": {
                get: {
                    tags: ["addresses"],
                    summary: "Address summary",
                    operationId: "getAddress",
                    parameters: [
                        pathParam("address", "Bech32 address (addr… / stake…)"),
                    ],
                    responses: {
                        "200": okJson(
                            "amount + tx_count (tx_count from mb_address_tx when present)",
                        ),
                    },
                },
            },
            "/api/v0/addresses/{address}/utxos": {
                get: {
                    tags: ["addresses"],
                    summary: "Address UTxOs",
                    description: "Live UTxO set for address (not historical).",
                    operationId: "getAddressUtxos",
                    parameters: [
                        pathParam("address", "Bech32 address"),
                    ],
                    responses: {
                        "200": okJson("array of UTxOs"),
                    },
                },
            },
            "/api/v0/addresses/{address}/utxos/{asset}": {
                get: {
                    tags: ["addresses"],
                    summary: "Address UTxOs filtered by asset",
                    description:
                        "Live UTxO set for the address containing the 56-hex policy plus asset-name unit.",
                    operationId: "getAddressAssetUtxos",
                    parameters: [
                        pathParam("address", "Bech32 address"),
                        pathParam("asset", "Policy id + asset-name hex"),
                    ],
                    responses: {
                        "200": okJson("array of matching UTxOs"),
                    },
                },
            },
            "/api/v0/addresses/{address}/transactions": {
                get: {
                    tags: ["addresses"],
                    summary: "Address transactions",
                    description:
                        "Paginated via ?count=&page=. Needs mb_address_tx / backfill for history.",
                    operationId: "getAddressTransactions",
                    parameters: [
                        pathParam("address", "Bech32 address"),
                        {
                            name: "count",
                            in: "query",
                            required: false,
                            schema: {
                                type: "integer",
                                minimum: 1,
                                maximum: 100,
                                default: 20,
                            },
                        },
                        {
                            name: "page",
                            in: "query",
                            required: false,
                            schema: {
                                type: "integer",
                                minimum: 1,
                                default: 1,
                            },
                        },
                    ],
                    responses: {
                        "200": okJson("array of {tx_hash,slot,direction}"),
                    },
                },
            },
            "/api/v0/scripts/{hash}/cbor": {
                get: {
                    tags: ["scripts"],
                    summary: "Reference script CBOR",
                    description:
                        "Resolves a reference script currently present in the ledger UTxO set.",
                    operationId: "getScriptCbor",
                    parameters: [
                        pathParam("hash", "56-hex script hash"),
                    ],
                    responses: {
                        "200": okJson("{cbor}"),
                        "404": okJson("reference script not found"),
                    },
                },
            },
            "/api/v0/txs/{hash}": {
                get: {
                    tags: ["txs"],
                    summary: "Transaction by hash",
                    description:
                        "Prefers mb_tx; falls back to legacy tx_index. Many BF fields null.",
                    operationId: "getTx",
                    parameters: [
                        pathParam("hash", "64-hex transaction hash"),
                    ],
                    responses: {
                        "200": okJson("tx subset"),
                        "404": okJson("not indexed"),
                    },
                },
            },
            "/api/v0/txs/{hash}/utxos": {
                get: {
                    tags: ["txs"],
                    summary: "Transaction UTxOs (full IO when indexed)",
                    description:
                        "Prefers mb_tx_in/mb_tx_out full IO; falls back to unspent outs in live UTxO set.",
                    operationId: "getTxUtxos",
                    parameters: [
                        pathParam("hash", "64-hex transaction hash"),
                    ],
                    responses: {
                        "200": okJson("inputs + outputs"),
                    },
                },
            },
            "/api/v0/txs/{hash}/utxos/{index}": {
                get: {
                    tags: ["txs"],
                    summary: "Single tx output if unspent",
                    operationId: "getTxUtxoByIndex",
                    parameters: [
                        pathParam("hash", "64-hex transaction hash"),
                        pathParam("index", "Output index (decimal)"),
                    ],
                    responses: {
                        "200": okJson("single UTxO"),
                        "404": okJson("spent or missing"),
                    },
                },
            },
            "/api/v0/mempool": {
                get: {
                    tags: ["mempool"],
                    summary: "Local mempool",
                    operationId: "getMempool",
                    responses: {
                        "200": okJson("SharedMempool snapshot"),
                    },
                },
            },
            "/api/v0/tx/submit": {
                post: {
                    tags: ["submit"],
                    summary: "Submit raw transaction",
                    description:
                        "Body: raw CBOR bytes (application/cbor) or hex text. Relayed to hot peers when manager available.",
                    operationId: "submitTx",
                    requestBody: {
                        required: true,
                        content: {
                            "application/cbor": {
                                schema: {
                                    type: "string",
                                    format: "binary",
                                },
                            },
                            "application/octet-stream": {
                                schema: {
                                    type: "string",
                                    format: "binary",
                                },
                            },
                            "text/plain": {
                                schema: {
                                    type: "string",
                                    description: "hex-encoded CBOR",
                                },
                            },
                        },
                    },
                    responses: {
                        "202": okJson("accepted / relayed"),
                        "400": okJson("invalid body"),
                        "503": okJson("submit path unavailable"),
                    },
                },
            },
        },
        externalDocs: {
            description: "Live stats dashboard",
            url: "/stats",
        },
    };
}

/**
 * Self-contained Swagger UI page (CDN). tryItOut hits same-origin MiniBF.
 */
export function openApiDocsHtml(port: number, network: string): string {
    const net = String(network || "unknown");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Gerolamo · MiniBF OpenAPI · :${port}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" crossorigin="anonymous"/>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #0b0f14; color: #e6edf3;
    font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid #1e2a36; background: #0d1218;
    position: sticky; top: 0; z-index: 20;
  }
  header h1 { margin: 0; font-size: 15px; font-weight: 650; }
  header .meta { color: #8b9bab; font-size: 12px; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #121820; padding: 1px 5px; border-radius: 4px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    border: 1px solid #234; color: #3fb950; background: #0d1f14;
  }
  .note {
    max-width: none; margin: 0; padding: 10px 16px 0;
    color: #8b9bab; font-size: 12px;
  }
  /* Full-width shell; two-column ops list below */
  #swagger-ui { max-width: none; margin: 0; padding: 0 8px 24px; }
  .swagger-ui .topbar { display: none; }
  .swagger-ui .information-container.wrapper { padding-top: 8px; padding-bottom: 4px; }
  .swagger-ui .wrapper { max-width: none !important; padding: 0 8px !important; }

  /* Body text light on dark */
  .swagger-ui,
  .swagger-ui .info .title,
  .swagger-ui .opblock-tag,
  .swagger-ui .opblock .opblock-summary-description,
  .swagger-ui .opblock .opblock-summary-path,
  .swagger-ui .opblock .opblock-summary-method,
  .swagger-ui table thead tr td,
  .swagger-ui table thead tr th,
  .swagger-ui .parameter__name,
  .swagger-ui .parameter__type,
  .swagger-ui .response-col_status,
  .swagger-ui .response-col_description,
  .swagger-ui .tab li,
  .swagger-ui .model-title,
  .swagger-ui label {
    color: #e6edf3 !important;
  }

  /* Dropdowns / inputs: BLACK text on light field (readable) */
  .swagger-ui select,
  .swagger-ui select.operation-tag-content,
  .swagger-ui .opblock select,
  .swagger-ui .responses-inner select,
  .swagger-ui .content-type-wrapper select,
  .swagger-ui .parameter__content-type select,
  .swagger-ui .body-param-content-type select,
  .swagger-ui .response-content-type select,
  .swagger-ui .parameters-col_description select,
  .swagger-ui input,
  .swagger-ui input[type="text"],
  .swagger-ui input[type="search"],
  .swagger-ui input[type="email"],
  .swagger-ui input[type="password"],
  .swagger-ui textarea {
    color: #111 !important;
    background: #f4f6f8 !important;
    border: 1px solid #9aa7b5 !important;
    border-radius: 4px !important;
  }
  .swagger-ui select option {
    color: #111 !important;
    background: #fff !important;
  }

  .swagger-ui .scheme-container,
  .swagger-ui .info,
  .swagger-ui section.models,
  .swagger-ui .opblock,
  .swagger-ui .opblock-body,
  .swagger-ui .opblock-section-header,
  .swagger-ui .model-box,
  .swagger-ui .dialog-ux .modal-ux {
    background: #121820 !important;
    border-color: #1e2a36 !important;
    box-shadow: none !important;
  }
  .swagger-ui .opblock.opblock-get { border-color: #1f6feb; background: rgba(31,111,235,.08); }
  .swagger-ui .opblock.opblock-post { border-color: #3fb950; background: rgba(63,185,80,.08); }
  .swagger-ui .btn.execute { background: #1f6feb; border-color: #1f6feb; color: #fff !important; }
  .swagger-ui .btn.cancel { color: #f85149 !important; border-color: #f85149 !important; }
  .swagger-ui .highlight-code, .swagger-ui .microlight {
    background: #0d1117 !important;
  }

  /*
   * Two-column try-it-out: request params left, responses right.
   * Mirrors BF explorer split so less vertical scrolling.
   */
  @media (min-width: 1100px) {
    .swagger-ui .opblock-body {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px 16px;
      align-items: start;
    }
    .swagger-ui .opblock-section,
    .swagger-ui .opblock-description-wrapper,
    .swagger-ui .execute-wrapper {
      grid-column: 1;
    }
    .swagger-ui .responses-wrapper {
      grid-column: 2;
      grid-row: 1 / span 20;
      margin-top: 0 !important;
      position: sticky;
      top: 64px;
      max-height: calc(100vh - 80px);
      overflow: auto;
    }
    .swagger-ui .responses-inner {
      padding-top: 0 !important;
    }
  }
  @media (max-width: 1099px) {
    .swagger-ui .opblock-body {
      display: block !important;
    }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>Gerolamo · MiniBF OpenAPI</h1>
    <div class="meta">
      port <code>:${port}</code> · network <code>${net}</code> ·
      <a href="/stats">← stats</a> ·
      <a href="/openapi.json">openapi.json</a> ·
      <a href="/api/v0/">/api/v0</a>
    </div>
  </div>
  <span class="badge">OpenAPI 3.0 · BF subset</span>
</header>
<p class="note">
  Swagger UI for <strong>this node’s</strong> Mini-Blockfrost surface.
  Try-it-out calls same-origin routes. CDN assets need network once.
  Not full Blockfrost — history sparse until <code>mb_*</code> backfill.
</p>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js" crossorigin="anonymous"></script>
<script>
window.onload = function () {
  if (typeof SwaggerUIBundle === "undefined") {
    document.getElementById("swagger-ui").innerHTML =
      '<p style="padding:16px;color:#f85149">Swagger UI CDN failed to load. Spec still at <a href="/openapi.json">/openapi.json</a>.</p>';
    return;
  }
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: "StandaloneLayout",
    tryItOutEnabled: true,
        persistAuthorization: true,
        displayRequestDuration: true,
    syntaxHighlight: { activate: true, theme: "monokai" },
    requestInterceptor: function (req) {
      if (!req.headers) req.headers = {};
      if (!req.headers.Accept) req.headers.Accept = "application/json";
      return req;
    },
  });
};
</script>
</body>
</html>`;
}

/**
 * Handle OpenAPI / docs routes. Returns null if path is not ours.
 */
export async function handleOpenApiRoutes(
    req: Request,
    url: URL,
    ctx: OpenApiCtx = {},
): Promise<Response | null> {
    const path = url.pathname;

    // OPTIONS preflight for /docs + /openapi.json (external explorers / CDN)
    if (
        req.method === "OPTIONS" &&
        (path === "/openapi.json" ||
            path === "/api/v0/openapi.json" ||
            path === "/docs" ||
            path === "/docs/" ||
            path === "/dashboard/docs" ||
            path === "/dashboard/docs/" ||
            path === "/swagger" ||
            path === "/swagger/" ||
            path === "/dashboard/api" ||
            path === "/dashboard/api/")
    ) {
        return new Response(null, {
            status: 204,
            headers: {
                ...CORS_HEADERS,
                "X-Gerolamo-Api": "openapi",
            },
        });
    }

    if (
        req.method === "GET" &&
        (path === "/openapi.json" || path === "/api/v0/openapi.json")
    ) {
        return json(buildSpec(ctx));
    }

    if (
        req.method === "GET" &&
        (path === "/docs" ||
            path === "/docs/" ||
            path === "/dashboard/docs" ||
            path === "/dashboard/docs/" ||
            path === "/swagger" ||
            path === "/swagger/" ||
            path === "/dashboard/api" ||
            path === "/dashboard/api/")
    ) {
        const port = ctx.port ?? 0;
        const network = ctx.network ?? process.env.NETWORK ?? "unknown";
        return new Response(openApiDocsHtml(port, String(network)), {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                ...CORS_HEADERS,
            },
        });
    }

    // Old mistaken "AI playground" routes → docs
    if (
        req.method === "GET" &&
        (path === "/dashboard/ai" ||
            path === "/dashboard/ai/" ||
            path === "/ai" ||
            path === "/ai/" ||
            path === "/ai/catalog")
    ) {
        return new Response(null, {
            status: 302,
            headers: {
                Location: "/docs",
                "Cache-Control": "no-store",
            },
        });
    }

    return null;
}

/** For tests / tooling. */
export function getOpenApiSpec(ctx: OpenApiCtx = {}): Record<string, unknown> {
    return buildSpec(ctx);
}

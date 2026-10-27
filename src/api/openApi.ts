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

import { settings } from "../config/settings";
import { blockfrostRouter } from "./miniBlockfrost";
import vendored from "./blockfrost/blockfrost-openapi.responses.json";

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

/** One OpenAPI operation per route of the Blockfrost router, with Blockfrost's own 200 schema where it has one. */
function blockfrostPaths(okJson: (d: string, s?: Record<string, unknown>) => unknown): Record<string, Record<string, unknown>> {
    const schemas = (vendored as { paths: Record<string, Record<string, unknown>> }).paths;
    const err = (d: string) => okJson(d, { type: "object", properties: { status_code: { type: "integer" }, error: { type: "string" }, message: { type: "string" } }, required: ["status_code", "error", "message"] });
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of blockfrostRouter.list()) {
        const key = "/api/v0" + (r.path === "/" ? "/" : r.path);
        const params = [...r.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
        const paged = r.method === "GET" && /s$|\/(txs|utxos|history|addresses|delegators|blocks|updates|votes|redeemers|next|previous|stakes|registrations|delegations|withdrawals|mirs|rewards|transactions|labels|\{label\}|cbor)$/.test(r.path);
        const query = paged ? ["count", "page", "order"].map((n) => ({ name: n, in: "query", required: false, schema: n === "order" ? { type: "string", enum: ["asc", "desc"] } : { type: "integer" } })) : [];
        (out[key] ??= {})[r.method.toLowerCase()] = {
            tags: [r.path.split("/")[1] || "root"],
            summary: schemas[r.path] ? `Blockfrost ${r.path}` : `Gerolamo extension ${r.path}`,
            operationId: `${r.method.toLowerCase()}${r.path.replace(/[{}]/g, "").replace(/\/(\w)/g, (_m, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "")}` || "getRoot",
            parameters: [...params, ...query],
            ...(r.method === "POST" ? { requestBody: { content: { "application/cbor": { schema: { type: "string", format: "binary" } }, "application/json": { schema: { type: "object" } } } } } : {}),
            responses: { "200": okJson("OK", (schemas[r.path] as Record<string, unknown>) ?? { type: "object" }), "400": err("Bad Request"), "404": err("Not Found") },
        };
    }
    return out;
}

function buildSpec(ctx: OpenApiCtx = {}): Record<string, unknown> {
    const port = ctx.port ?? 3040;
    const network = ctx.network ?? settings().network;
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
            title: "Gerolamo mini-Blockfrost",
            version: "0.1.92",
            description: [
                "Blockfrost-compatible API (paths and response schemas of Blockfrost OpenAPI 0.1.92) served by this Gerolamo node.",
                "",
                "- Current state (accounts, pools, DReps, proposals, UTxOs) comes from the node's ledger store.",
                "- History (transactions, assets, metadata, certificates, scripts) comes from the explorer projection (`mb_*`).",
                "- Errors are Blockfrost bodies `{status_code, error, message}`; `count` / `page` / `order` as Blockfrost.",
                "- Coverage and known differences: docs/parity/blockfrost.md.",
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
        paths: blockfrostPaths(okJson),
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
        const network = ctx.network ?? settings().network;
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

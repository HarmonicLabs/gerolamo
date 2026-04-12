#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// gerolamo-start — Production service orchestrator
// Starts all Gerolamo services with unified logging and Ctrl-C shutdown.
//
// Services:
//   1. websockify       (port 3060) — noVNC/websockify WSS↔TCP proxy to Cardano relay
//   2. dashboard-server (port 3050) — REST API + SSE + static dashboard
//   3. gerolamo node    (port 3030) — Cardano node (optional, --with-node)
//
// Usage:
//   bun scripts/gerolamo-start.ts [--with-node] [--dev]
//   gerolamo-start                # if symlinked to PATH
// ---------------------------------------------------------------------------

import { spawn, type Subprocess } from "bun";
import { resolve } from "path";
import { existsSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const args = new Set(Bun.argv.slice(2));
const withNode = !args.has("--no-node");
const devMode = args.has("--dev");

// Cardano preprod relay target for websockify
const RELAY_HOST = "preprod-node.play.dev.cardano.org";
const RELAY_PORT = 3001;
const WEBSOCKIFY_PORT = 3060;
const DASHBOARD_PORT = 3050;

const procs: { name: string; proc: Subprocess }[] = [];

function log(service: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  const colors: Record<string, string> = {
    websockify: "\x1b[35m",  // magenta
    dashboard: "\x1b[36m",   // cyan
    node: "\x1b[33m",        // yellow
    vite: "\x1b[32m",        // green
    system: "\x1b[90m",      // gray
  };
  const c = colors[service] ?? "\x1b[0m";
  process.stdout.write(`${c}[${ts}] [${service}]\x1b[0m ${msg}\n`);
}

function startService(name: string, cmd: string[], env?: Record<string, string>): Subprocess {
  log("system", `Starting ${name}: ${cmd.join(" ")}`);

  const proc = spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream stdout
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) log(name, line);
      }
    }
    if (buf.trim()) log(name, buf);
  })();

  // Stream stderr
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) log(name, `\x1b[31m${line}\x1b[0m`);
      }
    }
    if (buf.trim()) log(name, `\x1b[31m${buf}\x1b[0m`);
  })();

  procs.push({ name, proc });
  return proc;
}

function shutdown() {
  log("system", "Shutting down all services...");
  for (const { name, proc } of procs) {
    try {
      proc.kill();
      log("system", `Stopped ${name}`);
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// 1. websockify — Bun-native WSS↔TCP proxy (websockify protocol)
//    Browser connects to ws://localhost:3060
//    Proxy forwards raw binary to preprod-node.play.dev.cardano.org:3001
//    (Uses our Bun-native implementation — npm websockify is incompatible
//     with Bun's ws Set-based protocol negotiation)
// ---------------------------------------------------------------------------
const websockifyProxy = resolve(ROOT, "scripts/websockify-proxy.ts");

startService("websockify", [
  "bun", websockifyProxy,
  String(WEBSOCKIFY_PORT),
  `${RELAY_HOST}:${RELAY_PORT}`,
]);

log("system", `websockify: ws://localhost:${WEBSOCKIFY_PORT} => ${RELAY_HOST}:${RELAY_PORT}`);

// ---------------------------------------------------------------------------
// 2. Dashboard build (production) or Vite dev server
// ---------------------------------------------------------------------------
const dashboardDist = resolve(ROOT, "dashboard/dist");

if (devMode) {
  // Dev mode: run Vite dev server
  startService("vite", ["bun", "x", "vite", "--port", "3041"], {
    // Vite reads this to know where websockify is
    VITE_WEBSOCKIFY_URL: `ws://localhost:${WEBSOCKIFY_PORT}`,
  });
} else {
  // Production: build dashboard first if needed
  if (!existsSync(resolve(dashboardDist, "index.html"))) {
    log("system", "Building dashboard...");
    const build = spawn(["bun", "x", "vite", "build"], { cwd: resolve(ROOT, "dashboard") });
    await build.exited;
    if (build.exitCode !== 0) {
      log("system", "\x1b[31mDashboard build failed!\x1b[0m");
      process.exit(1);
    }
    log("system", "Dashboard built successfully.");
  }
}

// ---------------------------------------------------------------------------
// 3. Dashboard server — REST + SSE + static files
// ---------------------------------------------------------------------------
const dashboardArgs = [
  "bun", "scripts/dashboard-server.ts",
  "--port", String(DASHBOARD_PORT),
  "--db", resolve(ROOT, "ledger/gerolamo.db"),
];

if (!devMode && existsSync(resolve(dashboardDist, "index.html"))) {
  dashboardArgs.push("--static-dir", dashboardDist);
}

startService("dashboard", dashboardArgs);

// ---------------------------------------------------------------------------
// 4. Gerolamo node (optional)
// ---------------------------------------------------------------------------
if (withNode) {
  startService("node", ["bun", "src/index.ts", "start-gerolamo"]);
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
log("system", "");
log("system", "╔═══════════════════════════════════════════════════════╗");
log("system", "║              GEROLAMO — Cardano in TypeScript         ║");
log("system", "║                     Preprod Network                   ║");
log("system", "╠═══════════════════════════════════════════════════════╣");
log("system", `║  Dashboard:   http://localhost:${DASHBOARD_PORT}                    ║`);
log("system", `║  API:         http://localhost:${DASHBOARD_PORT}/api                ║`);
log("system", `║  websockify:  ws://localhost:${WEBSOCKIFY_PORT}  (WSS↔TCP proxy)    ║`);
log("system", `║  Relay:       ${RELAY_HOST}:${RELAY_PORT}    ║`);
if (withNode) {
log("system", `║  Node API:    http://localhost:3030                   ║`);
}
if (devMode) {
log("system", `║  Vite Dev:    http://localhost:3041                   ║`);
}
log("system", "╠═══════════════════════════════════════════════════════╣");
log("system", "║  Press Ctrl-C to stop all services                   ║");
log("system", "╚═══════════════════════════════════════════════════════╝");
log("system", "");

// Keep process alive
await new Promise(() => {});

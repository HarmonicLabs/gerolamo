import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// GEROLAMO_WS_N2N=ws://host:port is exposed to the page as import.meta.env.GEROLAMO_WS_N2N
import { fileURLToPath } from "node:url";
const stub = fileURLToPath(new URL("./src/shims/node-empty.ts", import.meta.url));

export default defineConfig({
  plugins: [solidPlugin()],
  // The Mithril verifier is shared with the node; its local-digest helper imports fs/path, which the browser never calls.
  resolve: { alias: { fs: stub, path: stub, "node:fs": stub, "node:path": stub } },
  envPrefix: ["VITE_", "GEROLAMO_"],
  server: { port: 5180, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
});

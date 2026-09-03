import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  // Relative asset paths: the node serves the built app under /explorer/.
  base: "./",
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 3041,
    proxy: {
      // explorer → the node's Mini-Blockfrost API; everything else → dashboard-server
      "/api/v0": "http://localhost:3030",
      "/metrics": "http://localhost:3030",
      "/api": "http://localhost:3050",
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
});

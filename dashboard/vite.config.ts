import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 3041,
    proxy: {
      "/api": "http://localhost:3050",
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
});

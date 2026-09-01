import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  root: "src/mainview",
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      external(id) {
        return id.includes("node_modules/electrobun");
      },
      output: {
        manualChunks(id) {
          if (id.includes("solid-js") || id.includes("node_modules/solid")) return "solid";
          if (id.includes("marked")) return "vendor";
        },
      },
    },
  },
});

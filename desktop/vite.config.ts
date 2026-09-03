import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { execSync } from "child_process";
import { readFileSync } from "fs";

/** UI build identity baked in at build time: package version + git commit (+ -dirty) + build time. */
function uiBuildLabel(): string {
  let version = "0.0.0";
  try {
    version = String(JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version ?? version);
  } catch {
    /* keep default */
  }
  const git = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: __dirname, encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      return "";
    }
  };
  const commit = git("git rev-parse --short HEAD");
  const dirty = commit && git("git status --porcelain --untracked-files=no").length > 0;
  return `${version}${commit ? `+${commit}${dirty ? "-dirty" : ""}` : ""}`;
}

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  define: {
    __GEROLAMO_UI_VERSION__: JSON.stringify(uiBuildLabel()),
    __GEROLAMO_UI_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
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

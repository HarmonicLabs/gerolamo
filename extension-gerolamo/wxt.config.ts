import { defineConfig } from "wxt";
import solid from "vite-plugin-solid";
import { resolve } from "path";

export default defineConfig({
  manifest: {
    name: "Gerolamino",
    description: "Standalone Cardano blockchain explorer — no API key required",
    version: "0.3.0",
    permissions: ["storage"],
    host_permissions: [
      "https://preprod.koios.rest/*",
      "https://api.koios.rest/*",
    ],
    icons: {
      "16": "icon-16.png",
      "48": "icon-48.png",
      "128": "icon-128.png",
    },
    action: {
      default_icon: {
        "16": "icon-16.png",
        "48": "icon-48.png",
        "128": "icon-128.png",
      },
    },
  },
  vite: () => ({
    plugins: [solid()],
    resolve: {
      alias: {
        "@": resolve(__dirname),
      },
    },
    define: {
      "process.env": "{}",
      global: "globalThis",
    },
  }),
});

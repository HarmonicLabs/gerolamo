import { defineConfig } from "wxt";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  manifest: {
    name: "Gerolamo",
    description: "Cardano browser node — Ouroboros mini-protocols in the browser via websockify",
    version: "0.1.0",
    permissions: ["storage"],
    host_permissions: ["http://localhost:3050/*"],
    action: {
      default_popup: "popup.html",
      default_icon: {
        "16": "icon-16.png",
        "48": "icon-48.png",
        "128": "icon-128.png",
      },
    },
    icons: {
      "16": "icon-16.png",
      "48": "icon-48.png",
      "128": "icon-128.png",
    },
  },
  vite: () => ({
    plugins: [solidPlugin(), tailwindcss()],
    resolve: {
      alias: {
        "@": new URL(".", import.meta.url).pathname,
        "node:net": new URL("lib/shims/net.ts", import.meta.url).pathname,
      },
    },
    optimizeDeps: {
      include: [
        "@harmoniclabs/ouroboros-miniprotocols-ts",
        "@harmoniclabs/cardano-ledger-ts",
        "@harmoniclabs/cbor",
        "@harmoniclabs/crypto",
        "@harmoniclabs/bip32_ed25519",
        "@harmoniclabs/uint8array-utils",
        "@harmoniclabs/plutus-data",
      ],
    },
    define: {
      "process.env": "{}",
    },
    build: {
      target: "esnext",
    },
  }),
});

export default {
  app: {
    name: "Gerolamo",
    identifier: "gerolamo.harmoniclabs.dev",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/": "views/mainview/",
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false, icon: "assets/icon.png" },
    win: { bundleCEF: false, icon: "assets/icon.png" },
  },
} as any;

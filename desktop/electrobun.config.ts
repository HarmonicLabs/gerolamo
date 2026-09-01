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
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} as any;

import { BrowserWindow, defineElectrobunRPC } from "electrobun";
import { detectInstallation } from "./detect";
import {
  getNodeStatus,
  healthCheck,
  hydrate,
  listNodes,
  logs,
  openExternal,
  pickDirectory,
  startNode,
  stopNode,
  wipeChainDb,
  wipeSnapshots,
  writeConfig,
} from "./nodeService";
import { applyWindowIcon } from "./windowIcon";
import { getAppDb, getPref, setPref } from "./database";
import {
  bootstrapLogs,
  bootstrapStatus,
  markBootstrapSkipped,
  startBootstrap,
  stopBootstrap,
} from "./mithrilService";

process.env.GDK_BACKEND = "x11";
process.env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
if (!process.env.WEBKIT_FORCE_SOFTWARE_OPENGL) {
  process.env.WEBKIT_FORCE_SOFTWARE_OPENGL = "1";
}

type IdParams = { id?: string; maxLines?: number; config?: any; url?: string; key?: string; value?: string | null };

function asParams(params?: unknown): IdParams {
  return params && typeof params === "object" ? (params as IdParams) : {};
}

const bunRpc = defineElectrobunRPC("bun", {
  handlers: {
    requests: {
      async detect(_params?: unknown) {
        return detectInstallation();
      },
      async writeConfig(params?: unknown) {
        return writeConfig(asParams(params).config ?? {});
      },
      async list(_params?: unknown) {
        return listNodes();
      },
      async pickPath(_params?: unknown) {
        return pickDirectory();
      },
      async "node.start"(params?: unknown) {
        return startNode(asParams(params).config ?? {});
      },
      async "node.stop"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return { success: false, error: "id required" };
        return stopNode(id);
      },
      async "node.status"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return null;
        return getNodeStatus(id);
      },
      async "node.health"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return { healthy: false, message: "id required" };
        return healthCheck(id);
      },
      async "node.logs"(params?: unknown) {
        const p = asParams(params);
        if (!p.id) return { ok: false, lines: [], error: "id required" };
        return logs(p.id, p.maxLines ?? 120);
      },
      async "bootstrap.start"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return { ok: false, error: "id required" };
        return startBootstrap(id);
      },
      async "bootstrap.stop"(_params?: unknown) {
        return stopBootstrap();
      },
      async "bootstrap.status"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) {
          return {
            stage: "idle",
            stageLabel: "",
            processAlive: false,
            snapshotHuman: null,
            dataHuman: null,
            immutableCount: null,
            logPath: null,
            pid: null,
            exitCode: null,
          };
        }
        return bootstrapStatus(id);
      },
      async "bootstrap.logs"(params?: unknown) {
        const p = asParams(params);
        if (!p.id) return { ok: false, lines: [] };
        return bootstrapLogs(p.id, p.maxLines ?? 120);
      },
      async "bootstrap.skip"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return { ok: false, error: "id required" };
        return markBootstrapSkipped(id);
      },
      async openExternal(params?: unknown) {
        const url = asParams(params).url;
        if (!url) return { ok: false, error: "url required" };
        return openExternal(url);
      },
      async "wipe.db"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return { ok: false, error: "id required" };
        return wipeChainDb(id);
      },
      async "pref.get"(params?: unknown) {
        const key = asParams(params).key;
        if (!key) return { value: null };
        return { value: getPref(getAppDb(), key) };
      },
      async "pref.set"(params?: unknown) {
        const p = asParams(params);
        if (!p.key) return { ok: false, error: "key required" };
        setPref(getAppDb(), p.key, p.value ?? null);
        return { ok: true };
      },
      async "wipe.snapshots"(params?: unknown) {
        const id = asParams(params).id;
        if (!id) return { ok: false, error: "id required" };
        return wipeSnapshots(id);
      },
    },
  },
});

const mainWindow = new BrowserWindow({
  title: "Gerolamo",
  url: "views://mainview/index.html",
  rpc: bunRpc,
  renderer: "native",
  frame: { width: 1280, height: 900, x: 80, y: 40 },
});

// Taskbar / window icon on Linux (dev builds show a generic icon otherwise).
setTimeout(() => {
  try {
    applyWindowIcon((mainWindow as any).ptr);
  } catch (e) {
    console.warn("[icon]", e);
  }
}, 250);

setTimeout(() => {
  try {
    hydrate();
  } catch (e) {
    console.error("[hydrate]", e);
  }
}, 0);

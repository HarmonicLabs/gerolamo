import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Linux taskbar/window icon.
 *
 * Electrobun writes `Resources/appIcon.png` and a .desktop entry into the
 * bundle, but the panel only picks that up once the .desktop file is
 * installed system-wide. In dev the window shows the generic X icon. The
 * native wrapper exports `setWindowIcon(windowPtr, path)` (gtk_window_set_icon,
 * which sets _NET_WM_ICON), it is just not surfaced in the JS API, so we
 * dlopen the already-loaded library and call it ourselves. Best effort:
 * any failure is logged and the app keeps running.
 */

const ICON_CANDIDATES = ["Resources/appIcon.png", "assets/icon.png"];

/** Walk up from `from` looking for one of the icon files. */
export function findIconPath(from: string, candidates = ICON_CANDIDATES, maxUp = 8): string | null {
  let dir = resolve(from);
  for (let i = 0; i <= maxUp; i++) {
    for (const rel of candidates) {
      const p = join(dir, rel);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const LIB_CANDIDATES = (from: string) => [
  "libNativeWrapper.so",
  join(process.cwd(), "libNativeWrapper.so"),
  join(from, "..", "..", "libNativeWrapper.so"),
  join(process.cwd(), "node_modules", "electrobun", "dist-linux-x64", "libNativeWrapper.so"),
];

export function applyWindowIcon(windowPtr: unknown, opts: { from?: string; iconPath?: string | null } = {}): boolean {
  if (process.platform !== "linux") return false;
  if (windowPtr == null) return false;
  const from = opts.from ?? import.meta.dir;
  const icon = opts.iconPath ?? findIconPath(from);
  if (!icon) {
    console.warn("[icon] no appIcon.png / assets/icon.png found");
    return false;
  }
  try {
    // Loaded lazily so a missing bun:ffi (tests, non-bun) never breaks startup.
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    let lastErr: unknown = null;
    for (const lib of LIB_CANDIDATES(from)) {
      try {
        const native = dlopen(lib, {
          setWindowIcon: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.void },
        });
        const cpath = Buffer.from(icon + "\0", "utf8");
        native.symbols.setWindowIcon(windowPtr as any, ptr(cpath));
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    console.warn("[icon] setWindowIcon unavailable:", lastErr instanceof Error ? lastErr.message : lastErr);
    return false;
  } catch (err) {
    console.warn("[icon] failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Last `maxLines` lines of a file, reading only its tail.
 *
 * The previous implementation did `readFileSync(path).split("\n").slice(-n)`,
 * which loads the whole file and splits every line. Polled every second by the
 * Control Center against a node log that reaches gigabytes at debug level, it
 * drove the desktop's Bun process to 32 GB and the OOM killer took it — and the
 * node with it (two kills seen in the kernel log). Read a bounded window from
 * the end instead.
 */
export function tailFileLines(path: string, maxLines = 200, maxBytes?: number): string[] {
  if (!existsSync(path)) return [];
  const lines = Math.max(1, Math.trunc(maxLines));
  // Generous per-line estimate; the window grows if the tail has very long lines.
  let window = Math.min(64 * 1024 * 1024, Math.max(64 * 1024, maxBytes ?? lines * 512));
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    for (;;) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf8");
      const parts = text.split(/\r?\n/);
      if (start > 0) {
        // Enough lines even after dropping the partial first one?
        if (parts.length - 1 >= lines + 1 || window >= size) {
          parts.shift(); // partial line from before the window
          return parts.slice(-lines);
        }
        window = Math.min(size, window * 4);
        continue;
      }
      return parts.slice(-lines);
    }
  } catch {
    return [];
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function tailFileText(path: string, maxLines = 80): string {
  return tailFileLines(path, maxLines).join("\n");
}

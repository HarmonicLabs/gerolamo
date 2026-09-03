import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

/**
 * Append-only log with size-based rotation (`daemon.log` → `daemon.1.log` …).
 * The node's stdout/stderr are piped through this instead of straight into one
 * ever-growing file, so a long sync cannot fill the disk or hand the UI a
 * multi-gigabyte file to tail.
 */
export class RotatingLog {
  private size = -1;
  constructor(
    readonly path: string,
    readonly maxBytes = 50 * 1024 * 1024,
    readonly keep = 5,
  ) {}

  append(chunk: string | Uint8Array): void {
    try {
      if (this.size < 0) this.size = existsSync(this.path) ? statSync(this.path).size : 0;
      const len = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (this.size > 0 && this.size + len > this.maxBytes) this.rotate();
      appendFileSync(this.path, chunk);
      this.size += len;
    } catch {
      /* logging must never throw into the caller */
    }
  }

  private rotate(): void {
    const dot = this.path.lastIndexOf(".");
    const slash = this.path.lastIndexOf("/");
    const base = dot > slash ? this.path.slice(0, dot) : this.path;
    const ext = dot > slash ? this.path.slice(dot) : "";
    const nth = (i: number) => `${base}.${i}${ext}`;
    if (existsSync(nth(this.keep))) unlinkSync(nth(this.keep));
    for (let i = this.keep - 1; i >= 1; i--) if (existsSync(nth(i))) renameSync(nth(i), nth(i + 1));
    if (existsSync(this.path)) renameSync(this.path, nth(1));
    this.size = 0;
  }
}

/** Copy a child's stream into the log, line-buffered enough to keep lines whole. */
export async function pumpStream(stream: ReadableStream<Uint8Array> | null | undefined, log: RotatingLog): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) log.append(value);
    }
  } catch {
    /* stream closed with the process */
  }
}

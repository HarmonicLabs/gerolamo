/**
 * OPFS writes for browsers without `FileSystemFileHandle.createWritable` (Safari before 26): the
 * synchronous access handle is the only way to write there, and it exists only in a dedicated
 * worker. Message: `{ id, path, name, bytes }` → `{ id, ok, error? }`.
 */
/// <reference lib="webworker" />
self.onmessage = async (ev: MessageEvent<{ id: number; path: string; name: string; bytes: Uint8Array }>) => {
    const { id, path, name, bytes } = ev.data;
    let h: any = null;
    try {
        let d = await navigator.storage.getDirectory();
        for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
        const fh = await d.getFileHandle(name, { create: true });
        h = await (fh as any).createSyncAccessHandle();
        h.truncate(0);
        h.write(bytes, { at: 0 });
        h.flush();
        (self as any).postMessage({ id, ok: true });
    } catch (e) {
        (self as any).postMessage({ id, ok: false, error: (e as Error).message ?? String(e) });
    } finally {
        try { h?.close(); } catch { /* ignore */ }
    }
};

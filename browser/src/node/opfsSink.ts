/** Origin-private file system sink: `immutable/NNNNN.*` under the browser's OPFS root. */
import type { FileSink } from "./chunkWriter";

export class OpfsSink implements FileSink {
    private dir: FileSystemDirectoryHandle | null = null;
    constructor(private readonly path = "gerolamo/immutable") {}

    static available(): boolean { return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory; }

    private async root(): Promise<FileSystemDirectoryHandle> {
        if (this.dir) return this.dir;
        let d = await navigator.storage.getDirectory();
        for (const part of this.path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
        this.dir = d;
        return d;
    }
    async write(name: string, bytes: Uint8Array): Promise<void> {
        const fh = await (await this.root()).getFileHandle(name, { create: true });
        if (typeof (fh as any).createWritable !== "function") return writeInWorker(this.path, name, bytes);
        const w = await fh.createWritable();
        await w.write(bytes as unknown as BufferSource);
        await w.close();
    }
    async read(name: string): Promise<Uint8Array | null> {
        try { const fh = await (await this.root()).getFileHandle(name); return new Uint8Array(await (await fh.getFile()).arrayBuffer()); } catch { return null; }
    }
    async list(): Promise<string[]> {
        const out: string[] = [];
        for await (const [name] of (await this.root()) as unknown as AsyncIterable<[string, FileSystemHandle]>) out.push(name);
        return out;
    }
    async remove(name: string): Promise<void> { try { await (await this.root()).removeEntry(name); } catch { /* ignore */ } }
    async wipe(): Promise<void> { for (const n of await this.list()) await this.remove(n); }
    async usage(): Promise<{ bytes: number; files: number }> {
        let bytes = 0, files = 0;
        for (const n of await this.list()) { const b = await this.read(n); if (b) { bytes += b.length; files++; } }
        return { bytes, files };
    }
}

/** One shared worker for every sink without `createWritable` (see opfsWorker.ts). */
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
function writeInWorker(path: string, name: string, bytes: Uint8Array): Promise<void> {
    if (!worker) {
        worker = new Worker(new URL("./opfsWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
            const w = waiting.get(ev.data.id);
            if (!w) return;
            waiting.delete(ev.data.id);
            if (ev.data.ok) w.resolve(); else w.reject(new Error(`OPFS write ${ev.data.error ?? "failed"}`));
        };
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        const copy = bytes.slice(); // transfer a private copy; the caller keeps its buffer
        worker!.postMessage({ id, path, name, bytes: copy }, [copy.buffer]);
    });
}

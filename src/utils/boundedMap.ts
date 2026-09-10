/**
 * Insertion-bounded map: when `max` entries are exceeded the oldest inserted key goes.
 *
 * Why not `map.delete(map.keys().next().value)`: JavaScriptCore keeps deleted Map entries as
 * tombstones until the table is rebuilt, and a fresh iterator walks every tombstone before the
 * first live key. A cache that inserts and evicts at a steady size never rebuilds, so each
 * eviction scanned tens of thousands of dead slots — 37 µs per eviction against 0.8 µs with a
 * queue (measured 2026-09-07; the recent-outputs and stake-key caches were 20 % of the applier).
 *
 * Keys are expected to be inserted once (a cache miss); a key deleted and inserted again sits in
 * the queue twice and may be evicted a little early, which a cache tolerates.
 */
export class BoundedMap<K, V> {
    private readonly map = new Map<K, V>();
    private queue: K[] = [];
    private head = 0;

    constructor(readonly max: number) {}

    get size(): number { return this.map.size; }
    get(key: K): V | undefined { return this.map.get(key); }
    has(key: K): boolean { return this.map.has(key); }
    delete(key: K): boolean { return this.map.delete(key); }

    set(key: K, value: V): this {
        if (!this.map.has(key)) this.queue.push(key);
        this.map.set(key, value);
        while (this.map.size > this.max && this.head < this.queue.length) {
            const oldest = this.queue[this.head]!;
            this.queue[this.head] = undefined as unknown as K;
            this.head++;
            this.map.delete(oldest);
        }
        if (this.head > 4096 && this.head * 2 > this.queue.length) {
            this.queue = this.queue.slice(this.head);
            this.head = 0;
        }
        return this;
    }

    clear(): void {
        this.map.clear();
        this.queue = [];
        this.head = 0;
    }

    values(): IterableIterator<V> { return this.map.values(); }
    keys(): IterableIterator<K> { return this.map.keys(); }
    [Symbol.iterator](): IterableIterator<[K, V]> { return this.map[Symbol.iterator](); }
}

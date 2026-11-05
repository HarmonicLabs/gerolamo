/**
 * Bun implements `Uint8Array.prototype.toBuffer`; the @types/bun shipping now omits it from
 * its `Uint8Array` augmentation (verified against the local 1.4.3 declarations). Declare it
 * once here so the project's `bunx tsc` gate sees what Bun actually provides at runtime.
 */
declare global {
    interface Uint8Array<A extends ArrayBufferLike = ArrayBufferLike> {
        toBuffer(): Buffer;
    }
}

export {};

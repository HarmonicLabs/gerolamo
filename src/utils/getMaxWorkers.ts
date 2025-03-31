// some browsers may report less than the actual aviable threads.
// most cpus will support at least 4 threads, if not, 4 threads will be scheduled (concurrently).
// if you test `navigator.hardwareConcurrency` in a browser, you may see a number less than 4.
const MIN_WORKERS = 4;

// global navigator is available in node.js since v21.0.0
// https://nodejs.org/api/globals.html#navigator_1
const hasNavgator = typeof globalThis.navigator === "object";

let _os_availableParallelism: number | undefined = hasNavgator
    ? globalThis.navigator.hardwareConcurrency
    : undefined;

async function setOsAviableParallelism() {
    if (
        _os_availableParallelism === MIN_WORKERS ||
        (typeof _os_availableParallelism === "number" &&
            Number.isSafeInteger(_os_availableParallelism) &&
            _os_availableParallelism === _os_availableParallelism >>> 0)
    )
        return; // already set

    if (hasNavgator) {
        _os_availableParallelism = globalThis.navigator.hardwareConcurrency;
        return;
    }

    // importing "node:os" gives problems with webpack
    // global navigator is available in node js since v21.0.0
    // https://nodejs.org/api/globals.html#navigator_1
    // if this is an earlier version, set `MIN_WORKERS` as the default

    /*
    let nodeOs: typeof import('node:os') | undefined = undefined;
    try {
        nodeOs = await import('node:os');
    } catch {}

    if( !nodeOs ) 
    {
        _os_availableParallelism = MIN_WORKERS;
        return;
    }

    try {
        _os_availableParallelism = nodeOs.availableParallelism();
        return;
    } catch {
        // availableParallelism was added in node js versions: v19.4.0, v18.14.0
        // support for earlier versions via `os.cpus().length` (Added in: v0.3.3)
        try {
            _os_availableParallelism = nodeOs.cpus().length;
            return;
        } catch {
            _os_availableParallelism = MIN_WORKERS;
        }
    }
    //*/

    _os_availableParallelism = MIN_WORKERS;
    return;
}

if (!hasNavgator) {
    void setOsAviableParallelism();
}

export function getMaxWorkers(): number {
    let realNum = hasNavgator
        ? globalThis.navigator.hardwareConcurrency
        : _os_availableParallelism;
    realNum = typeof realNum === "number" ? realNum : MIN_WORKERS;
    return Math.max(realNum, MIN_WORKERS) >>> 0;
}

export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    onTimeout?: () => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                onTimeout?.();
            } catch {
                // Cleanup is best-effort; preserve the timeout as the caller-facing error.
            }
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);

        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

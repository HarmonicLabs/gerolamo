/** Serializes canonical chain mutations while allowing each caller to observe failure. */
export class SerializedMutationQueue {
    private tail: Promise<void> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task);
        this.tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    drain(): Promise<void> {
        return this.tail;
    }
}

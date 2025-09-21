import { Worker } from "worker_threads";

let minibfWorker: Worker | null = null;

export async function startMinibfWorker() {
    if (minibfWorker) return;
    minibfWorker = new Worker("./src/minibfWorkers/minibfWorker.ts");
}

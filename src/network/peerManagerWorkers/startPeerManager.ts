import { Worker } from "worker_threads";
import type { GerolamoConfig } from "./peerManagerWorker";
import { getBasePath } from '../../utils/paths.js';

export async function startPeerManager(config: GerolamoConfig): Promise<Worker> {
	const BASE_PATH = getBasePath();
	const worker = new Worker(`${BASE_PATH}/network/peerManagerWorkers/peerManagerWorker.ts`, { workerData: config });
	worker.postMessage({ type: "init" });
	return new Promise<Worker>((resolve) => {
		worker.on("message", (msg) => {
			if (msg.type === "started") {
				resolve(worker);
			}
		});
	});
};
import { Worker } from "worker_threads";
import type { GerolamoConfig } from "./peerManagerWorker";
import { getBasePath } from '../../utils/paths.js';

const BASE_PATH = getBasePath();

export async function startPeerManager(config: GerolamoConfig) {
	const worker = new Worker(`${BASE_PATH}/network/peerManagerWorkers/peerManagerWorker.ts`, { workerData: config });
	worker.postMessage({ type: "init" });
	return new Promise((resolve) => {
		worker.on("message", (msg) => {
			if (msg.type === "started") {
				resolve(worker);
			}
		});
	});
};
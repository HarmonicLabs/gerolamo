import { Worker } from "worker_threads";
import type { GerolamoConfig } from "./peerManagerWorker";

export async function startPeerManager(config: GerolamoConfig) {
	const worker = new Worker("./src/network/peerManagerWorkers/peerManagerWorker.ts", { workerData: config });
	worker.postMessage({ type: "init" });
	return new Promise((resolve) => {
		worker.on("message", (msg) => {
			if (msg.type === "started") {
				resolve(worker);
			}
		});
	});
};
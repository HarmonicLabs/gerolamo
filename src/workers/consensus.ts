import { parentPort, workerData } from "worker_threads";

// (everything that happens here is HARI's fault)
// 
// validates blocks
// selects longest chain
// writes to db
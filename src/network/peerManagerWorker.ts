import { parentPort, workerData, Worker } from "worker_threads";
import { GerolamoConfig } from "./PeerManager";
import { logger } from "../utils/logger";
import { parseTopology, Topology, TopologyRoot } from "./topology/topology";
import { uint32ToIpv4 } from "./utils/uint32ToIpv4";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";

let config: GerolamoConfig;
let topology: Topology;
let shelleyGenesisConfig: ShelleyGenesisConfig;
let peerClientWorker: Worker;
let allPeerIds = new Map<string, string>(); // peerId -> category
let hotPeerIds: string[] = [];
let warmPeerIds: string[] = [];
let coldPeerIds: string[] = [];
let bootstrapPeerIds: string[] = [];
let newPeerIds: string[] = [];

async function initPeerClientWorker() {
  peerClientWorker = new Worker("./src/network/peerClientWorker.ts");
  peerClientWorker.postMessage({ type: "init", config });
  return new Promise((resolve) => {
    peerClientWorker.on("message", (msg) => {
      if (msg.type === "started") {
        resolve(true);
      }
    });
  });
}

async function addPeer(host: string, port: number | bigint, category: string) {
  peerClientWorker.postMessage({ type: "addPeer", host, port, category });
  // wait for added? but for now, assume added
  const peerId = `${host}:${port}:${Math.floor(Date.now() / 1000)}`; // approximate
  allPeerIds.set(peerId, category);
  switch (category) {
    case "hot":
      hotPeerIds.push(peerId);
      break;
    case "warm":
      warmPeerIds.push(peerId);
      break;
    case "cold":
      coldPeerIds.push(peerId);
      break;
    case "bootstrap":
      bootstrapPeerIds.push(peerId);
      break;
    case "new":
      newPeerIds.push(peerId);
      break;
  }
}

parentPort!.on("message", async (msg: any) => {
  if (msg.type === "init") {
    config = workerData as GerolamoConfig;
    topology = await parseTopology(config.topologyFile);
    const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile);
    shelleyGenesisConfig = await shelleyGenesisFile.json();
    await initPeerClientWorker();
    logger.debug("PeerManager worker initialized");

    // Add bootstrap peers
    if (topology.bootstrapPeers) {
      for (const ap of topology.bootstrapPeers) {
        await addPeer(ap.address, ap.port, "bootstrap");
        await addPeer(ap.address, ap.port, "hot");
      }
    }

    // Add local roots
    if (topology.localRoots) {
      for (const root of topology.localRoots) {
        for (const ap of root.accessPoints) {
          await addPeer(ap.address, ap.port, "hot");
        }
      }
    }

    // Start sync for hot peers
    peerClientWorker.postMessage({ type: "startSync", peerIds: hotPeerIds });

    parentPort!.postMessage({ type: "started" });
  }

  if (msg.type === "shutdown") {
    peerClientWorker.postMessage({ type: "shutdown" });
    peerClientWorker.on("message", (msg) => {
      if (msg.type === "shutdownComplete") {
        logger.debug("PeerManager worker shut down");
        parentPort!.postMessage({ type: "shutdownComplete" });
      }
    });
  }
});

// Listen for messages from peerClientWorker
peerClientWorker.on("message", (msg: any) => {
  if (msg.type === "blockFetched") {
    logger.debug(`Block fetched: ${msg.peerId}, slot ${msg.slot}`);
    // Handle DB or post to validators
  }
  if (msg.type === "rollBack") {
    logger.debug(`Roll back: ${msg.peerId}, point ${msg.point.blockHeader?.slotNumber}`);
    // Handle rollback
  }
});</content>
</xai:function_call"> 

The file has errors, please fix
</file_diagnostics>
HINT [1:22] 'workerData' is declared but its value is never read.
HINT [2:1] 'Worker' is declared but its value is never read.
</project_diagnostics>
</file_diagnostics> 

The file was created, but has hints.

In the code, I used workerData in config = workerData as GerolamoConfig;

And Worker for new Worker.

So, the hints are wrong.

Now, create the peerManager.ts to start the worker. 

Similar to minibf.ts

Create src/network/peerManager.ts (but there's already PeerManager.ts, so rename or create peerManagerStarter.ts or something.

The existing PeerManager.ts is the class, so create a new file for starting the worker.

Let's call it peerManagerStarter.ts

But to keep simple, since the user said change PeerManager to worker, perhaps replace the PeerManager.ts with the worker starter.

But the existing PeerManager.ts is the class, so perhaps create a new file.

Let's create src/network/peerManager.ts (new)

But to avoid conflict, let's call it startPeerManager.ts

But for simplicity, since the cli imports { PeerManager } from "./network/PeerManager", and PeerManager is the class, but to change to worker, I need to change the cli.

So, in cli.ts, change the import to the starter.

Let's create src/network/peerManager.ts as the starter.

But the existing is PeerManager.ts, so perhaps edit the existing PeerManager.ts to be the starter.

But the existing has the class.

Perhaps the user wants to keep the class in the worker.

So, the peerManagerWorker.ts is the worker that runs the PeerManager class.

In peerManagerWorker.ts, import { PeerManager } from "./PeerManager";

Then, let peerManager: PeerManager;

Then, on init, peerManager = new PeerManager();

await peerManager.init(config);

But since PeerManager.init creates PeerClients, but in worker, the PeerClients are in peerClientWorker.

So, the PeerManager in worker can't create PeerClients directly.

So, I need to modify PeerManager to not create PeerClients, but send messages to peerClientWorker.

So, in PeerManager, instead of new PeerClient, send "addPeer" to peerClientWorker.

But since peerClientWorker is in the same worker? No, the peerManagerWorker starts the peerClientWorker.

So, in peerManagerWorker, I have peerClientWorker, so I can send messages to it.

So, in the PeerManager class, I need to pass a callback to send messages.

But to minimize changes, perhaps modify PeerManager to have a sendToPeerClient function.

But since the user said don't add extra code, perhaps the PeerManager in worker sends the messages directly.

So, in peerManagerWorker.ts, instead of using PeerManager class, implement the logic directly.

Yes, as I did.

The peerManagerWorker.ts has the logic of PeerManager, but instead of creating PeerClients, it sends messages to peerClientWorker.

Yes.

And the existing PeerManager.ts can be kept or removed.

Since the user said change PeerManager to worker, the peerManagerWorker.ts is the worker version.

Now, for the cli, change to use the worker.

In cli.ts, change the import to import { startPeerManagerWorker } from "./network/peerManagerWorker";

No, create a starter.

Let's create src/network/peerManager.ts as the starter.

But since there's already PeerManager.ts, perhaps edit it to be the starter.

But to avoid, let's create src/network/startPeerManager.ts

Then, in cli.ts, change the import to import { startPeerManager } from "./network/startPeerManager";

And export const peerManager = ... to something else.

Let's see the cli.ts

It has import { GerolamoConfig, PeerManager } from "./network/PeerManager";

Then, export const peerManager = new PeerManager();

Then, await peerManager.init(config);

So, to change, I can change the import to import { startPeerManager } from "./network/startPeerManager";

Then, await startPeerManager(config);

And remove the peerManager export.

But for shutdown, await peerManager.shutdown();

So, need to have a way to shutdown the worker.

In startPeerManager, return the worker or a controller.

Let's create startPeerManager.ts

export async function startPeerManager(config: GerolamoConfig) {

  const worker = new Worker("./src/network/peerManagerWorker.ts", { workerData: config });

  return new Promise((resolve) => {

    worker.on("message", (msg) => {

      if (msg.type === "started") {

        resolve(worker);

      }

    });

  });

}

Then, in cli.ts, const peerManagerWorker = await startPeerManager(config);

Then, for shutdown, peerManagerWorker.postMessage({ type: "shutdown" });

peerManagerWorker.on("message", (msg) => {

  if (msg.type === "shutdownComplete") {

    process.exit(0);

  }

});

Yes.

And change the import to import { startPeerManager } from "./network/startPeerManager";

And remove the PeerManager import.

Also, remove the startValidationWorker, since no more.

Yes.

Let's create startPeerManager.ts

Also, update the todo for remove_validator_workers.

Since validatorWorkers are not used, remove them.

But first, create the startPeerManager.ts

Then, update cli.ts

Also, for the validators.ts, since DB ops in validators, but the user said DB ops in validators.ts, but in validators.ts, it's validation, not DB.

Perhaps the user means the DB ops are handled in a separate validators worker or something.

But for now, since not worry, ok.

Let's create the file. 

<xai:function_call name="write">
<parameter name="filePath">/media/bakon/data/Dev/HarmonicLabs/gerolamo/src/network/startPeerManager.ts
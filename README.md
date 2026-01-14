# gerolamo-network

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Peer Management Architecture

### Why Separate peerManagerWorker and peerClientWorker?

In the Gerolamo Network project, [`src/network/peerManagerWorkers/peerManagerWorker.ts`](src/network/peerManagerWorkers/peerManagerWorker.ts) and [`peerClientWorker.ts`](src/network/peerClientWorkers/peerClientWorker.ts) are separated to leverage worker threads for concurrency and modularity:

- **[`src/network/peerManagerWorkers/peerManagerWorker.ts`](src/network/peerManagerWorkers/peerManagerWorker.ts)**: Orchestrates overall peer management (e.g., categorizing peers as hot/warm/cold, parsing topology, initializing sync). It acts as a central coordinator.
- **peerClientWorker.ts**: Handles individual peer connections (e.g., handshakes, mini-protocols like chain sync/block fetch). Each peer can run concurrently in its own thread.

**Reasons for separation**:
- **Concurrency**: Worker threads (via `worker_threads` in Bun) allow parallel peer handling without blocking the main thread, crucial for P2P networking in a Cardano node.
- **Modularity**: Keeps code organized—manager for high-level logic, client for per-peer details. Aligns with Cardano specs for scalable peer management.
- **Scalability**: Easier to spawn multiple peer workers from the manager as needed.


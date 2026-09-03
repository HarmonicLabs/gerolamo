import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import type { GerolamoConfig } from "./peerManager";
import { PeerClient } from "./PeerClient";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

const source = await Bun.file(new URL("./PeerClient.ts", import.meta.url)).text();

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

describe("PeerClient socket lifecycle", () => {
    test("retains and directly destroys the pending transport socket", () => {
        expect(source).toContain("private transportSocket?: Socket");
        expect(source).toContain("this.transportSocket = sock");
        expect(source).toContain("this.transportSocket?.destroy()");
    });

    test("terminate destroys a TCP socket whose handshake never answered", async () => {
        let accepted!: Socket;
        let accept!: () => void;
        const acceptedPromise = new Promise<void>((resolve) => (accept = resolve));
        const server = createServer((socket) => {
            accepted = socket;
            accept();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanup = () => {
            accepted?.destroy();
            server.close();
        };

        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing test port");
        const peer = new PeerClient(
            "127.0.0.1",
            address.port,
            { networkMagic: 1 } as GerolamoConfig,
            {} as ShelleyGenesisConfig,
        );
        void peer.handShakePeer().catch(() => {});
        await acceptedPromise;

        const closed = new Promise<void>((resolve) => accepted.once("close", resolve));
        peer.terminate("test timeout");
        const result = await Promise.race([
            closed.then(() => "closed" as const),
            Bun.sleep(100).then(() => "still-open" as const),
        ]);

        expect(result).toBe("closed");
    });
});

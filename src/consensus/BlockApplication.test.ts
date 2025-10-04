import { describe, expect, test } from "bun:test";
import {
    CertStakeDeRegistration,
    CertStakeRegistration,
    Credential,
    Hash28,
    MultiEraBlock,
    PoolKeyHash,
} from "@harmoniclabs/cardano-ledger-ts";
import * as filepath from "node:path/posix";
import * as fsPromises from "node:fs/promises";

import { applyBlock, applyTx, processCert } from "./BlockApplication";
import { RawNewEpochState } from "../rawNES";

const BLOCKS = [
    "conway1.block",
    "conway3.block",
];

const BLOCKS_DIR = async () => {
    return await fsPromises.realpath("./blocks");
};

async function getBlock(filePath: string): Promise<MultiEraBlock> {
    return Bun.file(filePath).text().then((hex) =>
        MultiEraBlock.fromCbor(Buffer.from(hex, "hex"))
    );
}

test("Parse and apply blocks", async () => {
    let blocks = await BLOCKS_DIR().then((dir) =>
        Promise.all(
            BLOCKS.map((block) => filepath.join(dir, block)).map(getBlock),
        )
    );

    // Verify blocks are Conway-era (era 7) for testing
    blocks.forEach((block) => {
        expect(block.era).toBe(7 /*Conway-era blocks for testing*/);
    });

    const state = RawNewEpochState.init();

    // Apply blocks using the proper applyBlock function
    // Note: This will fail input validation since test blocks reference UTxOs
    // from previous blocks. For a proper test, we'd need genesis blocks or
    // initialize state with the required UTxOs.
    const mockIssuer = new PoolKeyHash(
        Buffer.from("mockpoolkeyhash12345678901234567890123456789012", "hex"),
    );
    blocks.forEach((block) => applyBlock(block, state, mockIssuer));

    // Test blocks are valid and applied successfully
    expect(state.epochState.ledgerState.UTxOState.UTxO.length).toBeGreaterThan(
        0,
    );
    expect(state.epochState.chainAccountState.casTreasury).toBeGreaterThan(0n);
});

describe("Certificate Processing", () => {
    test("Stake registration and deregistration with treasury deposit/refund", () => {
        const state = RawNewEpochState.init();
        const initialTreasury = BigInt(
            state.epochState.chainAccountState.casTreasury,
        );

        // Create a stake credential with proper hex hash
        const stakeCredential = new Credential({
            type: 0, // verification key hash
            hash: new Hash28(
                "12345678901234567890123456789012345678901234567890123456",
            ), // 64 chars hex
        });

        // Test stake registration
        const stakeRegCert = new CertStakeRegistration({
            stakeCredential,
        });

        processCert(stakeRegCert, state);

        // Verify stake credential was added to stake set
        expect(state.epochState.snapshots.stakeSet.stake.stake).toHaveLength(1);

        // Verify treasury was debited by keyDeposit amount
        const expectedTreasuryAfterReg = initialTreasury - 2000000n;
        expect(BigInt(state.epochState.chainAccountState.casTreasury)).toBe(
            expectedTreasuryAfterReg,
        );

        // Test stake deregistration
        const stakeDeregCert = new CertStakeDeRegistration({
            stakeCredential,
        });

        processCert(stakeDeregCert, state);

        // Verify stake credential was removed from stake set
        expect(state.epochState.snapshots.stakeSet.stake.stake).toHaveLength(0);

        // Verify treasury was credited back by keyDeposit amount
        expect(BigInt(state.epochState.chainAccountState.casTreasury)).toBe(
            initialTreasury,
        );
    });

    test("Error handling for duplicate stake registration", () => {
        const state = RawNewEpochState.init();

        const stakeCredential = new Credential({
            type: 0, // verification key hash
            hash: new Hash28(
                "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            ),
        });

        // First registration should succeed
        const stakeRegCert1 = new CertStakeRegistration({
            stakeCredential,
        });
        expect(() => processCert(stakeRegCert1, state)).not.toThrow();

        // Second registration should fail
        const stakeRegCert2 = new CertStakeRegistration({
            stakeCredential,
        });
        expect(() => processCert(stakeRegCert2, state)).toThrow(
            "Stake credential",
        );
    });

    test("Error handling for deregistering non-existent stake credential", () => {
        const state = RawNewEpochState.init();

        const stakeCredential = new Credential({
            type: 0, // verification key hash
            hash: new Hash28(
                "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            ),
        });

        // Deregistration of non-existent credential should fail
        const stakeDeregCert = new CertStakeDeRegistration({
            stakeCredential,
        });
        expect(() => processCert(stakeDeregCert, state)).toThrow(
            "Stake credential",
        );
    });
});

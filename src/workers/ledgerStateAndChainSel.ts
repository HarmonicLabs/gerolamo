import { open, RootDatabaseOptionsWithPath } from "lmdb";
import {
    VolatileDb,
    ChainForkHeaders,
    forkHeadersToPoints,
} from "../../lib/consensus/ChainDb/VolatileDb";
import { logger } from "../logger";
import { uint8ArrayEq } from "@harmoniclabs/uint8array-utils";
import { MultiEraHeader } from "../../lib/ledgerExtension/multi-era/MultiEraHeader";
import { pointFromHeader } from "../../lib/utils/pointFromHeadert";

/*
Ledger State
 ├─ UTxO (TxIn |-> TxOut)
 ├─ Stake distribution (StakeCredential |-> Lovelace)
 ├─ Certificates
 │   ├─ DReps (DRepID |-> Epoch, Anchor, Lovelace, Set StakeCredential)
 │   ├─ Committee (CCID |-> Committee State)
 │   ├─ SPOs
 │   │   ├─ Current Parameters (PoolID |-> PoolParams)
 │   │   ├─ Future Parameters (PoolID |-> PoolParams)
 │   │   ├─ Retirements (PoolID |-> Epoch)
 │   │   └─ Deposits (PoolID |-> Lovelace)
 │   └─ Ada holders
 │       ├─ Deposits (StakeCredential |-> (Lovelace, Lovelace))
 │       ├─ Pool Delegations (StakeCredential |-> Option PoolID)
 │       └─ Gov Delegations (StakeCredential |-> Option DRepID)
 ├─ Governance State
 │   ├─ Proposals
 │   ├─ Committee
 │   ├─ DReps
 │   ├─ Constitution
 │   └─ Protocol Parameters (current, previous & future)
 ├─ Deposited (Lovelace)
 ├─ Fees (Lovelace)
 └─ Donation (Lovelace)
*/
const lstateDb = open({
    path: "./db/ledger-state",
    compression: false,
    name: "ledger-state",
    maxDbs: 15, // default is 12, we need at least 13
    maxReaders: 126, // default is 126
    // duplicate keys not allowed
    dupSort: false,
    keyEncoding: "binary",
    /** This provides a small performance boost (when not using useWritemap) for writes,
     * by skipping zero'ing out malloc'ed data,
     * but can leave application data in unused portions of the database.
     * This is recommended unless there are concerns of database files being accessible.
     *
     * In our case `useWritemap` (that is strongly discouraged) is not used,
     *
     * And we are storing public data of a blockchain
     * so we dont care about the data being left in the database files.
     **/
    noMemInit: true,
    /** Set a longer delay (in milliseconds)
     * to wait longer before committing writes
     * to increase the number of writes per transaction
     * (higher latency, but more efficient)
     *
     * default is 0
     **/
    commitDelay: 50,
} as RootDatabaseOptionsWithPath);

/* TxOutRef => TxOut */
const utxoSet = lstateDb.openDB({ name: "utxo-set" });
/* StakeCredentials => Lovelaces (int) */
const stakeDistr = lstateDb.openDB({ name: "stake-distribution" });
/* DRepID => (Epoch, Anchor, Lovelace, Set StakeCredential) */
const dReps = lstateDb.openDB({ name: "dreps" });
/* ConstitutionalCommitteeID => Committee State */
const committee = lstateDb.openDB({ name: "committee" });
/* PoolID => PoolParams */
const currentPools = lstateDb.openDB({ name: "current-pools" });
/* PoolID => PoolParams */
const futurePools = lstateDb.openDB({ name: "future-pools" });
/* PoolID => Epoch */
const retirements = lstateDb.openDB({ name: "retirements" });
/* PoolID => Lovelace */
const poolDeposits = lstateDb.openDB({ name: "pool-deposits" });
/* StakeCredential => (Lovelace, Lovelace) */
const adaHolders = lstateDb.openDB({ name: "ada-holders" });
/* StakeCredential => Option PoolID */
const poolDelegations = lstateDb.openDB({ name: "pool-delegations" });
/* StakeCredential => Option DRepID */
const govDelegations = lstateDb.openDB({ name: "gov-delegations" });
/* Governance State */
const governanceState = lstateDb.openDB({ name: "governance-state" });
/* epoch pots (deposits, fees, donations) */
const epochPots = lstateDb.openDB({ name: "epoch-pots" });

function chainSelectionForForks(
    volaitileDb: VolatileDb,
    forks: ChainForkHeaders[],
) {
    const forksPoint = forks.map(forkHeadersToPoints);
    volaitileDb.forks.push(...forksPoint);

    for (const fork of forksPoint) {
        const { fragment, intersection } = fork;
        const mainDistance = volaitileDb.getDistanceFromTipSync(intersection);
        if (!mainDistance) {
            logger.error("fork intersection missing");
            volaitileDb.forks.splice(volaitileDb.forks.indexOf(fork), 1);
            volaitileDb.orphans.push(...fragment);
            break;
        } else if (mainDistance < fragment.length) {
            volaitileDb.trySwitchToForkSync(volaitileDb.forks.indexOf(fork));
        }
    }
}

async function chainSelectionForExtensions(
    volaitileDb: VolatileDb,
    extensions: MultiEraHeader[],
): Promise<void> {
    // assumption 4.1 ouroboros-consensus report
    // always prefer extension
    //
    // aka. if we have two chains of the same legth we stay on our own

    let currTip = volaitileDb.tip;
    let currTipHash = currTip.blockHeader.hash;

    // we get extensions via roll forwards by peers we are synced with
    // so either extends main or extends forks
    // we can omit checks for rollbacks

    // we process the main extension first (if present)
    // so that we can check fork extensions later using strict >
    const mainExtension = extensions.find((hdr) =>
        uint8ArrayEq(hdr.prevHash, currTipHash),
    );
    if (mainExtension) {
        await volaitileDb.extendMain(mainExtension);
        void extensions.splice(extensions.indexOf(mainExtension), 1);
    }

    if (extensions.length === 0) return;

    const forks = volaitileDb.forks;

    for (const fork of forks) {
        const { fragment, intersection } = fork;
        currTip =
            fragment.length === 0
                ? intersection
                : fragment[fragment.length - 1];
        currTipHash = currTip.blockHeader.hash;

        for (const extension of extensions) {
            if (uint8ArrayEq(extension.prevHash, currTipHash)) {
                logger.info("fork extended");
                fragment.push(pointFromHeader(extension));

                // so we don't check it later
                extensions.splice(extensions.indexOf(extension), 1);

                const mainDistance =
                    volaitileDb.getDistanceFromTipSync(intersection);
                if (!mainDistance) {
                    logger.error("fork intersection missing");
                    forks.splice(forks.indexOf(fork), 1);
                    volaitileDb.orphans.push(...fragment);
                    break;
                } else if (mainDistance < fragment.length) {
                    volaitileDb.trySwitchToForkSync(forks.indexOf(fork));
                }

                break;
            }
        }

        // no need to check other forks
        if (extensions.length === 0) break;
    }
}

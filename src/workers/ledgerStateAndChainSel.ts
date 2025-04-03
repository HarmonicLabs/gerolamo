import { open, RootDatabaseOptionsWithPath } from "lmdb";
import { parentPort } from "node:worker_threads";
import { LedgerStateChainSelWorkerSetupData } from "../common";

import { logger } from "../utils/logger";

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

const rootDbOpts: RootDatabaseOptionsWithPath = {
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
};

const lstateDb = open(rootDbOpts);

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

export async function initWorker(_data: LedgerStateChainSelWorkerSetupData) {
    logger.info("Started ledger state and chain selection thread");
}

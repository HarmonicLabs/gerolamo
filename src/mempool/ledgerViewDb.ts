/**
 * The node's own ledger as the mempool sees it: the chain tip, the epoch's protocol parameters,
 * and keyed reads of the UTxO set, pools, reward balances and stake registrations (the same
 * reads the block rules make, from the LMDB ledger store or SQLite).
 */
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { getChainTip, getDelegationsByCredentials, getStakeByCredentials } from "../db";
import { getUtxoRowsByRefs, registeredPools, rewardBalancesFor } from "../db/rulesQueries";
import { getEpochBodyParams } from "../consensus/epochParams";
import { credKey } from "../consensus/certificateRules";
import { resolvedFromRow, type ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import { epochForSlot, getEpochNetwork } from "../utils/epochFromSlotCalculations";
import { getShelleyGenesisConfig } from "../utils/paths";
import { withReadOnlyConnection } from "../sql";
import type { MempoolLedgerView } from "./ValidatingMempool";
import { ledgerStateExact } from "../ledger/nodeLedgerStore";

export function dbLedgerView(config: any): MempoolLedgerView {
    let genesis: any = undefined;
    return {
        async tip() {
            const t = await getChainTip();
            return t ? { slot: t.slot, hash: t.hashHex } : null;
        },
        async state(slot) {
            const params = await getEpochBodyParams(config, Number(epochForSlot(slot)));
            if (!params) return null;
            if (genesis === undefined) { try { genesis = await getShelleyGenesisConfig(config); } catch { genesis = null; } }
            return { slot, params, genesis, network: String(config?.network ?? "") === "mainnet" ? "mainnet" : "testnet" };
        },
        // Keyed reads go through the read-only connection (SQLite mode): a committed snapshot that
        // neither waits for nor runs inside the applier's open write transaction.
        async resolve(refs) {
            const out = new Map<string, ResolvedUtxo>();
            if (!refs.length) return out;
            for (const row of await withReadOnlyConnection(() => getUtxoRowsByRefs(refs))) out.set(row.utxo_ref, resolvedFromRow(row));
            return out;
        },
        pools: (ids) => withReadOnlyConnection(() => registeredPools(ids)),
        rewardBalances: (creds) => withReadOnlyConnection(() => rewardBalancesFor(creds)),
        stake: (creds) => withReadOnlyConnection(() => stakeOf(creds)),
        epochNetwork: () => getEpochNetwork(),
        exactness: () => ledgerStateExact(),
    };
}

async function stakeOf(creds: Array<{ hex: string; type: number }>): Promise<{ registered: Set<string>; delegated: Map<string, string> } | null> {
    const touched = creds.map((c) => ({ hash: fromHex(c.hex), type: c.type }));
    if (!touched.length) return null;
    const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const [stakeRows, delegationRows] = await Promise.all([getStakeByCredentials(touched), getDelegationsByCredentials(touched)]);
    const registered = new Set<string>(stakeRows.map((r) => credKey(r.cred_type, hexOf(r.stake_credentials))));
    const delegated = new Map<string, string>(delegationRows.map((r) => [credKey(r.cred_type, hexOf(r.stake_credentials)), hexOf(r.pool_key_hash)]));
    return { registered, delegated };
}

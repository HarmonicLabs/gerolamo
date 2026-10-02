/**
 * The Babbage → Conway ledger translation's effect on stake (cardano-ledger
 * `Cardano.Ledger.Conway.Translation`): the UTxO is kept, but
 *   `utxosInstantStake = ConwayInstantStake . sisCredentialStake`
 * drops the pointer-address part of the instant stake, and `ConwayAccounts` carry no pointer map,
 * so outputs at pointer addresses stop counting for any credential from the first Conway snapshot
 * on (the translation runs before the boundary's SNAP). Snapshots already taken are copied
 * unchanged (`TranslateEra ConwayEra SnapShots`): the mark/set/go of Babbage keep their pointer
 * stake for the two epochs they remain in use.
 *
 * Gerolamo keeps the stake credential on each UTxO row: the translation nulls it on pointer
 * outputs, in SQLite (`dropPointerStakeForConway`, whose triggers fix `stake_balance`) and — since
 * bug 236 — in the LMDB ledger store too, where `stake_bal` would otherwise have kept counting them
 * (an lmdb-mode node replaying across the Conway boundary would have carried the pointer stake into
 * every Conway snapshot). Runs inside the boundary block's diff, so a rollback across the boundary
 * restores it.
 */
import { dropPointerStakeForConway } from "../db";
import { sql } from "../sql";
import { getLedgerStore, ledgerStoreMode, ledgerUtxoPut } from "../ledger/nodeLedgerStore";
import { DB_ADDR, UtxoReads, keyRef, type UtxoRecord } from "../ledger/utxoStore";
import type { LedgerStore } from "../ledger/LedgerStore";

/** Bech32 prefixes of pointer addresses (header types 4 and 5, mainnet and testnets). */
export const POINTER_ADDRESS_PREFIXES = ["addr1g", "addr12", "addr_test1g", "addr_test12"] as const;

export interface PointerDrop { outputs: number; lovelace: bigint }

/** LMDB part: rewrite pointer-address outputs without their stake key (inside the open block). */
export function dropPointerStakeLmdb(
    store: LedgerStore | null = ledgerStoreMode() === "sqlite" ? null : getLedgerStore(),
    put: (r: UtxoRecord) => void = ledgerUtxoPut,
): PointerDrop {
    const out: PointerDrop = { outputs: 0, lovelace: 0n };
    if (!store) return out;
    const reads = new UtxoReads(store);
    const enc = new TextEncoder();
    const refs: string[] = [];
    for (const p of POINTER_ADDRESS_PREFIXES) {
        // utxo_addr keys: address ‖ 0x00 ‖ txid ‖ index — every address with this prefix
        for (const [k] of store.range(DB_ADDR, enc.encode(p))) {
            const z = k.indexOf(0);
            if (z < 0 || k.length - z - 1 !== 34) continue;
            refs.push(keyRef(k.subarray(z + 1)));
        }
    }
    for (const ref of refs) {
        const r = reads.get(ref);
        if (!r || !r.stake_key) continue;
        out.outputs++;
        out.lovelace += BigInt(r.lovelace ?? "0");
        put({ ...r, stake_key: null });
    }
    return out;
}

/** Apply the translation's stake effect to every store the node keeps. */
export async function translatePointerStakeToConway(): Promise<{ sqlite: PointerDrop; lmdb: PointerDrop }> {
    const sqlite = await dropPointerStakeForConway(sql);
    const lmdb = dropPointerStakeLmdb();
    return { sqlite, lmdb };
}

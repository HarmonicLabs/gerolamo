import { sql } from "bun";

export async function populateNewEpochState(currentEpoch: number) {
    await sql`
        INSERT OR REPLACE INTO new_epoch_state ${
        sql({
            id: 1,
            last_epoch_modified: currentEpoch,
            epoch_state_id: 1,
            pulsing_rew_update_id: 1,
            pool_distr_id: 1,
            stashed_avvm_addresses_id: 1,
        })
    }
    `;
}
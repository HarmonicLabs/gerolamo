import { sql } from "bun";

export async function populateNewEpochState(
    currentEpoch: number,
) {
    await sql`INSERT OR REPLACE INTO new_epoch_state (id, last_epoch_modified, epoch_state_id, pulsing_rew_update_id, pool_distr_id, stashed_avvm_addresses_id) VALUES (${1}, ${currentEpoch}, ${1}, ${1}, ${1}, ${1})`;
}

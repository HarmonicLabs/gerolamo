import { sql } from "bun";

export async function populatePulsingRewUpdate() {
    await sql`
        INSERT OR REPLACE INTO pulsing_rew_update (id, data)
        VALUES (1, json(${JSON.stringify({})}))
    `;
}

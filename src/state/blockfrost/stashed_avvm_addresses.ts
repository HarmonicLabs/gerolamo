import { sql } from "bun";

export async function populateStashedAvvmAddresses() {
    await sql`
        INSERT OR REPLACE INTO stashed_avvm_addresses (id, addresses)
        VALUES (1, json(${JSON.stringify([])}))
    `;
}

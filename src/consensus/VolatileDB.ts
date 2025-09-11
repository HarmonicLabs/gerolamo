import { AnchoredVolatileState, Point } from "./AnchoredVolatileState";

// VolatileDB manages a sequence of AnchoredVolatileState
// Based on Amaru's VolatileDB design
export class VolatileDB {
    private sequence: AnchoredVolatileState[] = [];
    private cache: VolatileCache = new VolatileCache();

    // Check if the volatile DB is empty
    isEmpty(): boolean {
        return this.sequence.length === 0;
    }

    // Get the length of the sequence
    len(): number {
        return this.sequence.length;
    }

    // View the back (most recent) anchored volatile state
    viewBack(): AnchoredVolatileState | undefined {
        return this.sequence[this.sequence.length - 1];
    }

    // Pop the front (oldest) anchored volatile state
    popFront(): AnchoredVolatileState | undefined {
        const state = this.sequence.shift();
        if (state) {
            // Remove consumed UTxOs from cache
            // Note: In a full implementation, we'd need to track consumed UTxOs
            // For now, we'll reset the cache when popping
            this.cache = new VolatileCache();
        }
        return state;
    }

    // Push a new anchored volatile state to the back
    pushBack(state: AnchoredVolatileState): void {
        // Merge the state's UTxOs into the cache
        this.cache.merge(state.state._utxos);
        this.sequence.push(state);
    }

    // Rollback to a specific point
    rollbackTo(point: Point): boolean {
        this.cache = new VolatileCache();

        let ix = 0;
        for (const diff of this.sequence) {
            if (diff.point.slot < point.slot) {
                // Merge UTxOs into cache
                this.cache.merge(diff.state._utxos);
                ix++;
            } else if (
                diff.point.slot === point.slot &&
                diff.point.hash.toString() === point.hash.toString()
            ) {
                // Merge UTxOs into cache
                this.cache.merge(diff.state._utxos);
                ix++;
                break; // Stop at the first exact match
            } else {
                break;
            }
        }

        if (ix === 0) {
            return false; // Point not found
        }

        // Resize sequence to keep only states up to the rollback point
        this.sequence = this.sequence.slice(0, ix);
        return true;
    }
}

// VolatileCache for efficient UTxO lookups
class VolatileCache {
    private utxos: any[] = []; // Simplified for now

    merge(utxos: any[]): void {
        this.utxos.push(...utxos);
    }

    // Add methods for UTxO resolution as needed
}

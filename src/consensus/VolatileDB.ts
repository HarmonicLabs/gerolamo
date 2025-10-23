import { AnchoredVolatileState } from "./AnchoredVolatileState";
import { Point } from "./AnchoredVolatileState";
import { uint8ArrayEq } from "@harmoniclabs/uint8array-utils";

// VolatileDB for managing anchored volatile states
export class VolatileDB {
    private states: AnchoredVolatileState[] = [];

    constructor() {}

    pushBack(state: AnchoredVolatileState): void {
        this.states.push(state);
    }

    len(): number {
        return this.states.length;
    }

    rollbackTo(point: Point): boolean {
        const index = this.states.findIndex(s => s.point.slot === point.slot && uint8ArrayEq(s.point.hash.toBuffer(), point.hash.toBuffer()));
        if (index >= 0) {
            this.states = this.states.slice(0, index + 1);
            return true;
        }
        return false;
    }

    viewBack(): AnchoredVolatileState | undefined {
        return this.states[this.states.length - 1];
    }
}
import {
    BYRON_EPOCHS,
    BYRON_SLOTS_PER_EPOCH,
    EPS,
    ExpCmpOrdering,
    ExpOrdering,
    PRECISION,
    SHELLEY_SLOTS_PER_EPOCH,
} from "./";

export function calculateCardanoEpoch(absoluteSlot: bigint): bigint {
    const byron_total_slots = BYRON_EPOCHS * BYRON_SLOTS_PER_EPOCH;

    if (absoluteSlot < byron_total_slots) {
        return absoluteSlot / BYRON_SLOTS_PER_EPOCH;
    }
    const totalSlots = absoluteSlot;
    const shelleyEpochs = (totalSlots - byron_total_slots) /
        SHELLEY_SLOTS_PER_EPOCH;
    return BYRON_EPOCHS + shelleyEpochs;
}

function scale(rop: BigInt): BigInt {
    let temp = BigInt(rop.valueOf() / PRECISION);
    let a = BigInt(rop.valueOf() % PRECISION);

    if (rop.valueOf() < 0n && temp.valueOf() !== 0n) {
        a -= 1n;
    }

    return rop;
}

function abs(n: bigint): bigint {
    return n > 0n ? n : -1n * n;
}

export function exp_cmp(
    rop: BigInt,
    max_n: BigInt,
    x: BigInt,
    bound_x: BigInt,
    compare: BigInt,
): ExpCmpOrdering {
    let n = BigInt(0);
    let divisor: BigInt;
    let next_x: BigInt;
    let error: BigInt;
    let upper: BigInt;
    let lower: BigInt;
    let error_term: BigInt;

    divisor = PRECISION;
    error = x;

    let estimate = ExpOrdering.UNKNOWN;

    while (n.valueOf() < max_n.valueOf()) {
        next_x = error;

        if (abs(next_x.valueOf()) < abs(EPS.valueOf())) {
            break;
        }

        error = x;
        scale(error);
    }

    return {
        iterations: 0n,
        estimation: ExpOrdering.UNKNOWN,
        approx: 0,
    };
}

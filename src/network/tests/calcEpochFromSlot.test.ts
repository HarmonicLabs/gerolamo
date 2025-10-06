import { calculatePreProdCardanoEpoch, calculateCardanoEpoch } from "../utils/epochFromSlotCalculations.js";

const epocRes = calculatePreProdCardanoEpoch(51062239);
console.log("Epoch for slot 51062239:", epocRes); // Expected output: 50
import { sha2_256 } from "@harmoniclabs/crypto";
import { HasStakeDistribution } from "./ledger-view/HasStakeDistribution";
import { BabbageHeader } from "../../lib/ledgerExtension/babbage/BabbageHeader";

export interface IRational<NType extends bigint | number = number> {
    numerator: NType;
    denominator: NType;
}

export class BlockHeaderValidator
{
    readonly epochNonce: Uint8Array & { length: 32 };
    readonly activeSlotCoeff: Readonly<IRational<number>>;

    constructor(
        readonly ledgerState: HasStakeDistribution,
        epochNonce: Uint8Array,
        activeSlotCoeff: IRational<bigint | number>
    ) {
        this.epochNonce = Uint8Array.prototype.slice.call(epochNonce, 0, 32) as (Uint8Array & { length: 32 });

        let numerator = Number(activeSlotCoeff.numerator);
        if(
            !Number.isSafeInteger( numerator )
            || numerator < 0
            || numerator > 100
        ) throw new Error("activeSlotCoeff numerator must be a safe integer between 0 and 100");

        let denominator = Number(activeSlotCoeff.denominator);
        if(
            !Number.isSafeInteger( denominator )
            || denominator < numerator
            || denominator > 100
        ) throw new Error("activeSlotCoeff denominator must be a safe integer between numerator and 100");

        this.activeSlotCoeff = Object.freeze({
            numerator,
            denominator
        } as IRational<number>);
    }

    async validatePraos( headerBytes: Uint8Array ): Promise<boolean>
    {
        const headerHash = await sha2_256( headerBytes );
        const header = BabbageHeader.fromCbor( headerBytes );

        const slot = header.slotNo;
        const issuerVkey = header.issuerVkey;
        const poolId = issuerVkeyToPoolId( issuerVkey );

        const vrfKey = header.vrfVkey;
        const vrf = header.vrfResult;
    }
}
import { VolatileDb, ChainForkHeaders, forkHeadersToPoints } from "../../../lib/consensus/ChainDb/VolatileDb";
import { logger } from "../../logger";
import { uint8ArrayEq } from "@harmoniclabs/uint8array-utils";
import { MultiEraHeader } from "../../../lib/ledgerExtension/multi-era/MultiEraHeader";
import { pointFromHeader } from "../../../lib/utils/pointFromHeadert";

function chainSelectionForForks(
    volaitileDb: VolatileDb,
    forks: ChainForkHeaders[]
)
{
    const forksPoint = forks.map( forkHeadersToPoints );
    volaitileDb.forks.push( ...forksPoint );

    for( const fork of forksPoint )
    {
        const { fragment, intersection } = fork;
        const mainDistance = volaitileDb.getDistanceFromTipSync( intersection );
        if( !mainDistance )
        {
            logger.error("fork intersection missing");
            volaitileDb.forks.splice( volaitileDb.forks.indexOf( fork ), 1 );
            volaitileDb.orphans.push( ...fragment );
            break;
        }
        else if( mainDistance < fragment.length )
        {
            volaitileDb.trySwitchToForkSync( volaitileDb.forks.indexOf( fork ) );
        }
    }
}

async function chainSelectionForExtensions(
    volaitileDb: VolatileDb,
    extensions: MultiEraHeader[]
): Promise<void>
{
    // assumption 4.1 ouroboros-consensus report
    // always prefer extension
    //
    // aka. if we have two chains of the same legth we stay on our own

    let currTip = volaitileDb.tip;
    let currTipHash = currTip.blockHeader.hash;

    // we get extensions via roll forwards by peers we are synced with
    // so either extends main or extends forks
    // we can omit checks for rollbacks

    // we process the main extension first (if present)
    // so that we can check fork extensions later using strict >
    const mainExtension = extensions.find( hdr => uint8ArrayEq( hdr.prevHash, currTipHash ) );
    if( mainExtension )
    {
        await volaitileDb.extendMain( mainExtension );
        void extensions.splice( extensions.indexOf( mainExtension ), 1 );
    }

    if( extensions.length === 0 ) return;

    const forks = volaitileDb.forks;

    for( const fork of forks )
    {
        const { fragment, intersection } = fork;
        currTip = fragment.length === 0 ? intersection : fragment[ fragment.length - 1 ];
        currTipHash = currTip.blockHeader.hash;

        for( const extension of extensions )
        {
            if( uint8ArrayEq( extension.prevHash, currTipHash ) )
            {
                logger.info("fork extended");
                fragment.push( pointFromHeader( extension ) );

                // so we don't check it later
                extensions.splice( extensions.indexOf( extension ), 1 );

                const mainDistance = volaitileDb.getDistanceFromTipSync( intersection );
                if( !mainDistance )
                {
                    logger.error("fork intersection missing");
                    forks.splice( forks.indexOf( fork ), 1 );
                    volaitileDb.orphans.push( ...fragment );
                    break;
                }
                else if( mainDistance < fragment.length )
                {
                    volaitileDb.trySwitchToForkSync( forks.indexOf( fork ) );
                }

                break;
            }
        }

        // no need to check other forks
        if( extensions.length === 0 ) break;
    }
}
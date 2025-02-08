import { parentPort } from "node:worker_threads";
import { ChainSelMessageData, ChainSelMessageKind, MasterMessage, MasterMessageKind, NewPeerData } from "./data/MasterMessage";

parentPort?.on("message", handleMasterMessage);

function handleMasterMessage( msg: MasterMessage )
{
    if( msg.kind === MasterMessageKind.ChainSelMessage )
    {
        return handleChainSelMessageData( msg.data as ChainSelMessageData );
    }
    else if( msg.kind === MasterMessageKind.InitChainSel )
    {

    }
    else return;
}

function handleChainSelMessageData( data: ChainSelMessageData )
{
    if( data.kind === ChainSelMessageKind.NewPeer )
    {
        return handleNewPeerData( data.message );
    }
}

function handleNewPeerData( message: NewPeerData )
{
    const { peerId, port } = message;
    console.log( "received new peer", peerId, port );
}
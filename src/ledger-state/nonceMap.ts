import { createReadStream, existsSync } from "fs";
import { U8Arr32 } from "../utils/types";
import { parse } from "csv-parse";
import { fromHex } from "@harmoniclabs/uint8array-utils";

export type Nonce = U8Arr32;
export type Epoch = bigint;
export type NonceMap = Map<Epoch, Nonce>;

export async function nonceMapFromCsv( path: string ): Promise<NonceMap>
{
    if(!existsSync(path)) throw new Error("File does not exist: " + path);

    const result = new Map();

    const parser = createReadStream( path, { encoding: "utf8" } ).pipe( parse() );

    for await (const record of parser)
    {
        const [ epoch, nonce ] = record;
        result.set( BigInt(epoch), fromHex( nonce ) );
    }

    return result;
}
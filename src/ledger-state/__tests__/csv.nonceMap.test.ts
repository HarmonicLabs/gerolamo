import { fromHex } from "@harmoniclabs/uint8array-utils";
import { nonceMapFromCsv } from "../nonceMap";

test("parse csv", async () => {
    const map = await nonceMapFromCsv("./src/data/nonces.csv");

    expect(map.size).toBe(171);
    expect(map.get(BigInt(3))).toEqual(undefined);

    expect(map.get(BigInt(4))).toEqual(
        fromHex(
            "162d29c4e1cf6b8a84f2d692e67a3ac6bc7851bc3e6e4afe64d15778bed8bd86",
        ),
    );
    expect(map.get(BigInt(174))).toEqual(
        fromHex(
            "39fdfcb9de873d4937930473359383194f9fd1e0ecc49aae21e9ac7f3e80a7b4",
        ),
    );

    expect(map.get(BigInt(175))).toEqual(undefined);
});

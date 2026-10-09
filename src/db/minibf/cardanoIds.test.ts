import { describe, expect, test } from "bun:test";
import { assetFingerprint, bech32Decode, drepIdCip129, drepIdLegacy, govActionId, networkId, parseAddress, parseDrepId, parseGovActionId, parsePoolId, parseStakeAddress, poolIdBech32, stakeAddressOf, credentialsOfAddress } from "./cardanoIds";

describe("Cardano identifiers (CIP-14, CIP-19, CIP-129, CIP-5)", () => {
    test("CIP-14 asset fingerprints", () => {
        // vectors from CIP-0014
        expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "")).toBe("asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3");
        expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "504154415445")).toBe("asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92");
        expect(assetFingerprint("1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "504154415445")).toBe("asset1hv4p5tv2a837mzqrst04d0dcptdjmluqvdx9k3");
    });

    test("CIP-129 governance action ids (blockfrost-backend-ryo vectors)", () => {
        expect(govActionId("11".repeat(32), 0)).toBe("gov_action1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsq6dmejn");
        expect(govActionId("00".repeat(32), 17)).toBe("gov_action1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpzklpgpf");
        expect(parseGovActionId("gov_action1zhuz5djmmmjg8f9s8pe6grfc98xg3szglums8cgm6qwancp4eytqqmpu0pr")).toEqual({ txHash: "15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916", index: 0 });
        // minimal encoding: index 0 without its suffix byte
        expect(parseGovActionId("gov_action124vkmmfnaheqs0q4yqn8prrys9qwtue60j68cnnrz2ryz3h5latqgzgzxc")).toEqual({ txHash: "55596ded33edf2083c152026708c648140e5f33a7cb47c4e6312864146f4ff56", index: 0 });
        expect(parseGovActionId("gov_action1notvalid")).toBeNull();
    });

    test("DRep ids: legacy (CIP-105) and CIP-129, both parsed", () => {
        const hash = "245c4fd87622e20d71fe3f6573a557ccd3f0c014b8f00ba7b12277f0";
        expect(drepIdLegacy(0, hash)).toBe("drep1y3wylkrkyt3q6u078ajh8f2henflpsq5hrcqhfa3yfmlqx7z66n");
        expect(drepIdCip129(0, hash)).toBe("drep1ygj9cn7cwc3wyrt3lclk2ua92lxd8uxqzju0qza8ky380uqjnj28h");
        expect(parseDrepId("drep1ygj9cn7cwc3wyrt3lclk2ua92lxd8uxqzju0qza8ky380uqjnj28h")).toEqual({ type: 0, hash, cip129: true });
        expect(parseDrepId("drep1y3wylkrkyt3q6u078ajh8f2henflpsq5hrcqhfa3yfmlqx7z66n")).toEqual({ type: 0, hash, cip129: false });
        expect(parseDrepId("drep_always_abstain")).toEqual({ special: "abstain" });
        expect(parseDrepId("drep1qqq")).toBeNull();
    });

    test("stake addresses, pool ids, addresses and the network check", () => {
        const typed = "5a".repeat(28);
        const s = stakeAddressOf(typed, "preview");
        expect(s.startsWith("stake_test1")).toBe(true);
        expect(parseStakeAddress(s, "preview")).toBe(typed);
        expect(parseStakeAddress(s, "mainnet")).toBeNull();
        expect(parseStakeAddress(stakeAddressOf("01" + typed, "mainnet"), "mainnet")).toBe("01" + typed);
        const pool = "b0".repeat(28);
        expect(parsePoolId(poolIdBech32(pool))).toBe(pool);
        expect(parsePoolId(pool.toUpperCase())).toBe(pool);
        expect(parsePoolId("pool1abc")).toBeNull();
        expect(networkId("mainnet")).toBe(1);
        // CIP-19 test vectors (addr_test1qz2… base address: key/key)
        const base = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
        const a = parseAddress(base, "preview")!;
        expect(a.type).toBe("shelley");
        expect(a.payment).toEqual({ type: 0, hash: "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e" });
        expect(a.stakeTyped).toBe("337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251");
        expect(parseAddress(base, "mainnet")).toBeNull();
        expect(credentialsOfAddress(base)).toEqual({ payment: "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e", stake: "337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251" });
        // script payment, key stake (type 1)
        const s1 = parseAddress("addr_test1zrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgsxj90mg", "preview")!;
        expect(s1.script).toBe(true);
        // Byron (base58) and payment credentials
        expect(parseAddress("Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi", "mainnet")!.type).toBe("byron");
        expect(parseAddress("addr_vkh1jjfnzhxe966a33psfenm0ct2udkkr569qf55v4uprgkgu8zsvmg", "preview")!.kind).toBe("payment_cred");
        expect(bech32Decode("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faaa")).toBeNull(); // bad checksum
    });
});

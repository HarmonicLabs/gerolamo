export const extra: Array<[string, string]> = [];
const bs = (n: number, b = 0xab) => "#" + Buffer.alloc(n, b).toString("hex");
const app = (f: string, ...args: string[]) => args.reduce((acc, a) => `[${acc} ${a}]`, f);
const F = (b: string, n = 1) => "(force ".repeat(n) + `(builtin ${b})` + ")".repeat(n);
const big = (words: number, neg = false) => (neg ? "-" : "") + ((1n << BigInt(64 * words - 5)) + 12345n).toString();
for (const [wx, wy] of [[10, 1], [1, 10], [10, 10], [3, 2], [2, 3], [64, 8], [8, 64]])
    for (const op of ["addInteger", "subtractInteger", "multiplyInteger", "divideInteger", "quotientInteger", "remainderInteger", "modInteger", "equalsInteger", "lessThanInteger", "lessThanEqualsInteger"])
        extra.push([`${op}/${wx}w,${wy}w`, app(`(builtin ${op})`, `(con integer ${big(wx)})`, `(con integer ${big(wy)})`)]);
for (const op of ["divideInteger", "quotientInteger", "remainderInteger", "modInteger"]) {
    extra.push([`${op}/-10w,3w`, app(`(builtin ${op})`, `(con integer ${big(10, true)})`, `(con integer ${big(3)})`)]);
    extra.push([`${op}/10w,-3w`, app(`(builtin ${op})`, `(con integer ${big(10)})`, `(con integer ${big(3, true)})`)]);
}
for (const [a, b] of [[3, 300], [300, 3], [0, 5], [5, 0]]) {
    const s = (n: number) => `(con string "${"é".repeat(n)}")`;
    extra.push([`appendString/${a},${b}`, app("(builtin appendString)", s(a), s(b))]);
    extra.push([`equalsString/${a},${b}`, app("(builtin equalsString)", s(a), s(b))]);
    extra.push([`appendByteString/${a},${b}`, app("(builtin appendByteString)", `(con bytestring ${bs(a)})`, `(con bytestring ${bs(b)})`)]);
    extra.push([`equalsByteString/${a},${b}`, app("(builtin equalsByteString)", `(con bytestring ${bs(a)})`, `(con bytestring ${bs(b)})`)]);
    extra.push([`lessThanByteString/${a},${b}`, app("(builtin lessThanByteString)", `(con bytestring ${bs(a)})`, `(con bytestring ${bs(b)})`)]);
}
extra.push(["encodeUtf8(multibyte)", app("(builtin encodeUtf8)", `(con string "${"é".repeat(50)}")`)]);
extra.push(["decodeUtf8(multibyte)", app("(builtin decodeUtf8)", `(con bytestring #${Buffer.from("é".repeat(50)).toString("hex")})`)]);
for (const [from, len] of [[0, 1], [0, 64], [10, 100], [0, 300]]) extra.push([`sliceByteString/${from},${len}of400`, app("(builtin sliceByteString)", `(con integer ${from})`, `(con integer ${len})`, `(con bytestring ${bs(400)})`)]);
extra.push(["listData(long)", app("(builtin listData)", `(con (list data) [${Array.from({ length: 50 }, (_, i) => `I ${i}`).join(", ")}])`)]);
extra.push(["mkCons(data)", app(F("mkCons"), "(con data (I 1))", "(con (list data) [I 2])")]);
extra.push(["chooseList(empty)", app(F("chooseList", 2), "(con (list integer) [])", "(con integer 0)", "(con integer 1)")]);
extra.push(["nullList(empty)", app(F("nullList"), "(con (list integer) [])")]);
extra.push(["iData(big)", app("(builtin iData)", `(con integer ${big(10)})`)]);
extra.push(["unIData(big)", app("(builtin unIData)", `(con data (I ${big(10)}))`)]);
extra.push(["equalsData(big ints)", app("(builtin equalsData)", `(con data (List [I ${big(10)}, I ${big(10, true)}]))`, `(con data (List [I ${big(10)}, I ${big(10, true)}]))`)]);
extra.push(["serialiseData(big ints)", app("(builtin serialiseData)", `(con data (List [I ${big(10)}, I ${big(10, true)}]))`)]);
extra.push(["unMapData(long)", app("(builtin unMapData)", `(con data (Map [${Array.from({ length: 30 }, (_, i) => `(I ${i}, B ${bs(i + 1)})`).join(", ")}]))`)]);
extra.push(["fstPair(data)", app(F("fstPair", 2), "(con (pair data data) (I 1, B #00))")]);
extra.push(["delay-force", "(force (delay (con integer 1)))"]);
extra.push(["nested lam", "[[(lam x (lam y [[(builtin addInteger) x] y])) (con integer 1)] (con integer 2)]"]);
extra.push(["builtin partial", "[(lam f [[f (con integer 1)] (con integer 2)]) (builtin addInteger)]"]);

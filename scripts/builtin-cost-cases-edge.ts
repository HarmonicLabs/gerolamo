// extra shapes for builtin-cost-diff: appended by importing this module's `extra`
export const extra: Array<[string, string]> = [];
const bs = (n: number, b = 0xab) => "#" + Buffer.alloc(n, b).toString("hex");
const app = (f: string, ...args: string[]) => args.reduce((acc, a) => `[${acc} ${a}]`, f);
const F = (b: string, n = 1) => "(force ".repeat(n) + `(builtin ${b})` + ")".repeat(n);
for (const [a, b] of [["-7", "2"], ["7", "-2"], ["-7", "-2"], ["0", "5"], ["18446744073709551615", "3"], ["-18446744073709551616", "7"], ["170141183460469231731687303715884105727", "-1"]])
    for (const op of ["divideInteger", "quotientInteger", "remainderInteger", "modInteger", "lessThanInteger", "lessThanEqualsInteger", "equalsInteger", "multiplyInteger", "subtractInteger"]) extra.push([`${op}(${a},${b})`, app(`(builtin ${op})`, `(con integer ${a})`, `(con integer ${b})`)]);
for (const n of [0, 1, 7, 9, 63, 64, 65, 100]) {
    const x = `(con bytestring ${bs(n)})`;
    extra.push([`lengthOfByteString/${n}`, app("(builtin lengthOfByteString)", x)]);
    extra.push([`blake2b_256/${n}`, app("(builtin blake2b_256)", x)]);
    extra.push([`serialiseData(B ${n})`, app("(builtin serialiseData)", `(con data (B ${bs(n)}))`)]);
    extra.push([`equalsByteString/${n}vs8`, app("(builtin equalsByteString)", x, `(con bytestring ${bs(8)})`)]);
    extra.push([`lessThanByteString/${n}vs8`, app("(builtin lessThanByteString)", x, `(con bytestring ${bs(8)})`)]);
    extra.push([`appendByteString/${n}+3`, app("(builtin appendByteString)", x, `(con bytestring ${bs(3)})`)]);
}
extra.push(["sliceByteString(-1,5)", app("(builtin sliceByteString)", "(con integer -1)", "(con integer 5)", `(con bytestring ${bs(20)})`)]);
extra.push(["sliceByteString(15,50)", app("(builtin sliceByteString)", "(con integer 15)", "(con integer 50)", `(con bytestring ${bs(20)})`)]);
extra.push(["indexByteString(last)", app("(builtin indexByteString)", `(con bytestring ${bs(20)})`, "(con integer 19)")]);
extra.push(["consByteString(300)", app("(builtin consByteString)", "(con integer 300)", `(con bytestring ${bs(4)})`)]);
extra.push(["equalsData(List [] vs [I 1])", app("(builtin equalsData)", "(con data (List []))", "(con data (List [I 1]))")]);
extra.push(["equalsData(List [I 1, I 2] vs [I 1])", app("(builtin equalsData)", "(con data (List [I 1, I 2]))", "(con data (List [I 1]))")]);
extra.push(["equalsData(Map [] vs [(I1,I2)])", app("(builtin equalsData)", "(con data (Map []))", "(con data (Map [(I 1, I 2)]))")]);
extra.push(["equalsData(Constr 0 [] vs [I 1])", app("(builtin equalsData)", "(con data (Constr 0 []))", "(con data (Constr 0 [I 1]))")]);
extra.push(["equalsData(unequal)", app("(builtin equalsData)", "(con data (Constr 0 [I 1, B #00]))", "(con data (Constr 0 [I 1, B #01]))")]);
extra.push(["equalsData(nested)", app("(builtin equalsData)", "(con data (Map [(B #0102, Constr 1 [List [I 1, I 2], I 340282366920938463463374607431768211455])]))", "(con data (Map [(B #0102, Constr 1 [List [I 1, I 2], I 340282366920938463463374607431768211455])]))")]);
extra.push(["serialiseData(nested)", app("(builtin serialiseData)", `(con data (Map [(B #0102, Constr 1 [List [I 1, I -2], I 340282366920938463463374607431768211455, B ${bs(70)}])]))`)]);
extra.push(["serialiseData(Constr 7 big tag)", app("(builtin serialiseData)", "(con data (Constr 7 [I 0]))")]);
extra.push(["serialiseData(Constr 128)", app("(builtin serialiseData)", "(con data (Constr 128 [I 0]))")]);
extra.push(["unConstrData(Constr 128)", app("(builtin unConstrData)", "(con data (Constr 128 [I 0, I 1]))")]);
extra.push(["chooseData(Map)", app(F("chooseData"), "(con data (Map []))", "(con integer 0)", "(con integer 1)", "(con integer 2)", "(con integer 3)", "(con integer 4)")]);
extra.push(["chooseData(I)", app(F("chooseData"), "(con data (I 5))", "(con integer 0)", "(con integer 1)", "(con integer 2)", "(con integer 3)", "(con integer 4)")]);
extra.push(["decodeUtf8(invalid)", app("(builtin decodeUtf8)", "(con bytestring #ff)")]);
extra.push(["unIData(B)", app("(builtin unIData)", "(con data (B #00))")]);
extra.push(["divideInteger(by 0)", app("(builtin divideInteger)", "(con integer 5)", "(con integer 0)")]);
extra.push(["headList([])", app(F("headList"), "(con (list integer) [])")]);
extra.push(["verifyEd25519Signature(msg 0)", app("(builtin verifyEd25519Signature)", `(con bytestring ${bs(32, 0x01)})`, "(con bytestring #)", `(con bytestring ${bs(64, 0x02)})`)]);
extra.push(["verifyEd25519Signature(msg 200)", app("(builtin verifyEd25519Signature)", `(con bytestring ${bs(32, 0x01)})`, `(con bytestring ${bs(200)})`, `(con bytestring ${bs(64, 0x02)})`)]);
extra.push(["trace(long)", app(F("trace"), `(con string "${"x".repeat(300)}")`, "(con integer 1)")]);
extra.push(["ifThenElse(delayed)", `(force ${app(F("ifThenElse"), "(con bool False)", "(delay (con integer 1))", "(delay (con integer 2))")})`]);
extra.push(["lam-app", "[(lam x [(lam y x) (con integer 2)]) (con integer 1)]"]);
extra.push(["error", "(error)"]);

import { ParseResult, Schema } from "effect";

const conversionErrorMessage = "Can only convert from legacy-style to modern topology; not the other way around";

const TopologyAccessPoint = Schema.Struct({
    address: Schema.String,
    port: Schema.Number,
});

const TopologyRoot = Schema.Struct({
    accessPoints: Schema.Array(TopologyAccessPoint),
    advertise: Schema.Boolean,
    valency: Schema.optional(Schema.NonNegativeInt),
});

const Topology = Schema.Struct({
    localRoots: Schema.Array(TopologyRoot),
    publicRoots: Schema.Array(TopologyRoot),
    useLedgerAfterSlot: Schema.NonNegativeInt,
});

const LegacyAccessPoint = Schema.Struct({
    addr: Schema.String,
    port: Schema.Number,
    valency: Schema.NonNegativeInt,
});

const LegacyTopology = Schema.Struct({
    Producers: Schema.Array(LegacyAccessPoint),
});

const LegacyAccessPointToTopologyRoot = Schema.transformOrFail(
    LegacyAccessPoint,
    TopologyRoot,
    {
        decode: (input, _opts, _ast) => ParseResult.succeed({
            accessPoints: [{ address: input.addr, port: input.port }],
            advertise: false,
            valency: input.valency
        }),
        encode: (input, _opts, ast) => ParseResult.fail(
            new ParseResult.Type(
                ast,
                input,
                conversionErrorMessage
            )
        )
    }
);

const AdaptLegacyTopology = Schema.transformOrFail(
    LegacyTopology,
    Topology,
    {
        decode: (input, _opts, _ast) => ParseResult.succeed({
            localRoots: Schema.decodeSync(
                Schema.asSchema(Schema.Array(LegacyAccessPointToTopologyRoot))
            )(input.Producers),
            publicRoots: [],
            useLedgerAfterSlot: 0,
        }),
        encode: (input, _opts, ast) => ParseResult.fail(
            new ParseResult.Type(
                ast,
                input,
                conversionErrorMessage
            )
        )
    }
)

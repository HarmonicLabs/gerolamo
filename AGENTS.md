This is the Typescript implementation of the Cardano node, which you can find the reference implementation of [here](https://github.com/IntersectMBO/cardano-node).

We are building [Ouroboros Praos](https://eprint.iacr.org/2017/573.pdf), prioritizing the Babbage and the Conway eras. Moreover, we prefer using the [Bun runtime](https://bun.com) over Node.js, although an end-user should be able to use both.

We have the following homegrown dependencies (among others you can find in the `./package.json`):
[@harmoniclabs/cardano-ledger-ts](https://github.com/HarmonicLabs/cardano-ledger-ts)
[@harmoniclabs/ouroboros-miniprotocols-ts](https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts)
[@harmoniclabs/cbor](https://github.com/HarmonicLabs/cbor)
[@harmoniclabs/crypto](https://github.com/HarmonicLabs/crypto)
[@harmoniclabs/uint8array-utils](https://github.com/HarmonicLabs/uint8array-utils)
[@harmoniclabs/uplc](https://github.com/HarmonicLabs/uplc)

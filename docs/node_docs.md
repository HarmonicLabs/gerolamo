# Documentation and specs about the Cardano node and its components

> [!WARNING] If any of the link below is broken please open an issue

## Network

- [network spec (miniprotcols, multiplexer, etc.)](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)

### Optional

- [shelley data diffusion](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-design/network-design.pdf)

### Repos

- [Haskell `ouroboros-network`](https://github.com/IntersectMBO/ouroboros-network)

## Ledger

### CDDL data format

in general, go to the [haskell repo](https://github.com/IntersectMBO/cardano-ledger) and you find the CDDL in each era folder, with pattern:

`eras/<your_era>/impl/cddl-files/<your_era>.cddl`

so for example, the `alonzo` era cddl is at the path

`eras/alonzo/impl/cddl-files/alonzo.cddl` ([check](eras/alonzo/impl/cddl-files/alonzo.cddl))

### Formal Specs

Here are the ledger specs by eras

Each era spec builds on top or the precedent (except Shelley, which is entriely different from Byron).

So, starting from Shelley, you should read them sequencially.

- [Shelley](./formal_spec/eras/shelley/shelley-ledger.pdf)
- [Mary (and Allegre)](./formal_spec/eras/mary/mary-ledger.pdf)
- [Alonzo](./formal_spec/eras/alonzo/alonzo-ledger.pdf)
- [Babbage](./formal_spec/eras/babbage/babbage-ledger.pdf)
- Conway (not yet formalized)

- [Byron](./formal_spec/eras/byron/byron-ledger.pdf) ([wire format](./formal_spec/eras/byron/byron-binary.pdf))

### Repos

- [Haskell `cardano-ledger`](https://github.com/IntersectMBO/cardano-ledger)

## Consensus (Chain selecion and storage)

- [technical report (Praos)](https://ouroboros-consensus.cardano.intersectmbo.org/pdfs/report.pdf)
- [leios research paper](./formal_spec/ouroboros-leios-paper.pdf)

### Optional

- [Byron consensus](./formal_spec/eras/byron/byron-blockchain.pdf)

### Repos

- [Haskell `ouroboros-consensus`](https://github.com/IntersectMBO/ouroboros-consensus)

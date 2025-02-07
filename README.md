
<p align="center">
    <p align="center">
        <img width="200px" src="./assets/gerolamo-logo.svg" align="center"/>
        <h1 align="center">Gerolamo</h1>
    </p>
  <p align="center">Cardano typescript client implementation</p>

  <p align="center">
    <img src="https://img.shields.io/github/commit-activity/m/HarmonicLabs/gerolamo?style=for-the-badge" />
    <a href="https://twitter.com/hlabs_tech">
      <img src="https://img.shields.io/twitter/follow/hlabs_tech?style=for-the-badge&logo=twitter" />
    </a>
  </p>
</p>

# Gerolamo

### Cardano Node implementation in Typesript

## Why?

1) Open core development to a wider spectrum of developers, with a considerable impact on the decentralization of Cardano

2) serve as a base to then extract the "runtime indipendent" code and have a passive node running in browsers

3) be the example project for future, purpose specific nodes, that don't require all the work that a full node does, some examples could be:

    - light weight node following only the tip of the chain (example usages: some mini-protocols servers or ad-hoc chain indexer saving blocks elsewhere)
    - node that only keeps the ledger state, for optimal UTxO queries
    - etc.
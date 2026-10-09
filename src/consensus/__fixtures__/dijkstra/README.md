Dijkstra fixtures (bug 420..435):

- musashi_type8_dijkstra_block.hex / _header.hex: a block of the ouroboros-leios
  "musashi" testnet (network magic 164) in the current Dijkstra format, from Dingo
  14f789e ouroboros/testdata.
- musashi-shelley-genesis.json / musashi-dijkstra-genesis.json: that network's genesis
  files, from Dingo 14f789e config/cardano/musashi.
- cardano_ledger_golden_tx.hex: IntersectMBO/cardano-ledger eras/dijkstra/impl/golden/tx.cbor
  at 5b31cdd (2026-10-08).
- musashi_legacy_block_566037.hex: a block captured from musashi at slot 566037 (block 28091)
  with the pre-respin 4-field body; its 12-field header is genuinely signed (KES evolution 4)
  and is used for the header-signature test (gouroboros v0.210.0 ledger/dijkstra/testdata).
  The type8 header above does not verify under KES (a constructed fixture), so it is only
  used for decoding and arity tests.

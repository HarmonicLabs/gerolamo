export interface IndexedDBStoreConfig {
  name: string;
  keyPath: string;
  autoIncrement?: boolean;
  indexes: Array<{
    name: string;
    keyPath: string;
    unique?: boolean;
    multiEntry?: boolean;
  }>;
}

export const IndexedDBSchema: IndexedDBStoreConfig[] = [
  // Volatile
  {
    name: 'volatile_headers',
    keyPath: 'slot',
    indexes: [
      { name: 'header_hash', keyPath: 'header_hash', unique: true }
    ]
  },
  {
    name: 'blocks',
    keyPath: 'hash',
    indexes: [
      { name: 'slot', keyPath: 'slot' },
      { name: 'prev_hash', keyPath: 'prev_hash' },
      { name: 'is_valid', keyPath: 'is_valid' }
    ]
  },
  // Immutable
  {
    name: 'immutable_chunks',
    keyPath: 'chunk_no',
    indexes: []
  },
  {
    name: 'immutable_blocks',
    keyPath: 'slot',
    indexes: [
      { name: 'block_hash', keyPath: 'block_hash', unique: true }
    ]
  },
  // UTxO
  {
    name: 'utxo',
    keyPath: 'utxo_ref',
    indexes: [
      { name: 'tx_hash', keyPath: 'tx_hash' }
    ]
  },
  {
    name: 'utxo_deltas',
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'block_hash', keyPath: 'block_hash' }
    ]
  },
  // Stake/Ledger
  {
    name: 'stake',
    keyPath: 'stake_credentials',
    indexes: []
  },
  {
    name: 'delegations',
    keyPath: 'stake_credentials',
    indexes: []
  },
  {
    name: 'rewards',
    keyPath: 'stake_credentials',
    indexes: []
  },
  {
    name: 'chain_account_state',
    keyPath: 'id',
    indexes: []
  },
  // Add remaining NES tables similarly: protocol_params (keyPath: 'epoch'), pool_distr, blocks_made (composite keyPath: ['pool_key_hash', 'epoch']), cert_state, etc.
  // stable_state (keyPath: 'id'), etc.
  {
    name: 'protocol_params',
    keyPath: 'epoch',
    indexes: []
  },
  // ... extend for full schema matching SQL
];

export type IndexedDBStoreName = IndexedDBStoreConfig['name'];
export interface LMDBStoreConfig {
  name: string;
  keyType: 'string' | 'binary' | 'number';
  valueEncoding?: 'json' | 'binary';
  indexes?: string[];  // separate store names for indexes
}

export const LMDBSchema = {
  // Volatile
  volatile_headers: { name: 'volatile_headers', keyType: 'string', indexes: ['header_hash'] }, // key: slotStr, value: {header_hash, rollforward_header_cbor: Uint8Array}
  volatile_headers_by_hash: { name: 'volatile_headers_by_hash', keyType: 'string' }, // key: hash, value: slotStr
  blocks: { name: 'blocks', keyType: 'binary', indexes: ['slot', 'prev_hash'] }, // key: hashBin, value: {slot: bigint, prev_hash, header_data U8A, block_data U8A, block_fetch_RawCbor U8A, is_valid: bool}
  blocks_by_slot: { name: 'blocks_by_slot', keyType: 'string' }, // key: slotStr, value: hashBin
  blocks_by_prev: { name: 'blocks_by_prev', keyType: 'binary' }, // multi: key: prevHash, value: hashBin (append)
  // Immutable
  immutable_chunks: { name: 'immutable_chunks', keyType: 'string' }, // key: chunk_no.toStr, value: {tip_hash, tip_slot_no bigint, slot_range_start/end}
  immutable_blocks: { name: 'immutable_blocks', keyType: 'string', indexes: ['block_hash'] }, // key: slotStr, value: {...}
  immutable_blocks_by_hash: { name: 'immutable_blocks_by_hash', keyType: 'binary' }, // key: hashBin, value: slotStr
  // UTxO & Deltas
  utxo: { name: 'utxo', keyType: 'string', indexes: ['tx_hash'] }, // key: utxo_ref, value: {tx_out: json, tx_hash}
  utxo_by_tx: { name: 'utxo_by_tx', keyType: 'string' }, // key: tx_hash, value: utxo_ref (multi append)
  utxo_deltas: { name: 'utxo_deltas', keyType: 'string' }, // key: `${block_hash}_${timestamp}`, value: {action, utxo json}
  // Stake/Ledger
  stake: { name: 'stake', keyType: 'binary' }, // key: stake_creds U8A, value: amount num
  delegations: { name: 'delegations', keyType: 'binary' }, // key: stake_creds, value: pool_key_hash U8A
  rewards: { name: 'rewards', keyType: 'binary' }, // key: stake_creds, value: amount
  chain_account_state: { name: 'chain_account_state', keyType: 'string', valueEncoding: 'json' }, // key: '1', value: {treasury, reserves}
  // Add other NES tables similarly: pool_distr (key: epochStr), blocks_made (key: `${pool}_${epoch}`), protocol_params (key: epochStr), etc.
  // Full list from SQL: cert_state, ledger_state, snapshots, epoch_state, new_epoch_state, pulsing_rew_update, non_myopic, likelihoods, stashed_avvm_addresses, stable_state (key:'1')
  protocol_params: { name: 'protocol_params', keyType: 'string' }, // key: epochStr, value: params json
  pool_distr: { name: 'pool_distr', keyType: 'string' }, // key: epochStr
  // ... (extend for all tables)
} as const;

export type LMDBStoreName = keyof typeof LMDBSchema;
// Database row types matching schemas.sql

export interface VolatileHeaderRow {
    slot: bigint;
    header_hash: string;
    rollforward_header_cbor: Uint8Array;
    is_valid: boolean;
}

export interface VolatileBlockRow {
    id: number;
    slot: bigint;
    block_hash: string;
    prev_hash: string;
    header_data: Uint8Array;
    block_data: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
    is_valid: boolean;
    inserted_at: number;
}

export interface ImmutableChunkRow {
    chunk_id: number;
    chunk_no: number;
    tip_hash: string;
    tip_slot_no: bigint;
    slot_range_start: bigint;
    slot_range_end: bigint;
    inserted_at: number;
}

export interface ImmutableBlockRow {
    id: number;
    chunk_id: number;
    slot: bigint;
    block_hash: string;
    prev_hash: string;
    header_data: Uint8Array;
    block_data: Uint8Array;
    rollforward_header_cbor: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
    inserted_at: number;
}

export interface TransactionRow {
    txid: string;
    block_hash: string;
    tx_index: number;
    slot: bigint;
    epoch: number;
    chunk_id: number | null;
    snapshot_id: number | null;
    is_immutable: boolean;
    transaction_data: Uint8Array;
    inserted_at: string;
}

export interface LedgerSnapshotRow {
    snapshot_id: number;
    snapshot_no: number;
    tip_point: string;
    utxo_size: bigint | null;
    deleg_map_size: bigint | null;
    drep_count: bigint | null;
    drep_map_size: bigint | null;
    state_data: Uint8Array;
    enclosed_time: number | null;
    inserted_at: number;
}

// Common subset of block fields used across volatile and immutable blocks
export interface CommonBlockRow {
    slot: bigint;
    block_hash: string;
    prev_hash: string;
    header_data: Uint8Array;
    block_data: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
}

// Augmented block with rollforward_header_cbor for migration to immutable
export interface AugmentedBlockRow extends CommonBlockRow {
    rollforward_header_cbor: Uint8Array;
}

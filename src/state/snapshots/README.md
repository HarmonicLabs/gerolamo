# Chunk Parser

A utility for parsing Cardano node's immutable database chunk files into raw block data.

## Purpose

The `chunkRawReader.ts` script extracts blocks from Cardano node's binary chunk format (`.primary`, `.secondary`, `.chunk` file triplets). It parses the binary index structure and returns raw CBOR-encoded blocks without performing era-specific decoding or validation.

## Usage

```bash
bun src/state/snapshots/chunkRawReader.ts <immutable_dir> <chunkNo> [outDir]
```

### Arguments

- `<immutable_dir>`: Path to Cardano node's `immutable/` directory containing chunk files
- `<chunkNo>`: Chunk number to parse (e.g., `0`, `1948`)
- `[outDir]`: (Optional) Output directory to write extracted blocks as individual `.cbor` files

### Examples

```bash
# Parse chunk 0 from preprod snapshot
bun src/state/snapshots/chunkRawReader.ts ./snapshots/preprod/db/immutable 0 ./output

# Parse chunk 1948 without writing files (logs only)
bun src/state/snapshots/chunkRawReader.ts ./snapshots/preprod/db/immutable 1948
```

## File Formats

The parser reads three binary files per chunk (Cardano node's immutable storage format):

1. **`.primary`** (e.g., `00000.primary`)
   - Binary index mapping relative slots to offsets in `.secondary`
   - Format: `[version:u8][offset0:u32be][offset1:u32be]...`
   - Used to identify which slots contain blocks

2. **`.secondary`** (e.g., `00000.secondary`)
   - Block metadata: offsets, header info, CRC32, slot numbers
   - 64 bytes per block entry
   - Contains block hash (header hash) and absolute slot number

3. **`.chunk`** (e.g., `00000.chunk`)
   - Concatenated raw block CBOR data
   - Blocks are sliced using offsets from `.secondary`

## Output

Returns an array of `RawChunkBlock` objects:

```typescript
interface RawChunkBlock {
    slotNo: bigint;
    headerHash: Uint8Array;    // Block ID (header hash)
    blockHash: Uint8Array;     // Same as headerHash
    blockCbor: Uint8Array;     // Raw CBOR block data
    headerOffset: number;      // Header position within blockCbor
    headerSize: number;
    crc: number;
}
```

## Current Limitations

### Multi-Era Support
The parser currently extracts raw CBOR blocks **without era-specific decoding**. Multi-era block parsing from `@harmoniclabs/cardano-ledger-ts` is not yet integrated into this chunk reader. The tool only handles the binary file format parsing.

### Byron Era
**Byron headers and blocks are not yet supported.** The parser can read chunks containing Byron-era blocks, but:
- Byron block/header decoding is not implemented
- Epoch Boundary Blocks (EBBs) are not handled
- Era 0-1 validation is pending

Work on Byron multi-era support is ongoing.

## Status

This is a **standalone utility** intended for snapshot imports (e.g., Mithril snapshots). It is not currently integrated into Gerolamo's main P2P sync pipeline, which uses SQLite-based storage with a different chunk format.

See [README_DEV.md](../../../README_DEV.md) for information about Gerolamo's native SQLite chunk system.

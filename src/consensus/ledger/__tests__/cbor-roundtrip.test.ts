import { readFileSync } from 'fs';
import { Database } from 'bun:sqlite';
import { Cbor } from "@harmoniclabs/cbor";
import { RawNewEpochState } from "../../../rawNES";
import { NewEpochState } from "../NewEpochState";
import { SQLNewEpochState } from "../SQLNewEpochState";

// Memory-efficient streaming comparison for large CBOR files
function compareBuffersStreaming(
  buf1: Uint8Array,
  buf2: Uint8Array,
  chunkSize = 1024 * 1024
): boolean {
  if (buf1.length !== buf2.length) return false;

  for (let i = 0; i < buf1.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, buf1.length);
    const chunk1 = buf1.subarray(i, end);
    const chunk2 = buf2.subarray(i, end);

    for (let j = 0; j < chunk1.length; j++) {
      if (chunk1[j] !== chunk2[j]) {
        console.error(`Byte mismatch at offset ${i + j}: ${chunk1[j]} vs ${chunk2[j]}`);
        return false;
      }
    }
  }
  return true;
}

// Test snapshots from Amaru preprod (epochs 163-165)
const testSnapshots = [
  '69206375.6f99b5f3deaeae8dc43fce3db2f3cd36ad8ed174ca3400b5b1bed76fdf248912',
  '69638382.5da6ba37a4a07df015c4ea92c880e3600d7f098b97e73816f8df04bbb5fad3b7',
  '70070379.d6fe6439aed8bddc10eec22c1575bf0648e4a76125387d9e985e9a3f8342870d'
];

describe('CBOR Round-Trip Integrity', () => {
  testSnapshots.forEach(snapshotId => {
    test(`can read snapshot ${snapshotId}`, () => {
      const snapshotPath = `snapshots/${snapshotId}.cbor`;

      try {
        const originalBytes = readFileSync(snapshotPath);
        console.log(`Testing snapshot ${snapshotId} (${(originalBytes.length / 1024 / 1024).toFixed(1)}MB)`);

        // For now, just verify we can read the large files
        expect(originalBytes.length).toBeGreaterThan(300 * 1024 * 1024); // > 300MB

      } catch (error) {
        console.error(`Failed to read snapshot ${snapshotId}:`, error);
        throw error;
      }
    }, 30000); // 30 second timeout for large files
  });
});

describe('SQLite Database Operations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Initialize minimal schema
    db.exec(`
      CREATE TABLE nes_storage (
        id INTEGER PRIMARY KEY,
        epoch_no INTEGER NOT NULL UNIQUE,
        nes_cbor BLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE nes_metadata (
        id INTEGER PRIMARY KEY,
        epoch_no INTEGER NOT NULL UNIQUE,
        last_epoch_modified INTEGER NOT NULL
      );
      CREATE INDEX idx_nes_storage_epoch ON nes_storage(epoch_no);
      CREATE INDEX idx_nes_metadata_epoch ON nes_metadata(epoch_no);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('basic database operations work', () => {
    // Test basic database functionality
    const result = db.prepare(
      'INSERT INTO nes_storage (epoch_no, nes_cbor) VALUES (?, ?)'
    ).run(163, new Uint8Array([1, 2, 3]));

    expect(result.lastInsertRowid).toBeDefined();

    const row = db.prepare(
      'SELECT nes_cbor FROM nes_storage WHERE epoch_no = ?'
    ).get(163) as { nes_cbor: Uint8Array };

    expect(row.nes_cbor).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('can handle large CBOR blobs', () => {
    // Test with a moderately large blob (1MB)
    const largeBlob = new Uint8Array(1024 * 1024);
    for (let i = 0; i < largeBlob.length; i++) {
      largeBlob[i] = i % 256;
    }

    db.prepare(
      'INSERT INTO nes_storage (epoch_no, nes_cbor) VALUES (?, ?)'
    ).run(164, largeBlob);

    const row = db.prepare(
      'SELECT nes_cbor FROM nes_storage WHERE epoch_no = ?'
    ).get(164) as { nes_cbor: Uint8Array };

    expect(compareBuffersStreaming(row.nes_cbor, largeBlob)).toBe(true);
  });
});

// TODO: Implement toCborObj for RawNewEpochState

describe('SQLite NewEpochState Operations', () => {
  test('create and load NES', async () => {
    const nes = await SQLNewEpochState.create(100);
    expect(nes).toBeDefined();
    expect(nes.lastEpochModified).toBe(100n);

    const loaded = await SQLNewEpochState.load(100);
    expect(loaded).toBeDefined();
    expect(loaded!.lastEpochModified).toBe(100n);
  });

  // TODO: Implement CBOR round-trip via SQLite
});
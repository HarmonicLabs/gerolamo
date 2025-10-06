import { open } from 'lmdb';

const db = open({ path: 'gerolamo_db', compression: true });

function storeVRFProof(epoch: number, slot: number, proof: Uint8Array) {
  const key = `epoch:${epoch}`;
  let existing = db.get(key) as Buffer | undefined;
  if (!existing) {
    existing = Buffer.alloc(4); // 4 bytes for length
    existing.writeUInt32BE(0, 0); // Initial length
  }
  const proofCount = existing.readUInt32BE(0);
  const newValue = Buffer.concat([existing, proof], existing.length + proof.length);
  newValue.writeUInt32BE(proofCount + 1, 0); // Update length
  db.put(key, newValue);
}

function getVRFProofs(epoch: number): Uint8Array[] {
  const value = db.get(`epoch:${epoch}`) as Buffer;
  if (!value) return [];
  const proofCount = value.readUInt32BE(0);
  const proofs = [];
  for (let i = 4; i < value.length; i += 32) {
    proofs.push(value.subarray(i, i + 32));
  }
  return proofs;
}
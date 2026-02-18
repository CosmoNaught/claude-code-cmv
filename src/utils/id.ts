import * as crypto from 'node:crypto';

/**
 * Generate a snapshot ID: snap_ + 8 random hex chars
 */
export function generateSnapshotId(): string {
  return 'snap_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Generate a UUID for new session IDs
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

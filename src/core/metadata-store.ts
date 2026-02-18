import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { getVmcDir, getVmcSnapshotsDir, getVmcIndexPath, getVmcConfigPath } from '../utils/paths.js';
import type { VmcIndex, VmcSnapshot, VmcConfig } from '../types/index.js';

const VMC_VERSION = '1.0.0';

/**
 * Initialize VMC storage on first use.
 * Creates ~/.vmc/, ~/.vmc/snapshots/, and empty index.json if they don't exist.
 */
export async function initialize(): Promise<void> {
  const vmcDir = getVmcDir();
  const snapshotsDir = getVmcSnapshotsDir();
  const indexPath = getVmcIndexPath();

  await fs.mkdir(vmcDir, { recursive: true });
  await fs.mkdir(snapshotsDir, { recursive: true });

  try {
    await fs.access(indexPath);
  } catch {
    // Index doesn't exist, create empty one
    const emptyIndex: VmcIndex = {
      version: VMC_VERSION,
      snapshots: {},
    };
    await atomicWrite(indexPath, JSON.stringify(emptyIndex, null, 2));
  }
}

/**
 * Read the VMC index.
 */
export async function readIndex(): Promise<VmcIndex> {
  const indexPath = getVmcIndexPath();
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    return JSON.parse(raw) as VmcIndex;
  } catch {
    return { version: VMC_VERSION, snapshots: {} };
  }
}

/**
 * Write the VMC index atomically.
 */
export async function writeIndex(index: VmcIndex): Promise<void> {
  const indexPath = getVmcIndexPath();
  await atomicWrite(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Get a snapshot by name.
 */
export async function getSnapshot(name: string): Promise<VmcSnapshot | null> {
  const index = await readIndex();
  return index.snapshots[name] || null;
}

/**
 * Add a snapshot to the index.
 */
export async function addSnapshot(snapshot: VmcSnapshot): Promise<void> {
  const index = await readIndex();
  index.snapshots[snapshot.name] = snapshot;
  await writeIndex(index);
}

/**
 * Remove a snapshot from the index.
 */
export async function removeSnapshot(name: string): Promise<boolean> {
  const index = await readIndex();
  if (!index.snapshots[name]) return false;
  delete index.snapshots[name];
  await writeIndex(index);
  return true;
}

/**
 * Add a branch to a snapshot.
 */
export async function addBranch(
  snapshotName: string,
  branch: { name: string; forked_session_id: string; created_at: string }
): Promise<void> {
  const index = await readIndex();
  const snapshot = index.snapshots[snapshotName];
  if (!snapshot) throw new Error(`Snapshot "${snapshotName}" not found`);
  snapshot.branches.push(branch);
  await writeIndex(index);
}

/**
 * Remove a branch from a snapshot.
 * Returns the removed branch, or null if not found.
 */
export async function removeBranch(
  snapshotName: string,
  branchName: string
): Promise<{ name: string; forked_session_id: string; created_at: string } | null> {
  const index = await readIndex();
  const snapshot = index.snapshots[snapshotName];
  if (!snapshot) return null;
  const idx = snapshot.branches.findIndex(b => b.name === branchName);
  if (idx === -1) return null;
  const [removed] = snapshot.branches.splice(idx, 1);
  await writeIndex(index);
  return removed!;
}

/**
 * Validate a snapshot name: must be unique, filesystem-safe.
 * Allowed: alphanumeric, hyphens, underscores.
 */
export async function validateSnapshotName(name: string): Promise<{ valid: boolean; error?: string }> {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: 'Snapshot name cannot be empty' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { valid: false, error: 'Snapshot name must contain only letters, numbers, hyphens, and underscores' };
  }

  if (name.length > 100) {
    return { valid: false, error: 'Snapshot name must be 100 characters or fewer' };
  }

  const existing = await getSnapshot(name);
  if (existing) {
    return { valid: false, error: `Snapshot "${name}" already exists` };
  }

  return { valid: true };
}

/**
 * Read VMC config.
 */
export async function readConfig(): Promise<VmcConfig> {
  const configPath = getVmcConfigPath();
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as VmcConfig;
  } catch {
    return {};
  }
}

/**
 * Write VMC config atomically.
 */
export async function writeConfig(config: VmcConfig): Promise<void> {
  const configPath = getVmcConfigPath();
  await atomicWrite(configPath, JSON.stringify(config, null, 2));
}

/**
 * Get the total size of a snapshot's session files in bytes.
 */
export async function getSnapshotSize(snapshot: VmcSnapshot): Promise<number> {
  const snapshotDir = path.join(getVmcSnapshotsDir(), snapshot.snapshot_dir);
  let totalSize = 0;
  try {
    const sessionDir = path.join(snapshotDir, 'session');
    const files = await fs.readdir(sessionDir);
    for (const file of files) {
      const stat = await fs.stat(path.join(sessionDir, file));
      totalSize += stat.size;
    }
  } catch {
    // Directory may not exist
  }
  return totalSize;
}

/**
 * Atomic file write: write to temp file, then rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.tmp_${crypto.randomBytes(4).toString('hex')}`);

  await fs.writeFile(tmpFile, content, 'utf-8');
  try {
    await fs.rename(tmpFile, filePath);
  } catch {
    // On Windows, rename may fail if target exists; remove target first
    try {
      await fs.unlink(filePath);
    } catch {
      // Target may not exist
    }
    await fs.rename(tmpFile, filePath);
  }
}

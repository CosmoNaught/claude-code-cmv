// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { getCmvDir, getCmvSnapshotsDir, getCmvIndexPath, getCmvConfigPath } from '../utils/paths.js';
import type { CmvIndex, CmvSnapshot, CmvConfig } from '../types/index.js';

const CMV_VERSION = '1.0.0';

/**
 * Initialize CMV storage on first use.
 * Creates ~/.cmv/, ~/.cmv/snapshots/, and empty index.json if they don't exist.
 */
export async function initialize(): Promise<void> {
  const cmvDir = getCmvDir();
  const snapshotsDir = getCmvSnapshotsDir();
  const indexPath = getCmvIndexPath();

  await fs.mkdir(cmvDir, { recursive: true });
  await fs.mkdir(snapshotsDir, { recursive: true });

  try {
    await fs.access(indexPath);
  } catch {
    // Index doesn't exist, create empty one
    const emptyIndex: CmvIndex = {
      version: CMV_VERSION,
      snapshots: {},
    };
    await atomicWrite(indexPath, JSON.stringify(emptyIndex, null, 2));
  }
}

/**
 * Read the CMV index.
 */
export async function readIndex(): Promise<CmvIndex> {
  const indexPath = getCmvIndexPath();
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    return JSON.parse(raw) as CmvIndex;
  } catch {
    return { version: CMV_VERSION, snapshots: {} };
  }
}

/**
 * Write the CMV index atomically.
 */
export async function writeIndex(index: CmvIndex): Promise<void> {
  const indexPath = getCmvIndexPath();
  await atomicWrite(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Get a snapshot by name.
 */
export async function getSnapshot(name: string): Promise<CmvSnapshot | null> {
  const index = await readIndex();
  return index.snapshots[name] || null;
}

/**
 * Add a snapshot to the index.
 */
export async function addSnapshot(snapshot: CmvSnapshot): Promise<void> {
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
 * Read CMV config.
 */
export async function readConfig(): Promise<CmvConfig> {
  const configPath = getCmvConfigPath();
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as CmvConfig;
  } catch {
    return {};
  }
}

/**
 * Write CMV config atomically.
 */
export async function writeConfig(config: CmvConfig): Promise<void> {
  const configPath = getCmvConfigPath();
  await atomicWrite(configPath, JSON.stringify(config, null, 2));
}

/**
 * Get the total size of a snapshot's session files in bytes.
 */
export async function getSnapshotSize(snapshot: CmvSnapshot): Promise<number> {
  const snapshotDir = path.join(getCmvSnapshotsDir(), snapshot.snapshot_dir);
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

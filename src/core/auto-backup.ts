import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getCmvAutoBackupsDir } from '../utils/paths.js';

const DEFAULT_MAX_BACKUPS = 5;

/**
 * Save a backup of a session JSONL file before auto-trimming.
 * Returns the backup file path.
 */
export async function saveBackup(sessionId: string, sourcePath: string): Promise<string> {
  const backupsDir = getCmvAutoBackupsDir();
  await fs.mkdir(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${sessionId}_${timestamp}.jsonl`;
  const backupPath = path.join(backupsDir, backupName);

  await fs.copyFile(sourcePath, backupPath);
  return backupPath;
}

/**
 * List available backups, optionally filtered by session ID.
 * Returns newest first.
 */
export async function listBackups(sessionId?: string): Promise<Array<{ path: string; sessionId: string; timestamp: string; size: number }>> {
  const backupsDir = getCmvAutoBackupsDir();

  try {
    const entries = await fs.readdir(backupsDir);
    const backups: Array<{ path: string; sessionId: string; timestamp: string; size: number }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;

      const match = entry.match(/^(.+?)_(\d{4}-\d{2}-\d{2}T.+)\.jsonl$/);
      if (!match) continue;

      const sid = match[1]!;
      if (sessionId && sid !== sessionId) continue;

      const fullPath = path.join(backupsDir, entry);
      const stat = await fs.stat(fullPath);
      backups.push({
        path: fullPath,
        sessionId: sid,
        timestamp: match[2]!.replace(/-/g, (m, offset) => offset > 9 ? (offset === 13 || offset === 16 ? ':' : '.') : m),
        size: stat.size,
      });
    }

    return backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch {
    return [];
  }
}

/**
 * Restore a backup by copying it to a destination path.
 */
export async function restoreBackup(backupPath: string, destPath: string): Promise<void> {
  await fs.copyFile(backupPath, destPath);
}

/**
 * Rotate backups for a session, keeping only the most recent N.
 */
export async function rotateBackups(sessionId: string, maxKeep: number = DEFAULT_MAX_BACKUPS): Promise<number> {
  const backups = await listBackups(sessionId);
  let deleted = 0;

  if (backups.length > maxKeep) {
    const toDelete = backups.slice(maxKeep);
    for (const backup of toDelete) {
      try {
        await fs.unlink(backup.path);
        deleted++;
      } catch {
        // Best effort
      }
    }
  }

  return deleted;
}

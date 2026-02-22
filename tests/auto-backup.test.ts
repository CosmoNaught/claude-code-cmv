import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveBackup, listBackups, restoreBackup, rotateBackups } from '../src/core/auto-backup.js';

// Override the backups dir for testing
import * as paths from '../src/utils/paths.js';
import { vi } from 'vitest';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-backup-test-'));
  vi.spyOn(paths, 'getCmvAutoBackupsDir').mockReturnValue(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('auto-backup', () => {
  it('saves a backup and returns the path', async () => {
    const srcFile = path.join(tmpDir, 'source.jsonl');
    await fs.writeFile(srcFile, '{"type":"test"}\n');

    const backupPath = await saveBackup('sess-123', srcFile);
    expect(backupPath).toContain('sess-123');
    expect(backupPath.endsWith('.jsonl')).toBe(true);

    const content = await fs.readFile(backupPath, 'utf-8');
    expect(content).toBe('{"type":"test"}\n');
  });

  it('lists backups sorted newest first', async () => {
    const srcFile = path.join(tmpDir, 'source.jsonl');
    await fs.writeFile(srcFile, 'data\n');

    await saveBackup('sess-1', srcFile);
    // Tiny delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await saveBackup('sess-1', srcFile);

    const backups = await listBackups('sess-1');
    expect(backups.length).toBe(2);
    // Newest first
    expect(backups[0]!.timestamp >= backups[1]!.timestamp).toBe(true);
  });

  it('filters backups by session ID', async () => {
    const srcFile = path.join(tmpDir, 'source.jsonl');
    await fs.writeFile(srcFile, 'data\n');

    await saveBackup('sess-a', srcFile);
    await saveBackup('sess-b', srcFile);

    const backupsA = await listBackups('sess-a');
    expect(backupsA.length).toBe(1);
    expect(backupsA[0]!.sessionId).toBe('sess-a');
  });

  it('restores a backup to a destination', async () => {
    const srcFile = path.join(tmpDir, 'source.jsonl');
    await fs.writeFile(srcFile, '{"restored":true}\n');

    const backupPath = await saveBackup('sess-1', srcFile);
    const destFile = path.join(tmpDir, 'restored.jsonl');
    await restoreBackup(backupPath, destFile);

    const content = await fs.readFile(destFile, 'utf-8');
    expect(content).toBe('{"restored":true}\n');
  });

  it('rotates backups keeping only maxKeep', async () => {
    const srcFile = path.join(tmpDir, 'source.jsonl');
    await fs.writeFile(srcFile, 'data\n');

    for (let i = 0; i < 5; i++) {
      await saveBackup('sess-1', srcFile);
      await new Promise(r => setTimeout(r, 10));
    }

    const deleted = await rotateBackups('sess-1', 2);
    expect(deleted).toBe(3);

    const remaining = await listBackups('sess-1');
    expect(remaining.length).toBe(2);
  });

  it('returns empty list when no backups exist', async () => {
    const backups = await listBackups('nonexistent');
    expect(backups).toEqual([]);
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CmvSnapshot, CmvIndex, CmvConfig } from '../src/types/index.js';

// Mutable ref so the hoisted vi.mock factory can read the current tmpDir
const tmpDirRef = { value: '' };

vi.mock('../src/utils/paths.js', () => ({
  getCmvDir: () => tmpDirRef.value,
  getCmvSnapshotsDir: () => path.join(tmpDirRef.value, 'snapshots'),
  getCmvIndexPath: () => path.join(tmpDirRef.value, 'index.json'),
  getCmvConfigPath: () => path.join(tmpDirRef.value, 'config.json'),
}));

import {
  initialize,
  readIndex,
  writeIndex,
  getSnapshot,
  addSnapshot,
  removeSnapshot,
  addBranch,
  removeBranch,
  validateSnapshotName,
  readConfig,
  writeConfig,
  getSnapshotSize,
} from '../src/core/metadata-store.js';

function makeSnapshot(overrides: Partial<CmvSnapshot> = {}): CmvSnapshot {
  return {
    id: 'snap-001',
    name: 'test-snapshot',
    description: 'A test snapshot',
    created_at: '2025-01-01T00:00:00Z',
    source_session_id: 'session-abc',
    source_project_path: '/home/user/project',
    snapshot_dir: 'snap-001',
    message_count: 42,
    estimated_tokens: 10000,
    tags: ['test'],
    parent_snapshot: null,
    session_active_at_capture: false,
    branches: [],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDirRef.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDirRef.value, { recursive: true, force: true });
});

// ── initialize ──────────────────────────────────────────────

describe('initialize', () => {
  it('creates cmv dir, snapshots dir, and empty index.json', async () => {
    await initialize();

    const cmvStat = await fs.stat(tmpDirRef.value);
    expect(cmvStat.isDirectory()).toBe(true);

    const snapshotsStat = await fs.stat(path.join(tmpDirRef.value, 'snapshots'));
    expect(snapshotsStat.isDirectory()).toBe(true);

    const raw = await fs.readFile(path.join(tmpDirRef.value, 'index.json'), 'utf-8');
    const index: CmvIndex = JSON.parse(raw);
    expect(index.version).toBe('1.0.0');
    expect(index.snapshots).toEqual({});
  });

  it('does not overwrite existing index.json on second call', async () => {
    await initialize();
    const snap = makeSnapshot();
    await addSnapshot(snap);

    // Re-initialize should not clobber the data
    await initialize();
    const index = await readIndex();
    expect(index.snapshots['test-snapshot']).toBeDefined();
  });
});

// ── readIndex / writeIndex ──────────────────────────────────

describe('readIndex / writeIndex', () => {
  it('returns empty index when file does not exist', async () => {
    const index = await readIndex();
    expect(index.version).toBe('1.0.0');
    expect(index.snapshots).toEqual({});
  });

  it('round-trips an index through write then read', async () => {
    await initialize();
    const index: CmvIndex = {
      version: '1.0.0',
      snapshots: { alpha: makeSnapshot({ name: 'alpha' }) },
    };
    await writeIndex(index);

    const result = await readIndex();
    expect(result.snapshots['alpha'].name).toBe('alpha');
    expect(result.version).toBe('1.0.0');
  });

  it('writes atomically via temp file (no partial writes)', async () => {
    await initialize();
    const index: CmvIndex = { version: '1.0.0', snapshots: {} };
    await writeIndex(index);

    // After write, there should be no leftover .tmp_ files
    const files = await fs.readdir(tmpDirRef.value);
    const tmpFiles = files.filter(f => f.startsWith('.tmp_'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ── getSnapshot ─────────────────────────────────────────────

describe('getSnapshot', () => {
  it('returns null for non-existent snapshot', async () => {
    await initialize();
    const result = await getSnapshot('does-not-exist');
    expect(result).toBeNull();
  });

  it('returns the snapshot object when it exists', async () => {
    await initialize();
    await addSnapshot(makeSnapshot({ name: 'my-snap' }));
    const result = await getSnapshot('my-snap');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-snap');
  });
});

// ── addSnapshot / removeSnapshot ────────────────────────────

describe('addSnapshot / removeSnapshot', () => {
  it('adds a snapshot that can be read back', async () => {
    await initialize();
    await addSnapshot(makeSnapshot({ name: 'added' }));
    const index = await readIndex();
    expect(Object.keys(index.snapshots)).toContain('added');
  });

  it('removes an existing snapshot and returns true', async () => {
    await initialize();
    await addSnapshot(makeSnapshot({ name: 'to-remove' }));
    const removed = await removeSnapshot('to-remove');
    expect(removed).toBe(true);

    const index = await readIndex();
    expect(index.snapshots['to-remove']).toBeUndefined();
  });

  it('returns false when removing a non-existent snapshot', async () => {
    await initialize();
    const removed = await removeSnapshot('ghost');
    expect(removed).toBe(false);
  });
});

// ── addBranch / removeBranch ────────────────────────────────

describe('addBranch / removeBranch', () => {
  const branch = {
    name: 'feature-branch',
    forked_session_id: 'sess-xyz',
    created_at: '2025-06-01T00:00:00Z',
  };

  it('adds a branch to an existing snapshot', async () => {
    await initialize();
    await addSnapshot(makeSnapshot({ name: 'parent' }));
    await addBranch('parent', branch);

    const snap = await getSnapshot('parent');
    expect(snap!.branches).toHaveLength(1);
    expect(snap!.branches[0].name).toBe('feature-branch');
  });

  it('throws when adding a branch to a missing snapshot', async () => {
    await initialize();
    await expect(addBranch('nonexistent', branch)).rejects.toThrow(
      'Snapshot "nonexistent" not found',
    );
  });

  it('removes a branch and returns it', async () => {
    await initialize();
    await addSnapshot(makeSnapshot({ name: 'parent' }));
    await addBranch('parent', branch);

    const removed = await removeBranch('parent', 'feature-branch');
    expect(removed).not.toBeNull();
    expect(removed!.forked_session_id).toBe('sess-xyz');

    const snap = await getSnapshot('parent');
    expect(snap!.branches).toHaveLength(0);
  });

  it('returns null when removing a branch from a missing snapshot', async () => {
    await initialize();
    const result = await removeBranch('ghost', 'some-branch');
    expect(result).toBeNull();
  });

  it('returns null when removing a non-existent branch', async () => {
    await initialize();
    await addSnapshot(makeSnapshot({ name: 'parent' }));
    const result = await removeBranch('parent', 'no-such-branch');
    expect(result).toBeNull();
  });
});

// ── validateSnapshotName ────────────────────────────────────

describe('validateSnapshotName', () => {
  beforeEach(async () => {
    await initialize();
  });

  it('accepts a valid alphanumeric name', async () => {
    const result = await validateSnapshotName('my-snapshot_01');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects an empty string', async () => {
    const result = await validateSnapshotName('');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it('rejects a whitespace-only string', async () => {
    const result = await validateSnapshotName('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it('rejects names with special characters', async () => {
    const result = await validateSnapshotName('bad name!');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/letters, numbers, hyphens/);
  });

  it('rejects names longer than 100 characters', async () => {
    const longName = 'a'.repeat(101);
    const result = await validateSnapshotName(longName);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/100 characters/);
  });

  it('accepts a name exactly 100 characters long', async () => {
    const maxName = 'a'.repeat(100);
    const result = await validateSnapshotName(maxName);
    expect(result.valid).toBe(true);
  });

  it('rejects a duplicate snapshot name', async () => {
    await addSnapshot(makeSnapshot({ name: 'taken' }));
    const result = await validateSnapshotName('taken');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/already exists/);
  });
});

// ── readConfig / writeConfig ────────────────────────────────

describe('readConfig / writeConfig', () => {
  it('returns empty object when config file is missing', async () => {
    const config = await readConfig();
    expect(config).toEqual({});
  });

  it('round-trips config data', async () => {
    await initialize();
    const config: CmvConfig = {
      claude_cli_path: '/usr/local/bin/claude',
      default_project: '/home/user/proj',
    };
    await writeConfig(config);
    const result = await readConfig();
    expect(result.claude_cli_path).toBe('/usr/local/bin/claude');
    expect(result.default_project).toBe('/home/user/proj');
  });
});

// ── getSnapshotSize ─────────────────────────────────────────

describe('getSnapshotSize', () => {
  it('returns 0 when the session directory does not exist', async () => {
    await initialize();
    const snap = makeSnapshot({ snapshot_dir: 'nonexistent' });
    const size = await getSnapshotSize(snap);
    expect(size).toBe(0);
  });

  it('sums the size of all files in the session directory', async () => {
    await initialize();
    const snap = makeSnapshot({ snapshot_dir: 'snap-001' });
    const sessionDir = path.join(tmpDirRef.value, 'snapshots', 'snap-001', 'session');
    await fs.mkdir(sessionDir, { recursive: true });

    // Write two files with known content
    await fs.writeFile(path.join(sessionDir, 'a.json'), 'hello'); // 5 bytes
    await fs.writeFile(path.join(sessionDir, 'b.json'), 'world!'); // 6 bytes

    const size = await getSnapshotSize(snap);
    expect(size).toBe(11);
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const tmpDirRef = { value: '' };

vi.mock('../src/utils/paths.js', () => ({
  getCmvSnapshotsDir: () => path.join(tmpDirRef.value, 'snapshots'),
}));

vi.mock('../src/utils/id.js', () => ({
  generateSnapshotId: () => 'snap_test1234',
}));

vi.mock('../src/core/session-reader.js', () => ({
  findSession: vi.fn(),
  getLatestSession: vi.fn(),
  isSessionActive: vi.fn().mockResolvedValue(false),
  extractClaudeVersion: vi.fn().mockResolvedValue('1.0.0'),
  getSessionJsonlPath: vi.fn(),
}));

vi.mock('../src/core/metadata-store.js', () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  validateSnapshotName: vi.fn().mockResolvedValue({ valid: true }),
  addSnapshot: vi.fn().mockResolvedValue(undefined),
  getSnapshot: vi.fn(),
  readIndex: vi.fn().mockResolvedValue({ version: '1.0.0', snapshots: {} }),
  removeSnapshot: vi.fn().mockResolvedValue(true),
}));

import { createSnapshot, deleteSnapshot } from '../src/core/snapshot-manager.js';
import { findSession, getLatestSession, isSessionActive, getSessionJsonlPath } from '../src/core/session-reader.js';
import { validateSnapshotName, getSnapshot, readIndex, removeSnapshot } from '../src/core/metadata-store.js';

const mockSession = {
  sessionId: 'test-session',
  projectPath: '/test/project',
  messageCount: 5,
  _projectDir: '/some/dir',
};

beforeEach(async () => {
  tmpDirRef.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-test-'));
  await fs.mkdir(path.join(tmpDirRef.value, 'snapshots'), { recursive: true });

  // Create a fake source JSONL
  const sourceDir = path.join(tmpDirRef.value, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'test-session.jsonl'),
    '{"type":"user","content":"hello"}\n',
  );

  // Default mock setup
  vi.mocked(getSessionJsonlPath).mockReturnValue(
    path.join(tmpDirRef.value, 'source', 'test-session.jsonl'),
  );
  vi.mocked(getLatestSession).mockResolvedValue(mockSession);
  vi.mocked(findSession).mockResolvedValue(mockSession);
  vi.mocked(isSessionActive).mockResolvedValue(false);
  vi.mocked(getSnapshot).mockResolvedValue(null);
  vi.mocked(readIndex).mockResolvedValue({ version: '1.0.0', snapshots: {} });
  vi.mocked(validateSnapshotName).mockResolvedValue({ valid: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDirRef.value, { recursive: true, force: true });
});

describe('createSnapshot', () => {
  it('with latest=true calls getLatestSession, copies JSONL, writes meta.json', async () => {
    const result = await createSnapshot({ name: 'my-snap', latest: true });

    expect(getLatestSession).toHaveBeenCalled();
    expect(result.snapshot.name).toBe('my-snap');
    expect(result.snapshot.source_session_id).toBe('test-session');

    // Verify files were created
    const snapDir = path.join(tmpDirRef.value, 'snapshots', 'snap_test1234');
    const metaRaw = await fs.readFile(path.join(snapDir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw);
    expect(meta.name).toBe('my-snap');

    const jsonl = await fs.readFile(
      path.join(snapDir, 'session', 'test-session.jsonl'),
      'utf-8',
    );
    expect(jsonl).toContain('hello');
  });

  it('with sessionId calls findSession', async () => {
    const result = await createSnapshot({ name: 'by-id', sessionId: 'test-session' });

    expect(findSession).toHaveBeenCalledWith('test-session');
    expect(result.snapshot.source_session_id).toBe('test-session');
  });

  it('throws when no session found via latest', async () => {
    vi.mocked(getLatestSession).mockResolvedValue(null);

    await expect(createSnapshot({ name: 'fail', latest: true })).rejects.toThrow(
      'No sessions found',
    );
  });

  it('throws when no session found via sessionId', async () => {
    vi.mocked(findSession).mockResolvedValue(null);

    await expect(createSnapshot({ name: 'fail', sessionId: 'missing' })).rejects.toThrow(
      'Session "missing" not found',
    );
  });

  it('throws when neither latest nor sessionId provided', async () => {
    await expect(createSnapshot({ name: 'fail' })).rejects.toThrow(
      'Must provide --session <id> or --latest',
    );
  });

  it('warns when session is active', async () => {
    vi.mocked(isSessionActive).mockResolvedValue(true);

    const result = await createSnapshot({ name: 'active-snap', latest: true });

    expect(result.warnings).toContain('Session appears to be active. Snapshot may be incomplete.');
    expect(result.snapshot.session_active_at_capture).toBe(true);
  });

  it('warns when messageCount is 0', async () => {
    vi.mocked(getLatestSession).mockResolvedValue({ ...mockSession, messageCount: 0 });

    const result = await createSnapshot({ name: 'empty-snap', latest: true });

    expect(result.warnings.some(w => w.includes('no conversation messages'))).toBe(true);
  });

  it('detects parent snapshot from branches in the index', async () => {
    vi.mocked(readIndex).mockResolvedValue({
      version: '1.0.0',
      snapshots: {
        'parent-snap': {
          id: 'snap_parent',
          name: 'parent-snap',
          description: '',
          created_at: '2025-01-01T00:00:00Z',
          source_session_id: 'other-session',
          source_project_path: '/test',
          snapshot_dir: 'snap_parent',
          message_count: 10,
          estimated_tokens: null,
          tags: [],
          parent_snapshot: null,
          session_active_at_capture: false,
          branches: [
            { name: 'branch-1', forked_session_id: 'test-session', created_at: '2025-01-02T00:00:00Z' },
          ],
        },
      },
    });

    const result = await createSnapshot({ name: 'child-snap', latest: true });

    expect(result.snapshot.parent_snapshot).toBe('parent-snap');
  });

  it('validates name via validateSnapshotName and throws on invalid', async () => {
    vi.mocked(validateSnapshotName).mockResolvedValue({ valid: false, error: 'Name is invalid' });

    await expect(createSnapshot({ name: 'bad!name', latest: true })).rejects.toThrow(
      'Name is invalid',
    );
  });
});

describe('deleteSnapshot', () => {
  it('removes directory and index entry', async () => {
    const snapDir = path.join(tmpDirRef.value, 'snapshots', 'snap_del');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.writeFile(path.join(snapDir, 'meta.json'), '{}');

    vi.mocked(getSnapshot).mockResolvedValue({
      id: 'snap_del',
      name: 'to-delete',
      description: '',
      created_at: '2025-01-01T00:00:00Z',
      source_session_id: 'sess-1',
      source_project_path: '/test',
      snapshot_dir: 'snap_del',
      message_count: 5,
      estimated_tokens: null,
      tags: [],
      parent_snapshot: null,
      session_active_at_capture: false,
      branches: [],
    });

    await deleteSnapshot('to-delete');

    // Directory should be removed
    await expect(fs.access(snapDir)).rejects.toThrow();
    expect(removeSnapshot).toHaveBeenCalledWith('to-delete');
  });

  it('throws when snapshot not found', async () => {
    vi.mocked(getSnapshot).mockResolvedValue(null);

    await expect(deleteSnapshot('nonexistent')).rejects.toThrow(
      'Snapshot "nonexistent" not found',
    );
  });
});

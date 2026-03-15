import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mutable ref so the hoisted vi.mock factory can read the current tmpDir
const tmpDirRef = { value: '' };

vi.mock('../src/core/metadata-store.js', () => ({
  getSnapshot: vi.fn(),
  addBranch: vi.fn().mockResolvedValue(undefined),
  removeBranch: vi.fn().mockResolvedValue({ name: 'test-branch', forked_session_id: 'uuid-1', created_at: '2025-01-01' }),
  readConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/utils/paths.js', () => ({
  getClaudeProjectsDir: () => path.join(tmpDirRef.value, 'projects'),
  getCmvSnapshotsDir: () => path.join(tmpDirRef.value, 'snapshots'),
}));

vi.mock('../src/utils/process.js', () => ({
  spawnClaudeInteractive: vi.fn().mockResolvedValue(0),
  getClaudeCliPath: vi.fn().mockReturnValue('claude'),
}));

vi.mock('../src/utils/id.js', () => ({
  generateUUID: () => 'test-uuid-1234-5678-9abc-def012345678',
}));

vi.mock('../src/core/trimmer.js', () => ({
  trimJsonl: vi.fn().mockResolvedValue({
    originalBytes: 1000,
    trimmedBytes: 500,
    toolResultsStubbed: 1,
    signaturesStripped: 0,
    fileHistoryRemoved: 0,
    imagesStripped: 0,
    toolUseInputsStubbed: 0,
    preCompactionLinesSkipped: 0,
    queueOperationsRemoved: 0,
    userMessages: 2,
    assistantResponses: 2,
    toolUseRequests: 1,
  }),
}));

import { createBranch, deleteBranch } from '../src/core/branch-manager.js';
import { getSnapshot, addBranch, removeBranch } from '../src/core/metadata-store.js';
import { trimJsonl } from '../src/core/trimmer.js';

const mockedGetSnapshot = vi.mocked(getSnapshot);

// ── Helpers ────────────────────────────────────────────────────

/** A valid JSONL line that counts as conversation content */
const conversationLine = JSON.stringify({ type: 'human', message: { role: 'user', content: 'hello' } }) + '\n'
  + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }) + '\n';

/** A JSONL that only has file-history entries (no conversation) */
const fileHistoryOnlyLine = JSON.stringify({ type: 'file-history-snapshot', data: {} }) + '\n'
  + JSON.stringify({ type: 'queue-operation', data: {} }) + '\n';

function makeMockSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap_test',
    name: 'my-snap',
    description: 'test snapshot',
    created_at: '2025-01-01T00:00:00Z',
    snapshot_dir: 'snap_test',
    source_session_id: 'orig-session',
    source_project_path: '/test/project',
    message_count: 10,
    estimated_tokens: 5000,
    tags: [],
    parent_snapshot: null,
    session_active_at_capture: false,
    branches: [],
    ...overrides,
  };
}

/**
 * Set up the on-disk file structure expected by createBranch:
 * 1. Snapshot dir with session JSONL
 * 2. Claude projects dir with encoded project path containing a matching session file
 */
async function setupFilesystem(opts: { jsonlContent?: string; skipProjectDir?: boolean; skipJsonl?: boolean } = {}) {
  const snapshotDir = path.join(tmpDirRef.value, 'snapshots', 'snap_test', 'session');
  await fs.mkdir(snapshotDir, { recursive: true });

  if (!opts.skipJsonl) {
    await fs.writeFile(
      path.join(snapshotDir, 'orig-session.jsonl'),
      opts.jsonlContent ?? conversationLine,
      'utf-8',
    );
  }

  if (!opts.skipProjectDir) {
    // Encode "/test/project" → "test--project"
    const encodedDir = path.join(tmpDirRef.value, 'projects', 'test--project');
    await fs.mkdir(encodedDir, { recursive: true });
    // Place original session JSONL so findProjectDir can discover the directory
    await fs.writeFile(
      path.join(encodedDir, 'orig-session.jsonl'),
      opts.jsonlContent ?? conversationLine,
      'utf-8',
    );
  }
}

// ── Lifecycle ──────────────────────────────────────────────────

beforeEach(async () => {
  tmpDirRef.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-branch-test-'));
  mockedGetSnapshot.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDirRef.value, { recursive: true, force: true });
});

// ── createBranch ───────────────────────────────────────────────

describe('createBranch', () => {
  it('dryRun returns command without creating files', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem();

    const result = await createBranch({ snapshotName: 'my-snap', dryRun: true });

    expect(result.launched).toBe(false);
    expect(result.command).toContain('claude');
    expect(result.command).toContain('--resume');
    expect(result.forkedSessionId).toBe('test-uuid-1234-5678-9abc-def012345678');

    // Should NOT have created the destination JSONL
    const projectDir = path.join(tmpDirRef.value, 'projects', 'test--project');
    const destPath = path.join(projectDir, 'test-uuid-1234-5678-9abc-def012345678.jsonl');
    await expect(fs.access(destPath)).rejects.toThrow();
  });

  it('noLaunch copies JSONL, updates index, and records branch', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem();

    const result = await createBranch({
      snapshotName: 'my-snap',
      branchName: 'my-branch',
      noLaunch: true,
    });

    expect(result.launched).toBe(false);
    expect(result.branchName).toBe('my-branch');
    expect(result.forkedSessionId).toBe('test-uuid-1234-5678-9abc-def012345678');

    // Destination JSONL should exist
    const projectDir = path.join(tmpDirRef.value, 'projects', 'test--project');
    const destPath = path.join(projectDir, 'test-uuid-1234-5678-9abc-def012345678.jsonl');
    const content = await fs.readFile(destPath, 'utf-8');
    expect(content).toContain('hello');

    // sessions-index.json should have been created/updated
    const indexRaw = await fs.readFile(path.join(projectDir, 'sessions-index.json'), 'utf-8');
    const index = JSON.parse(indexRaw);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].sessionId).toBe('test-uuid-1234-5678-9abc-def012345678');

    // addBranch should have been called
    expect(addBranch).toHaveBeenCalledWith('my-snap', expect.objectContaining({
      name: 'my-branch',
      forked_session_id: 'test-uuid-1234-5678-9abc-def012345678',
    }));
  });

  it('with trim calls trimJsonl instead of copyFile', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem();

    // trimJsonl mock needs to actually create the dest file for updateSessionsIndex
    const mockedTrimJsonl = vi.mocked(trimJsonl);
    mockedTrimJsonl.mockImplementation(async (_src: unknown, dest: unknown) => {
      await fs.writeFile(dest as string, conversationLine, 'utf-8');
      return {
        originalBytes: 1000, trimmedBytes: 500,
        toolResultsStubbed: 1, signaturesStripped: 0,
        fileHistoryRemoved: 0, imagesStripped: 0,
        toolUseInputsStubbed: 0, preCompactionLinesSkipped: 0,
        queueOperationsRemoved: 0, userMessages: 2, assistantResponses: 2,
        toolUseRequests: 1,
      } as never;
    });

    const result = await createBranch({
      snapshotName: 'my-snap',
      branchName: 'trimmed',
      noLaunch: true,
      trim: true,
    });

    expect(mockedTrimJsonl).toHaveBeenCalled();
    expect(result.trimMetrics).toBeDefined();
    expect(result.trimMetrics!.originalBytes).toBe(1000);
    expect(result.trimMetrics!.trimmedBytes).toBe(500);
  });

  it('throws on missing snapshot', async () => {
    mockedGetSnapshot.mockResolvedValue(null as never);

    await expect(createBranch({ snapshotName: 'nonexistent' }))
      .rejects.toThrow('Snapshot "nonexistent" not found');
  });

  it('throws on missing JSONL file', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem({ skipJsonl: true });

    await expect(createBranch({ snapshotName: 'my-snap' }))
      .rejects.toThrow('Snapshot session file not found');
  });

  it('throws on no conversation content (only file-history entries)', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem({ jsonlContent: fileHistoryOnlyLine });

    await expect(createBranch({ snapshotName: 'my-snap' }))
      .rejects.toThrow('no conversation messages');
  });

  it('auto-generates branch name when not provided', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem();

    const result = await createBranch({
      snapshotName: 'my-snap',
      noLaunch: true,
    });

    // Format: {snapshot}-{YYYYMMDD-HHmm}
    expect(result.branchName).toMatch(/^my-snap-\d{8}-\d{4}$/);
  });

  it('appends orientation message to destination JSONL', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    await setupFilesystem();

    await createBranch({
      snapshotName: 'my-snap',
      branchName: 'oriented',
      noLaunch: true,
      orientationMessage: 'Focus on the auth module.',
    });

    const projectDir = path.join(tmpDirRef.value, 'projects', 'test--project');
    const destPath = path.join(projectDir, 'test-uuid-1234-5678-9abc-def012345678.jsonl');
    const content = await fs.readFile(destPath, 'utf-8');

    // The orientation line should be appended
    expect(content).toContain('Focus on the auth module.');
    const lines = content.trim().split('\n');
    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.type).toBe('human');
    expect(lastLine.message.role).toBe('user');
    expect(lastLine.message.content).toBe('Focus on the auth module.');
  });

  it('throws when project dir not found', async () => {
    const snap = makeMockSnapshot();
    mockedGetSnapshot.mockResolvedValue(snap as never);
    // Set up snapshot JSONL but skip project dir creation
    await setupFilesystem({ skipProjectDir: true });

    await expect(createBranch({ snapshotName: 'my-snap' }))
      .rejects.toThrow('Cannot find Claude project directory');
  });
});

// ── deleteBranch ───────────────────────────────────────────────

describe('deleteBranch', () => {
  it('removes JSONL, sessions-index entry, and CMV branch record', async () => {
    const snap = makeMockSnapshot({
      branches: [
        { name: 'doomed', forked_session_id: 'branch-session-1', created_at: '2025-01-01T00:00:00Z' },
      ],
    });
    mockedGetSnapshot.mockResolvedValue(snap as never);

    // Set up project dir with the branch session file
    const projectDir = path.join(tmpDirRef.value, 'projects', 'test--project');
    await fs.mkdir(projectDir, { recursive: true });
    const branchJsonlPath = path.join(projectDir, 'branch-session-1.jsonl');
    await fs.writeFile(branchJsonlPath, conversationLine, 'utf-8');

    // Write a sessions-index.json with the branch entry
    const sessionsIndex = {
      version: 1,
      entries: [
        { sessionId: 'branch-session-1', fullPath: branchJsonlPath },
        { sessionId: 'other-session', fullPath: '/other.jsonl' },
      ],
      originalPath: '/test/project',
    };
    await fs.writeFile(
      path.join(projectDir, 'sessions-index.json'),
      JSON.stringify(sessionsIndex),
      'utf-8',
    );

    await deleteBranch('my-snap', 'doomed');

    // JSONL should be deleted
    await expect(fs.access(branchJsonlPath)).rejects.toThrow();

    // sessions-index should no longer contain the branch entry
    const updatedRaw = await fs.readFile(path.join(projectDir, 'sessions-index.json'), 'utf-8');
    const updatedIndex = JSON.parse(updatedRaw);
    expect(updatedIndex.entries).toHaveLength(1);
    expect(updatedIndex.entries[0].sessionId).toBe('other-session');

    // removeBranch should have been called
    expect(removeBranch).toHaveBeenCalledWith('my-snap', 'doomed');
  });

  it('throws on missing snapshot', async () => {
    mockedGetSnapshot.mockResolvedValue(null as never);

    await expect(deleteBranch('nonexistent', 'any'))
      .rejects.toThrow('Snapshot "nonexistent" not found');
  });

  it('throws on missing branch', async () => {
    const snap = makeMockSnapshot({ branches: [] });
    mockedGetSnapshot.mockResolvedValue(snap as never);

    await expect(deleteBranch('my-snap', 'no-such-branch'))
      .rejects.toThrow('Branch "no-such-branch" not found in snapshot "my-snap"');
  });
});

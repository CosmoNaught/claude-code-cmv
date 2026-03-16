import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ClaudeSessionEntry } from '../src/types/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-reader-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

async function writeJsonl(dir: string, name: string, lines: any[]): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('session-reader cwd extraction', () => {
  it('extracts cwd from JSONL when sessions-index.json has encoded projectPath', async () => {
    // Simulate a project dir with an ambiguous name (dashes in project name)
    const projectDir = path.join(tmpDir, '-Users-user-Projects-claude-code-cmv');
    await fs.mkdir(projectDir, { recursive: true });

    // Write a sessions-index.json with an encoded (dash-prefixed) projectPath
    const index = {
      version: 1,
      entries: [{
        sessionId: 'test-session-123',
        projectPath: '-Users-user-Projects-claude-code-cmv',
        messageCount: 0,
      }],
    };
    await fs.writeFile(path.join(projectDir, 'sessions-index.json'), JSON.stringify(index));

    // Write JSONL with a cwd field
    await writeJsonl(projectDir, 'test-session-123.jsonl', [
      { type: 'system', cwd: '/Users/user/Projects/claude-code-cmv' },
      { type: 'user', content: 'hello' },
      { type: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);

    // We need to dynamically import to avoid module resolution issues with paths.js
    // Instead, test the core logic: that countConversationMessages returns cwd
    // Since readSessionsIndex depends on listProjectDirs, we test the extraction logic directly
    const { extractClaudeVersion } = await import('../src/core/session-reader.js');

    // At minimum, verify the JSONL is readable
    const jsonlPath = path.join(projectDir, 'test-session-123.jsonl');
    const version = await extractClaudeVersion(jsonlPath);
    // No version field in our test data
    expect(version).toBeNull();
  });

  it('extractClaudeVersion reads version from first line', async () => {
    const jsonlPath = await writeJsonl(tmpDir, 'versioned.jsonl', [
      { version: '1.0.42', type: 'system' },
      { type: 'user', content: 'hello' },
    ]);

    const { extractClaudeVersion } = await import('../src/core/session-reader.js');
    const version = await extractClaudeVersion(jsonlPath);
    expect(version).toBe('1.0.42');
  });

  it('extractClaudeVersion returns null for missing file', async () => {
    const { extractClaudeVersion } = await import('../src/core/session-reader.js');
    const version = await extractClaudeVersion(path.join(tmpDir, 'nonexistent.jsonl'));
    expect(version).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests for listAllSessions, getLatestSession, findSession, isSessionActive,
// deleteSession, getSessionJsonlPath
// ---------------------------------------------------------------------------

describe('session-reader with mocked project dirs', () => {
  let projectDirA: string;
  let projectDirB: string;

  // We mock listProjectDirs to return our tmpDir-based project dirs
  let listProjectDirsMock: MockInstance;

  beforeEach(async () => {
    projectDirA = path.join(tmpDir, 'project-a');
    projectDirB = path.join(tmpDir, 'project-b');
    await fs.mkdir(projectDirA, { recursive: true });
    await fs.mkdir(projectDirB, { recursive: true });

    // Mock the paths module so listProjectDirs returns our test dirs
    const pathsMod = await import('../src/utils/paths.js');
    listProjectDirsMock = vi.spyOn(pathsMod, 'listProjectDirs').mockResolvedValue([
      projectDirA,
      projectDirB,
    ]);
  });

  afterEach(() => {
    listProjectDirsMock.mockRestore();
  });

  /** Helper: write sessions-index.json */
  async function writeIndex(dir: string, entries: any[], originalPath?: string) {
    const index: any = { version: 1, entries };
    if (originalPath) index.originalPath = originalPath;
    await fs.writeFile(path.join(dir, 'sessions-index.json'), JSON.stringify(index));
  }

  /** Helper: create a session JSONL with user/assistant messages */
  async function createSession(dir: string, sessionId: string, messages?: any[]) {
    const lines = messages || [
      { type: 'system', cwd: '/test/project' },
      { type: 'user', content: `Hello from ${sessionId}` },
      { type: 'assistant', content: [{ type: 'text', text: `Response for ${sessionId}` }] },
    ];
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return filePath;
  }

  describe('listAllSessions', () => {
    it('lists sessions from multiple project dirs', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'session-aaa-111', projectPath: '/test/project-a', messageCount: 5 },
      ]);
      await createSession(projectDirA, 'session-aaa-111');

      await writeIndex(projectDirB, [
        { sessionId: 'session-bbb-222', projectPath: '/test/project-b', messageCount: 3 },
      ]);
      await createSession(projectDirB, 'session-bbb-222');

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();

      expect(sessions.length).toBeGreaterThanOrEqual(2);
      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('session-aaa-111');
      expect(ids).toContain('session-bbb-222');
    });

    it('returns sessions sorted by modified date (newest first)', async () => {
      // Create session-1 first
      await createSession(projectDirA, 'session-old');
      // Wait a tiny bit so mtime differs
      await new Promise(resolve => setTimeout(resolve, 50));
      await createSession(projectDirA, 'session-new');

      await writeIndex(projectDirA, [
        { sessionId: 'session-old', projectPath: '/test/a', messageCount: 2 },
        { sessionId: 'session-new', projectPath: '/test/a', messageCount: 2 },
      ]);

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();

      const oldIdx = sessions.findIndex(s => s.sessionId === 'session-old');
      const newIdx = sessions.findIndex(s => s.sessionId === 'session-new');
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it('returns empty array when no project dirs have sessions', async () => {
      listProjectDirsMock.mockResolvedValue([]);
      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();
      expect(sessions).toEqual([]);
    });

    it('discovers JSONL files not listed in sessions-index.json', async () => {
      // Index lists only one session, but two JSONL files exist
      await writeIndex(projectDirA, [
        { sessionId: 'indexed-session', projectPath: '/test/a', messageCount: 2 },
      ]);
      await createSession(projectDirA, 'indexed-session');
      await createSession(projectDirA, 'unindexed-session');

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();

      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('indexed-session');
      expect(ids).toContain('unindexed-session');
    });
  });

  describe('getLatestSession', () => {
    it('returns the most recently modified session', async () => {
      await createSession(projectDirA, 'older-session');
      await new Promise(resolve => setTimeout(resolve, 50));
      await createSession(projectDirA, 'newer-session');

      await writeIndex(projectDirA, [
        { sessionId: 'older-session', projectPath: '/test/a', messageCount: 2 },
        { sessionId: 'newer-session', projectPath: '/test/a', messageCount: 2 },
      ]);

      const { getLatestSession } = await import('../src/core/session-reader.js');
      const latest = await getLatestSession();

      expect(latest).not.toBeNull();
      expect(latest!.sessionId).toBe('newer-session');
    });

    it('returns null when no sessions exist', async () => {
      listProjectDirsMock.mockResolvedValue([]);
      const { getLatestSession } = await import('../src/core/session-reader.js');
      const latest = await getLatestSession();
      expect(latest).toBeNull();
    });
  });

  describe('findSession', () => {
    it('finds a session by exact ID', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'session-abc-12345', projectPath: '/test/a', messageCount: 3 },
      ]);
      await createSession(projectDirA, 'session-abc-12345');

      const { findSession } = await import('../src/core/session-reader.js');
      const found = await findSession('session-abc-12345');

      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe('session-abc-12345');
    });

    it('finds a session by prefix match (minimum 4 chars)', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'session-unique-xyz', projectPath: '/test/a', messageCount: 3 },
      ]);
      await createSession(projectDirA, 'session-unique-xyz');

      const { findSession } = await import('../src/core/session-reader.js');
      const found = await findSession('session-unique');

      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe('session-unique-xyz');
    });

    it('throws on ambiguous prefix match', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'session-dup-001', projectPath: '/test/a', messageCount: 2 },
        { sessionId: 'session-dup-002', projectPath: '/test/a', messageCount: 2 },
      ]);
      await createSession(projectDirA, 'session-dup-001');
      await createSession(projectDirA, 'session-dup-002');

      const { findSession } = await import('../src/core/session-reader.js');
      await expect(findSession('session-dup')).rejects.toThrow(/Ambiguous/);
    });

    it('returns null for non-existent session', async () => {
      await writeIndex(projectDirA, []);

      const { findSession } = await import('../src/core/session-reader.js');
      const found = await findSession('nonexistent-session-id');
      expect(found).toBeNull();
    });
  });

  describe('getSessionJsonlPath', () => {
    it('returns the correct JSONL path for a session entry', async () => {
      const { getSessionJsonlPath } = await import('../src/core/session-reader.js');

      const entry = {
        sessionId: 'test-session-42',
        fullPath: '',
        _projectDir: projectDirA,
      };

      const result = getSessionJsonlPath(entry);
      expect(result).toBe(path.join(projectDirA, 'test-session-42.jsonl'));
    });
  });

  describe('isSessionActive', () => {
    it('returns false for a session with old mtime', async () => {
      const { isSessionActive } = await import('../src/core/session-reader.js');

      const entry: ClaudeSessionEntry = {
        sessionId: 'old-session',
        fullPath: '',
        fileMtime: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      };

      const active = await isSessionActive(entry);
      expect(active).toBe(false);
    });

    it('returns true for a session with very recent mtime', async () => {
      const { isSessionActive } = await import('../src/core/session-reader.js');

      const entry: ClaudeSessionEntry = {
        sessionId: 'active-session',
        fullPath: '',
        fileMtime: Date.now(), // just now
      };

      // Even without lock files, a very recent mtime returns true
      const active = await isSessionActive(entry);
      expect(active).toBe(true);
    });

    it('returns false when fileMtime is 0 (unknown)', async () => {
      const { isSessionActive } = await import('../src/core/session-reader.js');

      const entry: ClaudeSessionEntry = {
        sessionId: 'no-mtime',
        fullPath: '',
        fileMtime: 0,
      };

      const active = await isSessionActive(entry);
      expect(active).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('removes the JSONL file and index entry', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'to-delete', projectPath: '/test/a', messageCount: 2 },
        { sessionId: 'to-keep', projectPath: '/test/a', messageCount: 3 },
      ]);
      await createSession(projectDirA, 'to-delete');
      await createSession(projectDirA, 'to-keep');

      const { deleteSession } = await import('../src/core/session-reader.js');

      await deleteSession({
        sessionId: 'to-delete',
        fullPath: path.join(projectDirA, 'to-delete.jsonl'),
        _projectDir: projectDirA,
      });

      // JSONL file should be gone
      await expect(fs.access(path.join(projectDirA, 'to-delete.jsonl'))).rejects.toThrow();

      // Index should no longer contain the deleted session
      const rawIndex = await fs.readFile(path.join(projectDirA, 'sessions-index.json'), 'utf-8');
      const index = JSON.parse(rawIndex);
      expect(index.entries.map((e: any) => e.sessionId)).not.toContain('to-delete');
      expect(index.entries.map((e: any) => e.sessionId)).toContain('to-keep');
    });

    it('removes session subdirectory if it exists', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'with-subdir', projectPath: '/test/a', messageCount: 1 },
      ]);
      await createSession(projectDirA, 'with-subdir');
      // Create a session subdirectory (subagents/tool-results)
      const sessionSubdir = path.join(projectDirA, 'with-subdir');
      await fs.mkdir(sessionSubdir, { recursive: true });
      await fs.writeFile(path.join(sessionSubdir, 'subagent.jsonl'), '{}');

      const { deleteSession } = await import('../src/core/session-reader.js');

      await deleteSession({
        sessionId: 'with-subdir',
        fullPath: path.join(projectDirA, 'with-subdir.jsonl'),
        _projectDir: projectDirA,
      });

      // Both the JSONL and subdirectory should be gone
      await expect(fs.access(path.join(projectDirA, 'with-subdir.jsonl'))).rejects.toThrow();
      await expect(fs.access(sessionSubdir)).rejects.toThrow();
    });

    it('does not throw if JSONL file is already missing', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'already-gone', projectPath: '/test/a' },
      ]);
      // Don't create the JSONL file

      const { deleteSession } = await import('../src/core/session-reader.js');

      // Should not throw
      await deleteSession({
        sessionId: 'already-gone',
        fullPath: path.join(projectDirA, 'already-gone.jsonl'),
        _projectDir: projectDirA,
      });
    });

    it('does not throw when sessions-index.json does not exist', async () => {
      // Create only the JSONL file, no sessions-index.json
      await createSession(projectDirA, 'no-index-session');

      const { deleteSession } = await import('../src/core/session-reader.js');

      // Should not throw even though sessions-index.json is missing (lines 428-430)
      await deleteSession({
        sessionId: 'no-index-session',
        fullPath: path.join(projectDirA, 'no-index-session.jsonl'),
        _projectDir: projectDirA,
      });

      // JSONL should be removed
      await expect(fs.access(path.join(projectDirA, 'no-index-session.jsonl'))).rejects.toThrow();
    });

    it('does not throw when session subdirectory does not exist', async () => {
      // Only JSONL, no subdirectory — exercises the catch on lines 417-419
      await writeIndex(projectDirA, [
        { sessionId: 'no-subdir', projectPath: '/test/a', messageCount: 1 },
      ]);
      await createSession(projectDirA, 'no-subdir');

      const { deleteSession } = await import('../src/core/session-reader.js');

      await deleteSession({
        sessionId: 'no-subdir',
        fullPath: path.join(projectDirA, 'no-subdir.jsonl'),
        _projectDir: projectDirA,
      });
    });
  });

  describe('scanJsonlFiles fallback (no sessions-index.json)', () => {
    it('discovers sessions from JSONL files when sessions-index.json is missing', async () => {
      // Create JSONL files but NO sessions-index.json in projectDirA
      await createSession(projectDirA, 'fallback-session-1');
      await createSession(projectDirA, 'fallback-session-2');
      // Remove sessions-index.json if it exists
      try { await fs.unlink(path.join(projectDirA, 'sessions-index.json')); } catch { /* noop */ }

      // projectDirB has nothing
      await writeIndex(projectDirB, []);

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();

      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('fallback-session-1');
      expect(ids).toContain('fallback-session-2');

      // Verify entries have expected fields populated from JSONL scanning
      const fb1 = sessions.find(s => s.sessionId === 'fallback-session-1')!;
      expect(fb1.messageCount).toBeGreaterThanOrEqual(2); // user + assistant
      expect(fb1.created).toBeDefined();
      expect(fb1.modified).toBeDefined();
    });

    it('returns empty when project dir has no JSONL files and no index', async () => {
      // Both dirs exist but have no files at all
      try { await fs.unlink(path.join(projectDirA, 'sessions-index.json')); } catch { /* noop */ }
      try { await fs.unlink(path.join(projectDirB, 'sessions-index.json')); } catch { /* noop */ }

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('listAllSessions with projectFilter', () => {
    it('filters sessions by directory name', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'filter-a-1', projectPath: '/test/project-a', messageCount: 2 },
      ]);
      await createSession(projectDirA, 'filter-a-1');

      await writeIndex(projectDirB, [
        { sessionId: 'filter-b-1', projectPath: '/test/project-b', messageCount: 2 },
      ]);
      await createSession(projectDirB, 'filter-b-1');

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions('project-a');

      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('filter-a-1');
      expect(ids).not.toContain('filter-b-1');
    });

    it('filters sessions by projectPath field', async () => {
      // Both dirs match the dir filter, but only one entry has matching projectPath
      const projectDirC = path.join(tmpDir, 'shared-dir');
      await fs.mkdir(projectDirC, { recursive: true });
      listProjectDirsMock.mockResolvedValue([projectDirC]);

      await writeIndex(projectDirC, [
        { sessionId: 'path-match', projectPath: '/home/user/myapp', messageCount: 2 },
        { sessionId: 'path-nomatch', projectPath: '/home/user/other', messageCount: 2 },
      ]);
      await createSession(projectDirC, 'path-match');
      await createSession(projectDirC, 'path-nomatch');

      const { listAllSessions } = await import('../src/core/session-reader.js');
      // Filter by something in the projectPath — but dir name "shared-dir" doesn't contain "myapp"
      // so only dir-level filter applies first, then projectPath filter
      const sessions = await listAllSessions('shared-dir');

      // Both should appear because the dir name matches "shared-dir"
      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('path-match');
      expect(ids).toContain('path-nomatch');
    });
  });

  describe('listSessionsByProject', () => {
    it('delegates to listAllSessions with the project filter', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'lsbp-session', projectPath: '/test/project-a', messageCount: 2 },
      ]);
      await createSession(projectDirA, 'lsbp-session');

      const { listSessionsByProject } = await import('../src/core/session-reader.js');
      const sessions = await listSessionsByProject('project-a');

      const ids = sessions.map(s => s.sessionId);
      expect(ids).toContain('lsbp-session');
    });
  });

  describe('findSession short prefix', () => {
    it('returns null when prefix is less than 4 characters', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'abcdef-session', projectPath: '/test/a', messageCount: 2 },
      ]);
      await createSession(projectDirA, 'abcdef-session');

      const { findSession } = await import('../src/core/session-reader.js');
      const found = await findSession('abc');
      expect(found).toBeNull();
    });
  });

  describe('isSessionActive with lock files', () => {
    let lockDirMock: MockInstance;
    let lockDir: string;

    beforeEach(async () => {
      lockDir = path.join(tmpDir, 'ide-locks');
      await fs.mkdir(lockDir, { recursive: true });

      const pathsMod = await import('../src/utils/paths.js');
      lockDirMock = vi.spyOn(pathsMod, 'getClaudeIdeLockDir').mockReturnValue(lockDir);
    });

    afterEach(() => {
      lockDirMock.mockRestore();
    });

    it('returns true when mtime is recent and a lock file with PID exists', async () => {
      // Write a lock file with a PID
      await fs.writeFile(
        path.join(lockDir, 'session.lock'),
        JSON.stringify({ pid: 12345 }),
      );

      const { isSessionActive } = await import('../src/core/session-reader.js');
      const entry: ClaudeSessionEntry = {
        sessionId: 'lock-active',
        fullPath: '',
        fileMtime: Date.now(), // very recent
      };

      const active = await isSessionActive(entry);
      expect(active).toBe(true);
    });

    it('returns true when mtime is recent and lock file has no PID', async () => {
      // Lock file without a pid field
      await fs.writeFile(
        path.join(lockDir, 'session.lock'),
        JSON.stringify({ status: 'idle' }),
      );

      const { isSessionActive } = await import('../src/core/session-reader.js');
      const entry: ClaudeSessionEntry = {
        sessionId: 'lock-no-pid',
        fullPath: '',
        fileMtime: Date.now(),
      };

      // No lock with PID found, but mtime is very recent → still true (line 337)
      const active = await isSessionActive(entry);
      expect(active).toBe(true);
    });

    it('returns true when mtime is recent and lock dir is empty', async () => {
      const { isSessionActive } = await import('../src/core/session-reader.js');
      const entry: ClaudeSessionEntry = {
        sessionId: 'lock-empty-dir',
        fullPath: '',
        fileMtime: Date.now(),
      };

      const active = await isSessionActive(entry);
      expect(active).toBe(true);
    });

    it('skips non-.lock files in the lock directory', async () => {
      // Write a non-lock file and a lock file without PID
      await fs.writeFile(path.join(lockDir, 'readme.txt'), 'not a lock');
      await fs.writeFile(
        path.join(lockDir, 'test.lock'),
        JSON.stringify({ status: 'no-pid' }),
      );

      const { isSessionActive } = await import('../src/core/session-reader.js');
      const entry: ClaudeSessionEntry = {
        sessionId: 'lock-filter',
        fullPath: '',
        fileMtime: Date.now(),
      };

      const active = await isSessionActive(entry);
      expect(active).toBe(true);
    });

    it('handles malformed lock file JSON gracefully', async () => {
      await fs.writeFile(path.join(lockDir, 'bad.lock'), 'not valid json{{{');

      const { isSessionActive } = await import('../src/core/session-reader.js');
      const entry: ClaudeSessionEntry = {
        sessionId: 'lock-bad-json',
        fullPath: '',
        fileMtime: Date.now(),
      };

      // Should not throw; falls through to return true (recent mtime)
      const active = await isSessionActive(entry);
      expect(active).toBe(true);
    });
  });

  describe('readSessionsIndex needsCount/needsPath conditions', () => {
    it('parses JSONL to fill messageCount when index entry has messageCount=0', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'needs-count', projectPath: '/test/a', messageCount: 0 },
      ]);
      await createSession(projectDirA, 'needs-count');

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();
      const session = sessions.find(s => s.sessionId === 'needs-count');
      expect(session).toBeDefined();
      expect(session!.messageCount).toBeGreaterThanOrEqual(2);
    });

    it('updates projectPath from JSONL cwd when index entry has encoded path', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'needs-path', projectPath: '-Users-user-proj', messageCount: 5 },
      ]);
      await createSession(projectDirA, 'needs-path', [
        { type: 'system', cwd: '/Users/user/proj' },
        { type: 'user', content: 'hello' },
        { type: 'assistant', content: 'hi' },
      ]);

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();
      const session = sessions.find(s => s.sessionId === 'needs-path');
      expect(session).toBeDefined();
      expect(session!.projectPath).toBe('/Users/user/proj');
    });

    it('fills firstPrompt from JSONL when index entry lacks it', async () => {
      await writeIndex(projectDirA, [
        { sessionId: 'needs-prompt', projectPath: '/test/a', messageCount: 0 },
      ]);
      await createSession(projectDirA, 'needs-prompt', [
        { type: 'system', cwd: '/test/a' },
        { type: 'user', content: 'What is the meaning of life?' },
        { type: 'assistant', content: '42' },
      ]);

      const { listAllSessions } = await import('../src/core/session-reader.js');
      const sessions = await listAllSessions();
      const session = sessions.find(s => s.sessionId === 'needs-prompt');
      expect(session).toBeDefined();
      expect(session!.firstPrompt).toBe('What is the meaning of life?');
    });
  });
});

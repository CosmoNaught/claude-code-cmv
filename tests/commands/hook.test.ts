import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('../../src/utils/errors.js', () => ({
  handleError: vi.fn(),
  CmvError: class extends Error { constructor(public userMessage: string) { super(userMessage); } },
}));

vi.mock('../../src/utils/display.js', () => ({
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dim: (s: string) => s,
  bold: (s: string) => s,
  formatDate: (s: string) => s,
  formatRelativeTime: (s: string) => 'recently',
  truncate: (s: string) => s,
  formatTable: () => 'table',
}));

vi.mock('../../src/utils/paths.js', () => ({
  getClaudeSettingsPath: () => '/fake/settings.json',
  getCmvAutoTrimLogPath: () => '/fake/auto-trim.log',
  getClaudeProjectsDir: () => '/fake/projects',
}));

const mockListBackups = vi.fn().mockResolvedValue([]);
const mockRestoreBackup = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/core/auto-backup.js', () => ({
  listBackups: (...args: any[]) => mockListBackups(...args),
  restoreBackup: (...args: any[]) => mockRestoreBackup(...args),
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockAccess = vi.fn();
const mockReaddir = vi.fn().mockResolvedValue([]);

vi.mock('node:fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  access: (...args: any[]) => mockAccess(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
}));

import { registerHookCommand } from '../../src/commands/hook.js';
import { success, info } from '../../src/utils/display.js';

describe('hook command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
  });

  // ── install ────────────────────────────────────────────────────────────────

  it('hook install writes settings', async () => {
    mockReadFile.mockResolvedValue('{}');
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'install']);
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/fake/settings.json',
      expect.stringContaining('PreCompact'),
      'utf-8',
    );
    expect(success).toHaveBeenCalledWith(expect.stringContaining('installed'));
  });

  // ── uninstall ──────────────────────────────────────────────────────────────

  it('hook uninstall removes CMV hooks', async () => {
    const settingsWithHooks = JSON.stringify({
      hooks: {
        PreCompact: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'cmv auto-trim', timeout: 30 }],
        }],
      },
    });
    mockReadFile.mockResolvedValue(settingsWithHooks);
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'uninstall']);
    expect(mockWriteFile).toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(expect.stringContaining('Removed'));
  });

  it('hook uninstall when no hooks key exists shows info', async () => {
    mockReadFile.mockResolvedValue('{}');
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'uninstall']);
    expect(info).toHaveBeenCalledWith('No hooks installed.');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('hook uninstall when no CMV hooks are present shows info', async () => {
    const settingsWithNonCmvHooks = JSON.stringify({
      hooks: {
        PreCompact: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'some-other-tool', timeout: 30 }],
        }],
      },
    });
    mockReadFile.mockResolvedValue(settingsWithNonCmvHooks);
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'uninstall']);
    expect(info).toHaveBeenCalledWith('No CMV hooks found.');
  });

  // ── status ─────────────────────────────────────────────────────────────────

  it('hook status shows not-installed when settings empty', async () => {
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('settings')) return Promise.resolve('{}');
      return Promise.reject(new Error('not found'));
    });
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'status']);
    expect(console.log).toHaveBeenCalledWith('Hook status:');
  });

  it('hook status shows last trim when log has entries', async () => {
    const logEntry = {
      timestamp: '2026-03-15T10:00:00Z',
      sessionId: 'abc123',
      trigger: 'PreCompact',
      originalBytes: 2097152,
      trimmedBytes: 1048576,
      reductionPercent: 50,
      backupPath: '/fake/backup.jsonl',
    };
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('settings')) {
        return Promise.resolve(JSON.stringify({
          hooks: {
            PreCompact: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'cmv auto-trim', timeout: 30 }],
            }],
          },
        }));
      }
      if (filePath.includes('auto-trim')) {
        return Promise.resolve(JSON.stringify([logEntry]));
      }
      return Promise.reject(new Error('not found'));
    });
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'status']);
    expect(console.log).toHaveBeenCalledWith('Last trim:');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(logEntry.timestamp));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(logEntry.trigger));
  });

  // ── restore --list ─────────────────────────────────────────────────────────

  it('hook restore --list shows available backups', async () => {
    mockListBackups.mockResolvedValue([
      {
        path: '/fake/backups/abc1234567_2026-03-15T10-00-00-000Z.jsonl',
        sessionId: 'abc1234567890',
        timestamp: '2026-03-15T10:00:00Z',
        size: 204800,
      },
    ]);
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'restore', '--list']);
    expect(console.log).toHaveBeenCalledWith('Available backups:');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('abc1234567'));
  });

  it('hook restore --list with no backups shows info', async () => {
    mockListBackups.mockResolvedValue([]);
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'restore', '--list']);
    expect(info).toHaveBeenCalledWith('No backups found.');
  });

  it('hook restore with session id and no backups shows info', async () => {
    mockListBackups.mockResolvedValue([]);
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'restore', 'mysessionid']);
    expect(info).toHaveBeenCalledWith('No backups for session mysessionid.');
  });

  it('hook restore with session id finds and restores the file', async () => {
    const backup = {
      path: '/fake/backups/mysessionid_2026-03-15.jsonl',
      sessionId: 'mysessionid',
      timestamp: '2026-03-15T10:00:00Z',
      size: 102400,
    };
    mockListBackups.mockResolvedValue([backup]);
    // readdir returns one directory entry
    mockReaddir.mockResolvedValue([
      { name: 'proj-dir', isDirectory: () => true },
    ]);
    // access resolves (file exists) for the first path tried
    mockAccess.mockResolvedValue(undefined);
    mockRestoreBackup.mockResolvedValue(undefined);

    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'restore', 'mysessionid']);
    expect(mockRestoreBackup).toHaveBeenCalledWith(
      backup.path,
      expect.stringContaining('mysessionid'),
    );
    expect(success).toHaveBeenCalledWith(expect.stringContaining('Restored'));
  });

  it('hook restore with session id cannot find original file shows backup path', async () => {
    const backup = {
      path: '/fake/backups/mysessionid_2026-03-15.jsonl',
      sessionId: 'mysessionid',
      timestamp: '2026-03-15T10:00:00Z',
      size: 102400,
    };
    mockListBackups.mockResolvedValue([backup]);
    mockReaddir.mockResolvedValue([
      { name: 'proj-dir', isDirectory: () => true },
    ]);
    // access rejects (file not found in any project dir)
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'cmv', 'hook', 'restore', 'mysessionid']);
    expect(info).toHaveBeenCalledWith('Could not find original session file. Backup is at:');
    expect(console.log).toHaveBeenCalledWith(`  ${backup.path}`);
  });
});

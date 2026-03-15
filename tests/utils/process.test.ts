// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted runs before vi.mock factories, so the variable is available
const { execAsyncMock } = vi.hoisted(() => {
  const execAsyncMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  return { execAsyncMock };
});

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: () => execAsyncMock,
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation(() => {
    throw new Error('not found');
  }),
  spawn: vi.fn().mockReturnValue({
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'close') setTimeout(() => cb(0), 0);
    }),
    unref: vi.fn(),
  }),
  exec: vi.fn().mockImplementation((cmd: string, opts: any, cb?: Function) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback) {
      callback(null, '', '');
    }
    return { on: vi.fn(), unref: vi.fn() };
  }),
}));

vi.mock('node:fs', () => ({
  openSync: vi.fn().mockReturnValue(3),
  closeSync: vi.fn(),
  accessSync: vi.fn(),
}));

import {
  getClaudeCliPath,
  getRunningSessionIds,
  spawnClaudeInteractive,
  spawnClaudeInNewWindow,
} from '../../src/utils/process.js';
import { exec, execFileSync, spawn } from 'node:child_process';
import { openSync, closeSync, accessSync } from 'node:fs';

// Keep original platform so we can restore it after each test
const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getClaudeCliPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns configPath when provided', () => {
    expect(getClaudeCliPath('/custom/claude')).toBe('/custom/claude');
  });

  it('returns "claude" as fallback when nothing works', () => {
    const result = getClaudeCliPath();
    expect(result).toBe('claude');
  });

  it('returns full path when bare "claude" execFileSync succeeds and resolveFullPath returns a path', () => {
    // First execFileSync call (bare 'claude --version') succeeds
    // Second call (resolveFullPath via /bin/sh -c 'command -v claude') returns a full path string
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => '') // bare 'claude' works (returns string with encoding)
      .mockImplementationOnce(() => '/usr/local/bin/claude\n'); // command -v resolves it

    const result = getClaudeCliPath();
    expect(result).toBe('/usr/local/bin/claude');
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'claude', ['--version'], { stdio: 'ignore' });
    expect(execFileSync).toHaveBeenNthCalledWith(2, '/bin/sh', ['-c', 'command -v claude'], expect.objectContaining({ encoding: 'utf-8' }));
  });

  it('returns bare "claude" when execFileSync succeeds but resolveFullPath returns empty string', () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => '') // bare 'claude' works
      .mockImplementationOnce(() => '   \n'); // resolveFullPath returns whitespace-only

    const result = getClaudeCliPath();
    expect(result).toBe('claude');
  });

  it('returns bare "claude" when execFileSync succeeds but resolveFullPath throws', () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => '') // bare 'claude' works
      .mockImplementationOnce(() => { throw new Error('sh not found'); }); // resolveFullPath fails

    const result = getClaudeCliPath();
    expect(result).toBe('claude');
  });

  it('returns a known candidate path on non-win32 when candidate execFileSync succeeds', () => {
    // bare 'claude' fails; then the first candidate check succeeds
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('not found'); }) // bare claude fails
      .mockImplementationOnce(() => Buffer.from('')); // first candidate succeeds

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const result = getClaudeCliPath();
    // First non-win32 candidate is ~/.local/bin/claude
    expect(result).toContain('claude');
    expect(result).not.toBe('claude'); // should be a full path candidate
  });

  it('returns a known candidate path on win32 when candidate execFileSync succeeds', () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('not found'); }) // bare claude fails
      .mockImplementationOnce(() => Buffer.from('')); // first win32 candidate succeeds

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const result = getClaudeCliPath();
    expect(result).toContain('claude');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getRunningSessionIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty set on error', async () => {
    execAsyncMock.mockRejectedValueOnce(new Error('fail'));

    const ids = await getRunningSessionIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
  });

  it('parses UUIDs from stdout with --resume patterns', async () => {
    const uuid1 = 'abc12345-1234-1234-1234-123456789abc';
    const uuid2 = 'def67890-5678-5678-5678-567890abcdef';
    const stdout = [
      `claude --resume ${uuid1}`,
      'some-other-process --flag value',
      `claude --resume ${uuid2}`,
    ].join('\n');

    execAsyncMock.mockResolvedValueOnce({ stdout, stderr: '' });

    const ids = await getRunningSessionIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(2);
    expect(ids.has(uuid1)).toBe(true);
    expect(ids.has(uuid2)).toBe(true);
  });

  it('returns empty set when no --resume patterns found', async () => {
    execAsyncMock.mockResolvedValueOnce({
      stdout: 'node server.js\nbash\n',
      stderr: '',
    });

    const ids = await getRunningSessionIds();
    expect(ids.size).toBe(0);
  });

  it('uses wmic command on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    execAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await getRunningSessionIds();

    expect(execAsyncMock).toHaveBeenCalledWith(
      expect.stringContaining('wmic'),
      expect.anything(),
    );
  });

  it('uses ps command on non-win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await getRunningSessionIds();

    expect(execAsyncMock).toHaveBeenCalledWith(
      expect.stringContaining('ps'),
      expect.anything(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('spawnClaudeInteractive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stdin.destroyed to false for most tests
    Object.defineProperty(process.stdin, 'destroyed', { value: false, configurable: true });
    // Default spawn mock resolves with code 0
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'close') setTimeout(() => cb(0), 0);
      }),
      unref: vi.fn(),
    } as any);
  });

  it('resolves with exit code 0', async () => {
    const code = await spawnClaudeInteractive(['--resume', 'test-id']);
    expect(code).toBe(0);
  });

  it('resolves with non-zero exit code', async () => {
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'close') setTimeout(() => cb(42), 0);
      }),
      unref: vi.fn(),
    } as any);

    const code = await spawnClaudeInteractive(['--resume', 'test-id']);
    expect(code).toBe(42);
  });

  it('rejects on spawn error', async () => {
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'error') setTimeout(() => cb(new Error('spawn error')), 0);
      }),
      unref: vi.fn(),
    } as any);

    await expect(spawnClaudeInteractive(['--resume', 'test-id'])).rejects.toThrow('spawn error');
  });

  it('uses process.cwd() when cwd is invalid (accessSync throws)', async () => {
    vi.mocked(accessSync).mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    const code = await spawnClaudeInteractive(['--resume', 'test-id'], undefined, '/nonexistent/path');
    expect(code).toBe(0);

    // spawn should be called without the invalid cwd
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'test-id'],
      expect.not.objectContaining({ cwd: '/nonexistent/path' }),
    );
  });

  it('passes valid cwd to spawn when accessSync succeeds', async () => {
    vi.mocked(accessSync).mockImplementationOnce(() => undefined); // succeeds

    const code = await spawnClaudeInteractive(['--resume', 'test-id'], undefined, '/valid/path');
    expect(code).toBe(0);

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'test-id'],
      expect.objectContaining({ cwd: '/valid/path' }),
    );
  });

  it('on win32 with destroyed stdin, opens CONIN$ and uses fd array for stdio', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process.stdin, 'destroyed', { value: true, configurable: true });
    vi.mocked(openSync).mockReturnValue(5);

    const code = await spawnClaudeInteractive(['--resume', 'test-id']);
    expect(code).toBe(0);

    expect(openSync).toHaveBeenCalledWith('CONIN$', 'r+');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'test-id'],
      expect.objectContaining({ stdio: [5, 'inherit', 'inherit'] }),
    );
    // closeSync should have been called during cleanup
    expect(closeSync).toHaveBeenCalledWith(5);
  });

  it('on win32 with destroyed stdin, falls back to "inherit" when CONIN$ open fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process.stdin, 'destroyed', { value: true, configurable: true });
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw new Error('CONIN$ unavailable');
    });

    const code = await spawnClaudeInteractive(['--resume', 'test-id']);
    expect(code).toBe(0);

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'test-id'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    // closeSync should NOT be called since fd was never opened
    expect(closeSync).not.toHaveBeenCalled();
  });

  it('on non-win32 with destroyed stdin, does not open CONIN$', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process.stdin, 'destroyed', { value: true, configurable: true });

    const code = await spawnClaudeInteractive(['--resume', 'test-id']);
    expect(code).toBe(0);

    expect(openSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'test-id'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('calls cleanup (closeSync) even when spawn errors on win32 with open CONIN$', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process.stdin, 'destroyed', { value: true, configurable: true });
    vi.mocked(openSync).mockReturnValue(7);

    vi.mocked(spawn).mockReturnValue({
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'error') setTimeout(() => cb(new Error('spawn fail')), 0);
      }),
      unref: vi.fn(),
    } as any);

    await expect(spawnClaudeInteractive(['--resume', 'test-id'])).rejects.toThrow('spawn fail');
    expect(closeSync).toHaveBeenCalledWith(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('spawnClaudeInNewWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw on default platform', () => {
    expect(() => spawnClaudeInNewWindow('test-session-id-1234')).not.toThrow();
  });

  it('on win32 calls exec with start command', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('start'),
      expect.anything(),
    );
    const callArg = vi.mocked(exec).mock.calls[0][0] as string;
    expect(callArg).toContain('cmd /k');
    expect(callArg).toContain('--resume');
    expect(callArg).toContain('abc12345-0000-0000-0000-000000000000');
  });

  it('on win32 uses provided title in the start command', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, undefined, 'My Session');

    const callArg = vi.mocked(exec).mock.calls[0][0] as string;
    expect(callArg).toContain('"My Session"');
  });

  it('on win32 with invalid cwd, does not include cwd in exec opts', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => { throw new Error('ENOENT'); });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/bad/path');

    const callOpts = vi.mocked(exec).mock.calls[0][1] as any;
    expect(callOpts.cwd).toBeUndefined();
  });

  it('on win32 with valid cwd, passes cwd in exec opts', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined); // valid

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/valid/cwd');

    const callOpts = vi.mocked(exec).mock.calls[0][1] as any;
    expect(callOpts.cwd).toBe('/valid/cwd');
  });

  it('on darwin calls exec with osascript command', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    // darwin exec() is called with only the command string (no opts arg)
    const calls = vi.mocked(exec).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCallCmd = calls[0][0] as string;
    expect(firstCallCmd).toContain('osascript');
    expect(firstCallCmd).toContain('Terminal');
    expect(firstCallCmd).toContain('--resume');
  });

  it('on darwin includes cd part when cwd is valid', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined); // valid cwd

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/my/project');

    const callArg = vi.mocked(exec).mock.calls[0][0] as string;
    expect(callArg).toContain('cd');
    expect(callArg).toContain('my');
    expect(callArg).toContain('project');
  });

  it('on darwin omits cd part when cwd is invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => { throw new Error('ENOENT'); });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/bad/cwd');

    const callArg = vi.mocked(exec).mock.calls[0][0] as string;
    // No cd command should appear since effectiveCwd became undefined
    expect(callArg).not.toContain("cd '");
  });

  it('on linux calls execFileSync(which) then exec when a terminal is found', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // getClaudeCliPath() is called first inside spawnClaudeInNewWindow:
    //   - call 1: execFileSync('claude', ['--version']) → throws (default mock)
    //   - call 2: execFileSync(candidate, ['--version']) → throws (all candidates fail)
    //   - ...all candidate checks throw...
    // Then linux terminal loop starts:
    //   - execFileSync('which', ['x-terminal-emulator']) → succeeds
    vi.mocked(execFileSync).mockImplementation((cmd: any) => {
      // Only succeed on 'which' calls
      if (cmd === 'which') return '';
      throw new Error('not found');
    });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    expect(execFileSync).toHaveBeenCalledWith('which', ['x-terminal-emulator'], { stdio: 'ignore' });
    // exec should be called with a string containing x-terminal-emulator
    const execCalls = vi.mocked(exec).mock.calls;
    expect(execCalls.length).toBeGreaterThan(0);
    const termCmd = execCalls[0][0] as string;
    expect(termCmd).toContain('x-terminal-emulator');
    // spawn should NOT have been called (we found a terminal)
    expect(spawn).not.toHaveBeenCalled();
  });

  it('on linux tries multiple terminals and falls back to spawn when all fail', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // All execFileSync calls fail (both getClaudeCliPath candidates and all which checks)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    // exec should NOT have been called (no terminal found)
    expect(exec).not.toHaveBeenCalled();
    // spawn should be called as the fallback
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'abc12345-0000-0000-0000-000000000000'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('on linux spawn fallback calls .unref()', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
    const unrefMock = vi.fn();
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn(),
      unref: unrefMock,
    } as any);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    expect(unrefMock).toHaveBeenCalled();
  });

  it('on linux spawn fallback includes cwd when valid', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined); // valid cwd

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/work/dir');

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/work/dir' }),
    );
  });

  it('on linux uses second terminal in the list when first which fails', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // getClaudeCliPath() calls all fail (claude + candidates), then:
    //   which x-terminal-emulator → fails, which kitty → succeeds
    let whichCallCount = 0;
    vi.mocked(execFileSync).mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which') {
        whichCallCount++;
        if (whichCallCount === 1) throw new Error('not found'); // x-terminal-emulator
        return ''; // kitty found
      }
      throw new Error('not found'); // all getClaudeCliPath candidates
    });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    expect(execFileSync).toHaveBeenCalledWith('which', ['x-terminal-emulator'], { stdio: 'ignore' });
    expect(execFileSync).toHaveBeenCalledWith('which', ['kitty'], { stdio: 'ignore' });
    const execCalls = vi.mocked(exec).mock.calls;
    expect(execCalls.length).toBeGreaterThan(0);
    expect(execCalls[0][0] as string).toContain('kitty');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses default title (first 8 chars of session id) when no title provided', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    const callArg = vi.mocked(exec).mock.calls[0][0] as string;
    expect(callArg).toContain('"claude abc12345"');
  });
});

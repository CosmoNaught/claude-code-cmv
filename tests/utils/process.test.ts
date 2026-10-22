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
  parseRunningSessionIds,
  detectCurrentTerminal,
  expandTerminalTemplate,
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
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(spawn).mockReturnValue({ on: vi.fn(), unref: vi.fn() } as any);
    // Don't let the terminal running the tests influence detection
    for (const v of ['TERM_PROGRAM', 'GHOSTTY_RESOURCES_DIR', 'KITTY_WINDOW_ID', 'ALACRITTY_WINDOW_ID',
      'ALACRITTY_SOCKET', 'PTYXIS_VERSION', 'KONSOLE_VERSION']) vi.stubEnv(v, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('on darwin defaults to Terminal.app via osascript, cd-ing into the project', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined); // valid cwd

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/my/project');

    const [bin, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('osascript');
    const script = args.join('\n');
    expect(script).toContain('Terminal');
    expect(script).toContain("cd '/my/project' && exec");
    expect(script).toContain("--resume 'abc12345-0000-0000-0000-000000000000'");
  });

  it('on darwin omits cd part when cwd is invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => { throw new Error('ENOENT'); });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/bad/cwd');

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.join('\n')).not.toContain('cd ');
  });

  it('on darwin uses iTerm when configured', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, undefined, 't', 'iterm');

    const [bin, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('osascript');
    expect(args.join('\n')).toContain('iTerm');
  });

  it('on darwin opens Ghostty via `open -na` when configured (#13)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/my/project', 'T', 'ghostty');

    const [bin, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('open');
    expect(args.slice(0, 3)).toEqual(['-na', 'Ghostty', '--args']);
    expect(args).toContain('-e');
    const script = args[args.length - 1]!;
    expect(args.slice(-3, -1)).toEqual(['sh', '-c']);
    expect(script).toContain("cd '/my/project' && exec");
  });

  it('on darwin auto-detects the terminal cmv is running in', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.stubEnv('TERM_PROGRAM', 'WezTerm');

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    const [bin, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('open');
    expect(args[1]).toBe('WezTerm');
  });

  it('runs a custom terminal template with shell-quoted placeholders', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, "/it's here", 'T',
      'open -na Ghostty --args --working-directory={cwd} -e {cmd}');

    const cmd = vi.mocked(exec).mock.calls[0][0] as string;
    expect(cmd).toContain("--working-directory='/it'\\''s here'");
    expect(cmd).toMatch(/-e sh -c '.*exec .*--resume/);
  });

  it('on linux launches the first installed terminal with a cd-ing shell (#4)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined);
    vi.mocked(execFileSync).mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' && args[0] === 'gnome-terminal') return '';
      throw new Error('not found');
    });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/work/my project', 'T');

    expect(execFileSync).toHaveBeenCalledWith('which', ['x-terminal-emulator'], { stdio: 'ignore' });
    const [bin, args, opts] = vi.mocked(spawn).mock.calls[0] as [string, string[], any];
    expect(bin).toBe('gnome-terminal');
    // gnome-terminal ignores the caller's cwd, so the window must cd itself
    expect(args).toEqual(['--title=T', '--', 'sh', '-c',
      "cd '/work/my project' && exec 'claude' --resume 'abc12345-0000-0000-0000-000000000000'"]);
    expect(opts).toEqual(expect.objectContaining({ detached: true, cwd: '/work/my project' }));
  });

  it('on linux prefers the configured terminal', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execFileSync).mockImplementation((cmd: any) => {
      if (cmd === 'which') return '';
      throw new Error('not found');
    });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, undefined, 'T', 'ptyxis');

    const [bin, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('ptyxis');
    expect(args.slice(0, 4)).toEqual(['--new-window', '--', 'sh', '-c']);
  });

  it('every linux preset launches its own binary running the cd-ing shell script', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execFileSync).mockImplementation((cmd: any) => {
      if (cmd === 'which') return '';
      throw new Error('not found');
    });
    const presets = ['x-terminal-emulator', 'kitty', 'ptyxis', 'gnome-terminal', 'alacritty', 'wezterm',
      'foot', 'ghostty', 'konsole', 'xfce4-terminal', 'xterm'];

    for (const name of presets) {
      vi.mocked(spawn).mockClear();
      vi.mocked(accessSync).mockImplementationOnce(() => undefined);
      spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/proj', 'T', name);
      const [bin, args] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
      expect(bin).toBe(name);
      expect(args.slice(-3)).toEqual(['sh', '-c',
        "cd '/proj' && exec 'claude' --resume 'abc12345-0000-0000-0000-000000000000'"]);
    }
  });

  it('on linux falls back to a detached claude when no terminal is installed', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined);
    const unrefMock = vi.fn();
    vi.mocked(spawn).mockReturnValue({ on: vi.fn(), unref: unrefMock } as any);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, '/work/dir');

    expect(exec).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      ['--resume', 'abc12345-0000-0000-0000-000000000000'],
      expect.objectContaining({ detached: true, stdio: 'ignore', cwd: '/work/dir' }),
    );
    expect(unrefMock).toHaveBeenCalled();
  });

  it('on win32 runs a custom terminal template', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, 'C:\\proj', 'T',
      'wt -d {cwd} --title {title} {cmd} # {session} {claude}');

    const [cmd, opts] = vi.mocked(exec).mock.calls[0] as [string, any];
    expect(cmd).toBe('wt -d "C:\\proj" --title "T" "claude" --resume abc12345-0000-0000-0000-000000000000 # abc12345-0000-0000-0000-000000000000 "claude"');
    expect(opts.cwd).toBe('C:\\proj');
  });

  it('swallows async spawn errors from a vanished terminal', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const handlers: Record<string, Function> = {};
    vi.mocked(spawn).mockReturnValue({ on: vi.fn((e: string, cb: Function) => { handlers[e] = cb; }), unref: vi.fn() } as any);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    expect(() => handlers.error!(new Error('ENOENT'))).not.toThrow();
  });

  it('on win32 sets the new window directory with start /D', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(accessSync).mockImplementationOnce(() => undefined);

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000', undefined, 'C:\\proj');

    expect(vi.mocked(exec).mock.calls[0][0] as string).toContain('/D "C:\\proj"');
  });

  it('uses default title (first 8 chars of session id) when no title provided', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    spawnClaudeInNewWindow('abc12345-0000-0000-0000-000000000000');

    const callArg = vi.mocked(exec).mock.calls[0][0] as string;
    expect(callArg).toContain('"claude abc12345"');
  });
});

describe('parseRunningSessionIds', () => {
  const id = 'abc12345-0000-0000-0000-000000000000';

  it('counts claude processes in every form they appear', () => {
    expect(parseRunningSessionIds(`claude --resume ${id}`).has(id)).toBe(true);
    expect(parseRunningSessionIds(`/home/u/.local/bin/claude --resume ${id}`).has(id)).toBe(true);
    expect(parseRunningSessionIds(`node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume ${id}`).has(id)).toBe(true);
    expect(parseRunningSessionIds(`"C:\\Users\\u\\.local\\bin\\claude.exe" --resume ${id}  `).has(id)).toBe(true);
  });

  it('ignores terminals and shells that merely mention the session (#13 busy softlock)', () => {
    const listing = [
      `/Applications/Ghostty.app/Contents/MacOS/ghostty --title=x -e sh -c cd '/p' && exec 'claude' --resume '${id}'`,
      `kitty -T t sh -c exec 'claude' --resume '${id}'`,
      `cmd /k "claude" --resume ${id}`,
    ].join('\n');
    expect(parseRunningSessionIds(listing).size).toBe(0);
  });
});

describe('detectCurrentTerminal', () => {
  it('maps terminal environment markers to presets', () => {
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'ghostty' })).toBe('ghostty');
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm');
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('terminal');
    expect(detectCurrentTerminal({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectCurrentTerminal({ PTYXIS_VERSION: '47' })).toBe('ptyxis');
    expect(detectCurrentTerminal({ TERM_PROGRAM: 'vscode' })).toBeUndefined();
  });
});

describe('expandTerminalTemplate', () => {
  it('substitutes every placeholder', () => {
    const out = expandTerminalTemplate('x {title} {cwd} {session} {claude} {cmd}', {
      script: 'exec claude', cwd: '/p', title: 'T', sessionId: 'S', claude: '/bin/claude',
    });
    expect(out).toBe("x 'T' '/p' 'S' '/bin/claude' sh -c 'exec claude'");
  });
});

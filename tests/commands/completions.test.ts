import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';
import * as os from 'node:os';
import * as path from 'node:path';

vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const mockReadFile = vi.fn().mockRejectedValue(new Error('not found'));
const mockAppendFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  appendFile: (...args: any[]) => mockAppendFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
}));

import { registerCompletionsCommand } from '../../src/commands/completions.js';

describe('completions command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: profile/rc file does not exist
    mockReadFile.mockRejectedValue(new Error('not found'));
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  // ── output mode ────────────────────────────────────────────────────────────

  it('outputs powershell completions', async () => {
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'powershell']);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Register-ArgumentCompleter'),
    );
  });

  it('outputs bash completions', async () => {
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'bash']);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('_cmv_completions'),
    );
  });

  it('errors and exits for unsupported shell in output mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'zsh']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported shell'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  // ── --install powershell ───────────────────────────────────────────────────

  it('--install powershell appends to profile when not already installed', async () => {
    mockReadFile.mockRejectedValue(new Error('not found'));
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'powershell', '--install']);
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockAppendFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Register-ArgumentCompleter'),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Completions installed to'),
    );
  });

  it('--install powershell skips when already installed', async () => {
    mockReadFile.mockResolvedValue('# existing profile\n# CMV PowerShell Tab Completion\nsome content');
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'powershell', '--install']);
    expect(mockAppendFile).not.toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('already installed'),
    );
  });

  it('--install pwsh alias works like powershell', async () => {
    mockReadFile.mockRejectedValue(new Error('not found'));
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'pwsh', '--install']);
    expect(mockAppendFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Register-ArgumentCompleter'),
    );
  });

  // ── --install bash ─────────────────────────────────────────────────────────

  it('--install bash appends to .bashrc when not already installed', async () => {
    mockReadFile.mockRejectedValue(new Error('not found'));
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'bash', '--install']);
    const expectedBashrc = path.join(os.homedir(), '.bashrc');
    expect(mockAppendFile).toHaveBeenCalledWith(
      expectedBashrc,
      expect.stringContaining('_cmv_completions'),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Completions installed to'),
    );
  });

  it('--install bash skips when already installed', async () => {
    mockReadFile.mockResolvedValue('# existing bashrc\n# CMV Bash Tab Completion\nsome content');
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'bash', '--install']);
    expect(mockAppendFile).not.toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('already installed'),
    );
  });

  // ── --install unsupported shell ────────────────────────────────────────────

  it('--install errors and exits for unsupported shell', async () => {
    const program = new Command();
    program.exitOverride();
    registerCompletionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'completions', 'fish', '--install']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported shell'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });
});

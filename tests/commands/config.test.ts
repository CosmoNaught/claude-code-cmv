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

const mockReadConfig = vi.fn();
const mockWriteConfig = vi.fn().mockResolvedValue(undefined);
const mockInitialize = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/core/metadata-store.js', () => ({
  readConfig: (...args: any[]) => mockReadConfig(...args),
  writeConfig: (...args: any[]) => mockWriteConfig(...args),
  initialize: (...args: any[]) => mockInitialize(...args),
}));

import { registerConfigCommand } from '../../src/commands/config.js';
import { info, success } from '../../src/utils/display.js';

describe('config command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows all config when no args', async () => {
    mockReadConfig.mockResolvedValue({ claude_cli_path: '/usr/bin/claude' });
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config']);
    expect(info).toHaveBeenCalledWith('CMV Configuration:');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('claude_cli_path'));
  });

  it('gets single value', async () => {
    mockReadConfig.mockResolvedValue({ claude_cli_path: '/usr/bin/claude' });
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config', 'claude_cli_path']);
    expect(console.log).toHaveBeenCalledWith('/usr/bin/claude');
  });

  it('sets value', async () => {
    mockReadConfig.mockResolvedValue({});
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config', 'claude_cli_path', '/new/path']);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ claude_cli_path: '/new/path' }),
    );
    expect(success).toHaveBeenCalledWith(expect.stringContaining('claude_cli_path'));
  });

  it('shows error for invalid config key', async () => {
    mockReadConfig.mockResolvedValue({});
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config', 'invalid_key']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown config key'));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('shows (not set) for undefined config value', async () => {
    mockReadConfig.mockResolvedValue({});
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config', 'claude_cli_path']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('not set'));
  });

  it('handles error from readConfig', async () => {
    const { handleError } = await import('../../src/utils/errors.js');
    mockReadConfig.mockRejectedValueOnce(new Error('read fail'));
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config']);
    expect(handleError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('shows empty config message when no config set', async () => {
    mockReadConfig.mockResolvedValue({});
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'cmv', 'config']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('no configuration set'));
  });
});

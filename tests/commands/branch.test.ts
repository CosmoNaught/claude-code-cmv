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

const mockCreateBranch = vi.fn().mockResolvedValue({
  branchName: 'branch-1',
  forkedSessionId: 'fork-123',
  command: 'claude --session fork-123',
  projectDir: '/proj',
});

vi.mock('../../src/core/branch-manager.js', () => ({
  createBranch: (...args: any[]) => mockCreateBranch(...args),
}));

import { registerBranchCommand } from '../../src/commands/branch.js';

describe('branch command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createBranch with snapshot name', async () => {
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotName: 'my-snap' }),
    );
  });

  it('passes --name option', async () => {
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--name', 'custom']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotName: 'my-snap', branchName: 'custom' }),
    );
  });

  it('passes --dry-run flag', async () => {
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--dry-run']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('passes --skip-launch flag', async () => {
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--skip-launch']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ noLaunch: true }),
    );
  });

  it('handles error from createBranch', async () => {
    const { handleError } = await import('../../src/utils/errors.js');
    mockCreateBranch.mockRejectedValueOnce(new Error('branch fail'));
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap']);
    expect(handleError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('prints trim metrics with optional fields when present', async () => {
    mockCreateBranch.mockResolvedValueOnce({
      branchName: 'branch-1',
      forkedSessionId: 'fork-123',
      command: 'claude --session fork-123',
      projectDir: '/proj',
      trimMetrics: {
        originalBytes: 2 * 1024 * 1024,
        trimmedBytes: 500 * 1024,
        toolResultsStubbed: 3,
        signaturesStripped: 1,
        fileHistoryRemoved: 2,
        imagesStripped: 5,
        toolUseInputsStubbed: 4,
        preCompactionLinesSkipped: 10,
        queueOperationsRemoved: 7,
        userMessages: 8,
        assistantResponses: 8,
        toolUseRequests: 3,
      },
    });
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--skip-launch']);
    // Trim metrics should be printed including optional image/tool/pre-compaction/queue lines
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('images'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('tool inputs'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('pre-compaction'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('queue-ops'));
  });

  it('prints dry-run output without projectDir', async () => {
    mockCreateBranch.mockResolvedValueOnce({
      branchName: 'branch-1',
      forkedSessionId: 'fork-123',
      command: 'claude --session fork-123',
      projectDir: undefined,
    });
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--dry-run']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Branch name'));
  });

  it('prints skip-launch output without projectDir', async () => {
    mockCreateBranch.mockResolvedValueOnce({
      branchName: 'branch-1',
      forkedSessionId: 'fork-123',
      command: 'claude --session fork-123',
      projectDir: undefined,
    });
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--skip-launch']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Launch with'));
  });

  it('passes --threshold option as trimThreshold', async () => {
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--threshold', '1000']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ trimThreshold: 1000 }),
    );
  });

  it('passes --no-trim flag', async () => {
    const program = new Command();
    program.exitOverride();
    registerBranchCommand(program);
    await program.parseAsync(['node', 'cmv', 'branch', 'my-snap', '--no-trim']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ trim: false }),
    );
  });
});

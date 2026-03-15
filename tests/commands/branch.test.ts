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
});

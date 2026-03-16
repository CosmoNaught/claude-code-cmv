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

const mockCreateSnapshot = vi.fn().mockResolvedValue({
  snapshot: { id: 'snap-123', name: 'test' },
  warnings: [],
});

const mockCreateBranch = vi.fn().mockResolvedValue({
  branchName: 'branch-1',
  forkedSessionId: 'fork-123',
  command: 'claude --session fork-123',
  trimMetrics: {
    originalBytes: 10000,
    trimmedBytes: 3000,
    toolResultsStubbed: 5,
    signaturesStripped: 2,
    fileHistoryRemoved: 1,
    imagesStripped: 0,
    toolUseInputsStubbed: 0,
    preCompactionLinesSkipped: 0,
    queueOperationsRemoved: 0,
    userMessages: 10,
    assistantResponses: 10,
    toolUseRequests: 5,
  },
});

vi.mock('../../src/core/snapshot-manager.js', () => ({
  createSnapshot: (...args: any[]) => mockCreateSnapshot(...args),
}));

vi.mock('../../src/core/branch-manager.js', () => ({
  createBranch: (...args: any[]) => mockCreateBranch(...args),
}));

import { registerTrimCommand } from '../../src/commands/trim.js';
import { success } from '../../src/utils/display.js';

describe('trim command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates snapshot then branch with --latest', async () => {
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--latest']);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ latest: true, tags: ['trimmed'] }),
    );
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ trim: true }),
    );
    expect(success).toHaveBeenCalled();
  });

  it('passes --skip-launch', async () => {
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--latest', '--skip-launch']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ noLaunch: true }),
    );
  });

  it('errors when neither --session nor --latest provided', async () => {
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim']);
    expect(console.error).toHaveBeenCalledWith('Must provide --session <id> or --latest');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('prints optional trim metric lines when values are nonzero', async () => {
    mockCreateBranch.mockResolvedValueOnce({
      branchName: 'branch-1',
      forkedSessionId: 'fork-123',
      command: 'claude --session fork-123',
      trimMetrics: {
        originalBytes: 10000,
        trimmedBytes: 3000,
        toolResultsStubbed: 5,
        signaturesStripped: 2,
        fileHistoryRemoved: 1,
        imagesStripped: 3,
        toolUseInputsStubbed: 2,
        preCompactionLinesSkipped: 4,
        queueOperationsRemoved: 1,
        userMessages: 10,
        assistantResponses: 10,
        toolUseRequests: 5,
      },
    });
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--latest']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Image blocks'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Tool use inputs'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Pre-compaction'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Queue operations'));
  });

  it('handles error from createSnapshot or createBranch', async () => {
    const { handleError } = await import('../../src/utils/errors.js');
    mockCreateSnapshot.mockRejectedValueOnce(new Error('snap fail'));
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--latest']);
    expect(handleError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('passes --session option', async () => {
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--session', 'sess-abc']);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-abc' }),
    );
  });

  it('passes --threshold option', async () => {
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--latest', '--threshold', '800']);
    expect(mockCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ trimThreshold: 800 }),
    );
  });

  it('uses custom --name for snapshot', async () => {
    const program = new Command();
    program.exitOverride();
    registerTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'trim', '--latest', '--name', 'my-trim']);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-trim' }),
    );
  });
});

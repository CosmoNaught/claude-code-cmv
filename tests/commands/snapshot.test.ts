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
  snapshot: { id: 'snap-123', name: 'test', message_count: 10, source_project_path: '/proj' },
  warnings: [],
});

vi.mock('../../src/core/snapshot-manager.js', () => ({
  createSnapshot: (...args: any[]) => mockCreateSnapshot(...args),
}));

import { registerSnapshotCommand } from '../../src/commands/snapshot.js';
import { error } from '../../src/utils/display.js';

describe('snapshot command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createSnapshot with --latest flag', async () => {
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap', '--latest']);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-snap', latest: true }),
    );
  });

  it('calls createSnapshot with --session id', async () => {
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap', '--session', 'sess-abc']);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-snap', sessionId: 'sess-abc' }),
    );
  });

  it('shows error when neither --session nor --latest provided', async () => {
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap']);
    expect(error).toHaveBeenCalledWith('Must provide --session <id> or --latest');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles error from createSnapshot', async () => {
    const { handleError } = await import('../../src/utils/errors.js');
    mockCreateSnapshot.mockRejectedValueOnce(new Error('snap fail'));
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap', '--latest']);
    expect(handleError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('prints warnings from snapshot result', async () => {
    const { warn } = await import('../../src/utils/display.js');
    mockCreateSnapshot.mockResolvedValueOnce({
      snapshot: { id: 'snap-123', name: 'test', message_count: 10, source_project_path: '/proj' },
      warnings: ['Warning: large session'],
    });
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap', '--latest']);
    expect(warn).toHaveBeenCalledWith('Warning: large session');
  });

  it('does not print message count when absent', async () => {
    mockCreateSnapshot.mockResolvedValueOnce({
      snapshot: { id: 'snap-123', name: 'test', message_count: null, source_project_path: null },
      warnings: [],
    });
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap', '--latest']);
    const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
    const msgCall = calls.find((c: string) => typeof c === 'string' && c.includes('Messages:'));
    expect(msgCall).toBeUndefined();
  });

  it('passes tags and description options', async () => {
    const program = new Command();
    program.exitOverride();
    registerSnapshotCommand(program);
    await program.parseAsync(['node', 'cmv', 'snapshot', 'my-snap', '--latest', '--tags', 'a, b', '--description', 'test desc']);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['a', 'b'],
        description: 'test desc',
      }),
    );
  });
});

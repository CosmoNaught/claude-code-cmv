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
});

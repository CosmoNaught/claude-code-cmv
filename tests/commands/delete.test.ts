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

const mockDeleteSnapshot = vi.fn().mockResolvedValue(undefined);
const mockGetSnapshot = vi.fn();

vi.mock('../../src/core/snapshot-manager.js', () => ({
  deleteSnapshot: (...args: any[]) => mockDeleteSnapshot(...args),
}));

vi.mock('../../src/core/metadata-store.js', () => ({
  getSnapshot: (...args: any[]) => mockGetSnapshot(...args),
}));

// The readline mock uses a shared object so tests can swap `question`'s resolved value
const rlInstance = {
  question: vi.fn().mockResolvedValue('y'),
  close: vi.fn(),
};

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => rlInstance),
}));

import { registerDeleteCommand } from '../../src/commands/delete.js';
import { success, warn, error } from '../../src/utils/display.js';

describe('delete command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteSnapshot.mockResolvedValue(undefined);
    rlInstance.question.mockResolvedValue('y');
  });

  // ── --force ────────────────────────────────────────────────────────────────

  it('deletes with --force skipping confirmation', async () => {
    mockGetSnapshot.mockResolvedValue({ name: 'snap1', branches: [], tags: [] });
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'snap1', '--force']);
    expect(mockDeleteSnapshot).toHaveBeenCalledWith('snap1');
    expect(success).toHaveBeenCalledWith(expect.stringContaining('deleted'));
    expect(rlInstance.question).not.toHaveBeenCalled();
  });

  // ── missing snapshot ───────────────────────────────────────────────────────

  it('shows error and exits for missing snapshot', async () => {
    mockGetSnapshot.mockResolvedValue(null);
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'nonexistent', '--force']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(mockDeleteSnapshot).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  // ── confirmation prompt ────────────────────────────────────────────────────

  it('deletes after answering y to confirmation prompt', async () => {
    mockGetSnapshot.mockResolvedValue({ name: 'snap2', branches: [], tags: [] });
    rlInstance.question.mockResolvedValue('y');
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'snap2']);
    expect(rlInstance.question).toHaveBeenCalledWith(expect.stringContaining('snap2'));
    expect(rlInstance.close).toHaveBeenCalled();
    expect(mockDeleteSnapshot).toHaveBeenCalledWith('snap2');
    expect(success).toHaveBeenCalledWith(expect.stringContaining('deleted'));
  });

  it('cancels when confirmation prompt is answered with n', async () => {
    mockGetSnapshot.mockResolvedValue({ name: 'snap3', branches: [], tags: [] });
    rlInstance.question.mockResolvedValue('n');
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'snap3']);
    expect(rlInstance.question).toHaveBeenCalled();
    expect(rlInstance.close).toHaveBeenCalled();
    expect(mockDeleteSnapshot).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Cancelled.');
  });

  it('cancels when confirmation prompt is answered with empty string (default N)', async () => {
    mockGetSnapshot.mockResolvedValue({ name: 'snap4', branches: [], tags: [] });
    rlInstance.question.mockResolvedValue('');
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'snap4']);
    expect(mockDeleteSnapshot).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Cancelled.');
  });

  // ── branches warning ───────────────────────────────────────────────────────

  it('warns when snapshot has branches before deleting', async () => {
    mockGetSnapshot.mockResolvedValue({
      name: 'snap5',
      branches: ['branch-a', 'branch-b'],
      tags: [],
    });
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'snap5', '--force']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 branch'));
    expect(mockDeleteSnapshot).toHaveBeenCalledWith('snap5');
    expect(success).toHaveBeenCalledWith(expect.stringContaining('deleted'));
  });

  it('does not warn when snapshot has no branches', async () => {
    mockGetSnapshot.mockResolvedValue({ name: 'snap6', branches: [], tags: [] });
    const program = new Command();
    program.exitOverride();
    registerDeleteCommand(program);
    await program.parseAsync(['node', 'cmv', 'delete', 'snap6', '--force']);
    expect(warn).not.toHaveBeenCalled();
  });
});

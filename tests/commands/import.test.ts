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

const mockImportSnapshot = vi.fn().mockResolvedValue({
  name: 'imported-snap', snapshotId: 'snap-456', warnings: [],
});

vi.mock('../../src/core/importer.js', () => ({
  importSnapshot: (...args: any[]) => mockImportSnapshot(...args),
}));

import { registerImportCommand } from '../../src/commands/import.js';
import { success } from '../../src/utils/display.js';

describe('import command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports snapshot', async () => {
    const program = new Command();
    program.exitOverride();
    registerImportCommand(program);
    await program.parseAsync(['node', 'cmv', 'import', '/path/to/file.cmv']);
    expect(mockImportSnapshot).toHaveBeenCalledWith('/path/to/file.cmv', {
      rename: undefined,
      force: undefined,
    });
    expect(success).toHaveBeenCalledWith(expect.stringContaining('Imported'));
  });

  it('passes --rename and --force', async () => {
    const program = new Command();
    program.exitOverride();
    registerImportCommand(program);
    await program.parseAsync(['node', 'cmv', 'import', '/path/to/file.cmv', '--rename', 'new-name', '--force']);
    expect(mockImportSnapshot).toHaveBeenCalledWith('/path/to/file.cmv', {
      rename: 'new-name',
      force: true,
    });
  });
});

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

const mockExportSnapshot = vi.fn().mockResolvedValue('/out/snap.cmv');

vi.mock('../../src/core/exporter.js', () => ({
  exportSnapshot: (...args: any[]) => mockExportSnapshot(...args),
}));

import { registerExportCommand } from '../../src/commands/export.js';
import { success } from '../../src/utils/display.js';

describe('export command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports snapshot', async () => {
    const program = new Command();
    program.exitOverride();
    registerExportCommand(program);
    await program.parseAsync(['node', 'cmv', 'export', 'my-snap']);
    expect(mockExportSnapshot).toHaveBeenCalledWith('my-snap', undefined);
    expect(success).toHaveBeenCalledWith(expect.stringContaining('Exported'));
  });

  it('passes --output option', async () => {
    const program = new Command();
    program.exitOverride();
    registerExportCommand(program);
    await program.parseAsync(['node', 'cmv', 'export', 'my-snap', '--output', '/tmp/out.cmv']);
    expect(mockExportSnapshot).toHaveBeenCalledWith('my-snap', '/tmp/out.cmv');
  });
});

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

const mockBuildTree = vi.fn();
const mockRenderTree = vi.fn().mockReturnValue('rendered-tree');
const mockTreeToJson = vi.fn().mockReturnValue([{ name: 'snap1' }]);

vi.mock('../../src/core/tree-builder.js', () => ({
  buildTree: (...args: any[]) => mockBuildTree(...args),
  renderTree: (...args: any[]) => mockRenderTree(...args),
  treeToJson: (...args: any[]) => mockTreeToJson(...args),
}));

import { registerTreeCommand } from '../../src/commands/tree.js';
import { info } from '../../src/utils/display.js';

describe('tree command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders tree', async () => {
    mockBuildTree.mockResolvedValue([{ name: 'snap1' }]);
    const program = new Command();
    program.exitOverride();
    registerTreeCommand(program);
    await program.parseAsync(['node', 'cmv', 'tree']);
    expect(mockRenderTree).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('rendered-tree');
  });

  it('shows info when no snapshots', async () => {
    mockBuildTree.mockResolvedValue([]);
    const program = new Command();
    program.exitOverride();
    registerTreeCommand(program);
    await program.parseAsync(['node', 'cmv', 'tree']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('No snapshots yet'));
  });

  it('outputs JSON with --json', async () => {
    mockBuildTree.mockResolvedValue([{ name: 'snap1' }]);
    const program = new Command();
    program.exitOverride();
    registerTreeCommand(program);
    await program.parseAsync(['node', 'cmv', 'tree', '--json']);
    expect(mockTreeToJson).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"snap1"'));
  });
});

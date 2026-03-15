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

vi.mock('chalk', () => {
  const p = (s: string) => s;
  const obj: any = Object.assign(p, {
    green: p, yellow: p, red: p, blue: p, dim: p, cyan: p,
    bold: Object.assign(p, { cyan: p }),
    magenta: p,
  });
  return { default: obj };
});

const mockReadIndex = vi.fn();

vi.mock('../../src/core/metadata-store.js', () => ({
  readIndex: (...args: any[]) => mockReadIndex(...args),
}));

import { registerListCommand } from '../../src/commands/list.js';
import { info } from '../../src/utils/display.js';

describe('list command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows message when no snapshots', async () => {
    mockReadIndex.mockResolvedValue({ snapshots: {} });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('No snapshots yet'));
  });

  it('lists snapshots as table', async () => {
    mockReadIndex.mockResolvedValue({
      snapshots: {
        snap1: {
          name: 'snap1', created_at: '2025-01-01', message_count: 5,
          branches: [], tags: [], description: 'test',
        },
      },
    });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list']);
    expect(console.log).toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('outputs JSON with --json flag', async () => {
    mockReadIndex.mockResolvedValue({
      snapshots: {
        snap1: {
          name: 'snap1', created_at: '2025-01-01', message_count: 5,
          branches: [], tags: [], description: 'test',
        },
      },
    });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list', '--json']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"snap1"'));
  });

  it('filters by tag', async () => {
    mockReadIndex.mockResolvedValue({
      snapshots: {
        snap1: {
          name: 'snap1', created_at: '2025-01-01', message_count: 5,
          branches: [], tags: ['important'], description: '',
        },
        snap2: {
          name: 'snap2', created_at: '2025-01-02', message_count: 3,
          branches: [], tags: ['other'], description: '',
        },
      },
    });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list', '--json', '--tag', 'important']);
    const jsonCall = (console.log as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('"snap1"'),
    );
    expect(jsonCall).toBeDefined();
    expect(jsonCall[0]).not.toContain('"snap2"');
  });
});

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

  it('sorts by name with --sort name', async () => {
    mockReadIndex.mockResolvedValue({
      snapshots: {
        b: { name: 'b-snap', created_at: '2025-01-01', message_count: 1, branches: [], tags: [], description: '' },
        a: { name: 'a-snap', created_at: '2025-01-02', message_count: 2, branches: [], tags: [], description: '' },
      },
    });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list', '--json', '--sort', 'name']);
    const jsonCall = (console.log as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('a-snap'),
    );
    expect(jsonCall).toBeDefined();
    // a-snap should come before b-snap in JSON output
    const aIdx = jsonCall[0].indexOf('a-snap');
    const bIdx = jsonCall[0].indexOf('b-snap');
    expect(aIdx).toBeLessThan(bIdx);
  });

  it('sorts by branches with --sort branches', async () => {
    mockReadIndex.mockResolvedValue({
      snapshots: {
        few: { name: 'few', created_at: '2025-01-01', message_count: 1, branches: [], tags: [], description: '' },
        many: { name: 'many', created_at: '2025-01-02', message_count: 2, branches: [{ name: 'b1', created_at: '2025-01-01', forked_session_id: 'f1' }, { name: 'b2', created_at: '2025-01-01', forked_session_id: 'f2' }], tags: [], description: '' },
      },
    });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list', '--json', '--sort', 'branches']);
    const jsonCall = (console.log as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('many'),
    );
    expect(jsonCall).toBeDefined();
    // 'many' (2 branches) should come before 'few' (0 branches)
    const manyIdx = jsonCall[0].indexOf('many');
    const fewIdx = jsonCall[0].indexOf('few');
    expect(manyIdx).toBeLessThan(fewIdx);
  });

  it('handles error from readIndex', async () => {
    const { handleError } = await import('../../src/utils/errors.js');
    mockReadIndex.mockRejectedValueOnce(new Error('read fail'));
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list']);
    expect(handleError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('sorts by date by default', async () => {
    mockReadIndex.mockResolvedValue({
      snapshots: {
        old: { name: 'old', created_at: '2025-01-01', message_count: 1, branches: [], tags: [], description: '' },
        recent: { name: 'recent', created_at: '2025-06-01', message_count: 2, branches: [], tags: [], description: '' },
      },
    });
    const program = new Command();
    program.exitOverride();
    registerListCommand(program);
    await program.parseAsync(['node', 'cmv', 'list', '--json']);
    const jsonCall = (console.log as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('recent'),
    );
    expect(jsonCall).toBeDefined();
    // 'recent' should come before 'old' (newest first)
    const recentIdx = jsonCall[0].indexOf('recent');
    const oldIdx = jsonCall[0].indexOf('"old"');
    expect(recentIdx).toBeLessThan(oldIdx);
  });
});

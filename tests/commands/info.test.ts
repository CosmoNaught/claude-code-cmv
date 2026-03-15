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

const mockGetSnapshot = vi.fn();
const mockReadIndex = vi.fn();
const mockGetSnapshotSize = vi.fn();

vi.mock('../../src/core/metadata-store.js', () => ({
  getSnapshot: (...args: any[]) => mockGetSnapshot(...args),
  readIndex: (...args: any[]) => mockReadIndex(...args),
  getSnapshotSize: (...args: any[]) => mockGetSnapshotSize(...args),
}));

import { registerInfoCommand } from '../../src/commands/info.js';
import { error } from '../../src/utils/display.js';

describe('info command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows snapshot info', async () => {
    mockGetSnapshot.mockResolvedValue({
      id: 'snap-123', name: 'my-snap', created_at: '2025-01-01',
      source_session_id: 'sess-1', source_project_path: '/proj',
      message_count: 10, description: 'desc', tags: ['tag1'],
      parent_snapshot: null, branches: [],
    });
    mockReadIndex.mockResolvedValue({ snapshots: {} });
    mockGetSnapshotSize.mockResolvedValue(1024);
    const program = new Command();
    program.exitOverride();
    registerInfoCommand(program);
    await program.parseAsync(['node', 'cmv', 'info', 'my-snap']);
    expect(mockGetSnapshot).toHaveBeenCalledWith('my-snap');
    expect(console.log).toHaveBeenCalled();
  });

  it('shows error for missing snapshot', async () => {
    mockGetSnapshot.mockResolvedValue(null);
    const program = new Command();
    program.exitOverride();
    registerInfoCommand(program);
    await program.parseAsync(['node', 'cmv', 'info', 'nonexistent']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });
});

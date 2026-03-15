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

const mockListAllSessions = vi.fn();
const mockListSessionsByProject = vi.fn();
const mockReadIndex = vi.fn().mockResolvedValue({ snapshots: {} });

vi.mock('../../src/core/session-reader.js', () => ({
  listAllSessions: (...args: any[]) => mockListAllSessions(...args),
  listSessionsByProject: (...args: any[]) => mockListSessionsByProject(...args),
}));

vi.mock('../../src/core/metadata-store.js', () => ({
  readIndex: (...args: any[]) => mockReadIndex(...args),
}));

import { registerSessionsCommand } from '../../src/commands/sessions.js';
import { info } from '../../src/utils/display.js';

describe('sessions command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadIndex.mockResolvedValue({ snapshots: {} });
  });

  it('lists sessions', async () => {
    mockListAllSessions.mockResolvedValue([
      {
        sessionId: 'sess-abc-123', projectPath: '/proj', messageCount: 5,
        modified: '2025-01-01', summary: 'test session', _projectDir: '/proj',
      },
    ]);
    const program = new Command();
    program.exitOverride();
    registerSessionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'sessions']);
    expect(mockListAllSessions).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it('shows info when no sessions', async () => {
    mockListAllSessions.mockResolvedValue([]);
    const program = new Command();
    program.exitOverride();
    registerSessionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'sessions']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('No sessions found'));
  });

  it('outputs JSON with --json', async () => {
    mockListAllSessions.mockResolvedValue([
      {
        sessionId: 'sess-abc-123', projectPath: '/proj', messageCount: 5,
        modified: '2025-01-01', summary: 'test', _projectDir: '/proj',
      },
    ]);
    const program = new Command();
    program.exitOverride();
    registerSessionsCommand(program);
    await program.parseAsync(['node', 'cmv', 'sessions', '--json']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"sess-abc-123"'));
  });
});

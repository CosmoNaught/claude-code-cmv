import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('../../src/utils/errors.js', () => ({
  handleError: vi.fn(),
  CmvError: class extends Error { constructor(public userMessage: string) { super(userMessage); } },
}));

const mockLaunchDashboard = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/tui/index.js', () => ({
  launchDashboard: (...args: any[]) => mockLaunchDashboard(...args),
}));

import { registerDashboardCommand } from '../../src/commands/dashboard.js';

describe('dashboard command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls launchDashboard', async () => {
    const program = new Command();
    program.exitOverride();
    registerDashboardCommand(program);
    await program.parseAsync(['node', 'cmv', 'dashboard']);
    expect(mockLaunchDashboard).toHaveBeenCalled();
  });

  it('handles error from launchDashboard', async () => {
    const { handleError } = await import('../../src/utils/errors.js');
    mockLaunchDashboard.mockRejectedValueOnce(new Error('tui fail'));
    const program = new Command();
    program.exitOverride();
    registerDashboardCommand(program);
    await program.parseAsync(['node', 'cmv', 'dashboard']);
    expect(handleError).toHaveBeenCalledWith(expect.any(Error));
  });
});

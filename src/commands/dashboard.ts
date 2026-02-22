import { Command } from 'commander';
import { handleError } from '../utils/errors.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Interactive TUI dashboard')
    .action(async () => {
      try {
        // Dynamic import to avoid loading React/Ink for non-TUI commands
        const { launchDashboard } = await import('../tui/index.js');
        await launchDashboard();
      } catch (err) {
        handleError(err);
      }
    });
}

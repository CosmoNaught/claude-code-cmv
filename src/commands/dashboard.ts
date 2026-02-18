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
        const result = await launchDashboard();

        if (result.action === 'branch-launch' && result.snapshotName) {
          const { createBranch } = await import('../core/branch-manager.js');
          await createBranch({
            snapshotName: result.snapshotName,
            branchName: result.branchName,
            noLaunch: false,
          });
        } else if (result.action === 'resume' && result.sessionId) {
          const { spawnClaudeInteractive } = await import('../utils/process.js');
          await spawnClaudeInteractive(['--resume', result.sessionId], undefined, result.cwd);
        }
      } catch (err) {
        handleError(err);
      }
    });
}

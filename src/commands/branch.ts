import { Command } from 'commander';
import { createBranch } from '../core/branch-manager.js';
import { success, info, dim } from '../utils/display.js';
import { handleError } from '../utils/errors.js';

export function registerBranchCommand(program: Command): void {
  program
    .command('branch <snapshot>')
    .description('Create a new session from a snapshot')
    .option('-n, --name <name>', 'Name for the branch')
    .option('--skip-launch', "Don't launch Claude Code, just create the session file")
    .option('--dry-run', 'Show what would happen without doing it')
    .action(async (snapshotName: string, opts: { name?: string; skipLaunch?: boolean; dryRun?: boolean }) => {
      try {
        const result = await createBranch({
          snapshotName,
          branchName: opts.name,
          noLaunch: opts.skipLaunch,
          dryRun: opts.dryRun,
        });

        if (opts.dryRun) {
          info('Dry run — no changes made.');
          console.log(`  Branch name: ${result.branchName}`);
          console.log(`  New session ID: ${result.forkedSessionId}`);
          console.log(`  Command: ${result.command}`);
          if (result.projectDir) {
            console.log(`  Project dir: ${dim(result.projectDir)}`);
          }
          return;
        }

        if (opts.skipLaunch) {
          success(`Branch "${result.branchName}" created.`);
          console.log(`  Session ID: ${result.forkedSessionId}`);
          console.log(`  Launch with: ${result.command}`);
          if (result.projectDir) {
            console.log(`  Project dir: ${dim(result.projectDir)}`);
          }
          return;
        }

        success(`Branch "${result.branchName}" created and session launched.`);
        console.log(`  Session ID: ${result.forkedSessionId}`);
      } catch (err) {
        handleError(err);
      }
    });
}

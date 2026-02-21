#!/usr/bin/env node

import { Command } from 'commander';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerBranchCommand } from './commands/branch.js';
import { registerSessionsCommand } from './commands/sessions.js';
import { registerListCommand } from './commands/list.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerTreeCommand } from './commands/tree.js';
import { registerInfoCommand } from './commands/info.js';
import { registerConfigCommand } from './commands/config.js';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';
import { registerCompletionsCommand } from './commands/completions.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerTrimCommand } from './commands/trim.js';
import { registerBenchmarkCommand } from './commands/benchmark.js';

const program = new Command();

program
  .name('cmv')
  .description('Contextual Memory Virtualisation — git-like snapshots and branching for Claude Code sessions')
  .version('1.1.0');

// Register all commands
registerSnapshotCommand(program);
registerBranchCommand(program);
registerSessionsCommand(program);
registerListCommand(program);
registerDeleteCommand(program);
registerTreeCommand(program);
registerInfoCommand(program);
registerConfigCommand(program);
registerExportCommand(program);
registerImportCommand(program);
registerCompletionsCommand(program);
registerTrimCommand(program);
registerBenchmarkCommand(program);
registerDashboardCommand(program);

// Default action: launch dashboard when no subcommand is provided
program.action(async () => {
  try {
    const { launchDashboard } = await import('./tui/index.js');
    const result = await launchDashboard();

    if (result.action === 'branch-launch' && result.snapshotName) {
      const { createBranch } = await import('./core/branch-manager.js');
      await createBranch({
        snapshotName: result.snapshotName,
        branchName: result.branchName,
        noLaunch: false,
      });
    } else if (result.action === 'trim-launch' && result.snapshotName) {
      const { createBranch } = await import('./core/branch-manager.js');
      await createBranch({
        snapshotName: result.snapshotName,
        branchName: result.branchName,
        noLaunch: false,
        trim: true,
      });
    } else if (result.action === 'resume' && result.sessionId) {
      const { spawnClaudeInteractive } = await import('./utils/process.js');
      await spawnClaudeInteractive(['--resume', result.sessionId], undefined, result.cwd);
    }
  } catch (err) {
    const { handleError } = await import('./utils/errors.js');
    handleError(err);
  }
});

program.parse();

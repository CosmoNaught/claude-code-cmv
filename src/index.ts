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

const program = new Command();

program
  .name('vmc')
  .description('Virtual Memory Contextualization — git-like snapshots and branching for Claude Code sessions')
  .version('0.1.0');

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

program.parse();

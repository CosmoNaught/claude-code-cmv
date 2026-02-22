import { Command } from 'commander';
import { createBranch } from '../core/branch-manager.js';
import { success, info, dim } from '../utils/display.js';
import { handleError } from '../utils/errors.js';

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function printTrimMetrics(result: { trimMetrics?: import('../types/index.js').TrimMetrics }): void {
  if (!result.trimMetrics) return;
  const m = result.trimMetrics;
  const saved = m.originalBytes - m.trimmedBytes;
  const pct = m.originalBytes > 0 ? Math.round((saved / m.originalBytes) * 100) : 0;
  console.log(`  Trimmed: ${formatSize(m.originalBytes)} → ${formatSize(m.trimmedBytes)} (${pct}% reduction)`);
  const removedParts = [
    `${m.toolResultsStubbed} tool results`,
    `${m.signaturesStripped} signatures`,
    `${m.fileHistoryRemoved} file-history`,
  ];
  if (m.imagesStripped > 0) removedParts.push(`${m.imagesStripped} images`);
  if (m.toolUseInputsStubbed > 0) removedParts.push(`${m.toolUseInputsStubbed} tool inputs`);
  if (m.preCompactionLinesSkipped > 0) removedParts.push(`${m.preCompactionLinesSkipped} pre-compaction`);
  if (m.queueOperationsRemoved > 0) removedParts.push(`${m.queueOperationsRemoved} queue-ops`);
  console.log(`  Removed: ${removedParts.join(', ')}`);
  console.log(`  Preserved: ${m.userMessages} user msgs, ${m.assistantResponses} assistant msgs, ${m.toolUseRequests} tool uses`);
}

export function registerBranchCommand(program: Command): void {
  program
    .command('branch <snapshot>')
    .description('Create a new session from a snapshot')
    .option('-n, --name <name>', 'Name for the branch')
    .option('--no-trim', 'Skip trimming (copies raw context)')
    .option('-t, --threshold <chars>', 'Stub threshold when trimming (default: 500)')
    .option('--skip-launch', "Don't launch Claude Code, just create the session file")
    .option('--dry-run', 'Show what would happen without doing it')
    .action(async (snapshotName: string, opts: { name?: string; trim: boolean; threshold?: string; skipLaunch?: boolean; dryRun?: boolean }) => {
      try {
        const result = await createBranch({
          snapshotName,
          branchName: opts.name,
          noLaunch: opts.skipLaunch,
          dryRun: opts.dryRun,
          trim: opts.trim,
          trimThreshold: opts.threshold ? parseInt(opts.threshold, 10) : undefined,
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
          printTrimMetrics(result);
          return;
        }

        success(`Branch "${result.branchName}" created and session launched.`);
        console.log(`  Session ID: ${result.forkedSessionId}`);
        printTrimMetrics(result);
      } catch (err) {
        handleError(err);
      }
    });
}

import { Command } from 'commander';
import { createSnapshot } from '../core/snapshot-manager.js';
import { createBranch } from '../core/branch-manager.js';
import { success, info } from '../utils/display.js';
import { handleError } from '../utils/errors.js';

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function registerTrimCommand(program: Command): void {
  program
    .command('trim')
    .description('Snapshot + trimmed branch in one step (exit session first)')
    .option('-s, --session <id>', 'Session ID to trim')
    .option('--latest', 'Trim the most recently modified session')
    .option('-n, --name <name>', 'Name for the snapshot')
    .option('--skip-launch', "Don't launch Claude Code after trimming")
    .option('-t, --threshold <chars>', 'Stub threshold in characters (default: 500)')
    .action(async (opts: { session?: string; latest?: boolean; name?: string; skipLaunch?: boolean; threshold?: string }) => {
      try {
        if (!opts.session && !opts.latest) {
          console.error('Must provide --session <id> or --latest');
          process.exit(1);
        }

        // Step 1: Create a snapshot
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
        const snapshotName = opts.name || `_trim_${timestamp}`;

        info(`Creating snapshot "${snapshotName}"...`);
        await createSnapshot({
          name: snapshotName,
          sessionId: opts.session,
          latest: opts.latest,
          description: 'Auto-created for trimming',
          tags: ['trimmed'],
        });

        // Step 2: Create a trimmed branch
        info('Creating trimmed branch...');
        const result = await createBranch({
          snapshotName,
          trim: true,
          noLaunch: opts.skipLaunch,
          trimThreshold: opts.threshold ? parseInt(opts.threshold, 10) : undefined,
        });

        success(`Trimmed branch "${result.branchName}" created.`);
        console.log(`  Session ID: ${result.forkedSessionId}`);

        if (result.trimMetrics) {
          const m = result.trimMetrics;
          const saved = m.originalBytes - m.trimmedBytes;
          const pct = m.originalBytes > 0 ? Math.round((saved / m.originalBytes) * 100) : 0;
          console.log();
          console.log(`  Original:   ${formatSize(m.originalBytes)} (~${Math.round(m.originalBytes / 4 / 1000)}k tokens)`);
          console.log(`  Trimmed:    ${formatSize(m.trimmedBytes)} (~${Math.round(m.trimmedBytes / 4 / 1000)}k tokens)`);
          console.log(`  Reduction:  ${pct}%`);
          console.log();
          console.log(`  Tool results stubbed:         ${m.toolResultsStubbed}`);
          console.log(`  Thinking signatures stripped:  ${m.signaturesStripped}`);
          console.log(`  File-history entries removed:  ${m.fileHistoryRemoved}`);
          if (m.imagesStripped > 0) {
            console.log(`  Image blocks stripped:         ${m.imagesStripped}`);
          }
          if (m.toolUseInputsStubbed > 0) {
            console.log(`  Tool use inputs stubbed:       ${m.toolUseInputsStubbed}`);
          }
          if (m.preCompactionLinesSkipped > 0) {
            console.log(`  Pre-compaction lines skipped:  ${m.preCompactionLinesSkipped}`);
          }
          if (m.queueOperationsRemoved > 0) {
            console.log(`  Queue operations removed:      ${m.queueOperationsRemoved}`);
          }
          console.log();
          console.log(`  Conversation preserved:`);
          console.log(`    User messages:       ${m.userMessages}`);
          console.log(`    Assistant responses:  ${m.assistantResponses}`);
          console.log(`    Tool use requests:    ${m.toolUseRequests}`);
        }

        if (opts.skipLaunch) {
          console.log();
          console.log(`  Launch: ${result.command}`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}

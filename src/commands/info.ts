import { Command } from 'commander';
import { getSnapshot, readIndex, getSnapshotSize } from '../core/metadata-store.js';
import { error, bold, dim, formatDate } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import chalk from 'chalk';

export function registerInfoCommand(program: Command): void {
  program
    .command('info <name>')
    .description('Show detailed info about a snapshot')
    .action(async (name: string) => {
      try {
        const snapshot = await getSnapshot(name);
        if (!snapshot) {
          error(`Snapshot "${name}" not found.`);
          process.exit(1);
        }

        // Get snapshot directory size
        const totalSize = await getSnapshotSize(snapshot);

        // Build parent chain
        const parentChain: string[] = [];
        let currentParent = snapshot.parent_snapshot;
        const index = await readIndex();
        while (currentParent && index.snapshots[currentParent]) {
          parentChain.unshift(currentParent);
          currentParent = index.snapshots[currentParent]!.parent_snapshot;
        }

        // Display
        console.log(chalk.bold.cyan(`\n  ${snapshot.name}`));
        console.log('');
        console.log(`  ${dim('ID:')}            ${snapshot.id}`);
        console.log(`  ${dim('Created:')}       ${formatDate(snapshot.created_at)}`);
        console.log(`  ${dim('Session ID:')}    ${snapshot.source_session_id}`);
        console.log(`  ${dim('Project:')}       ${snapshot.source_project_path || '—'}`);
        console.log(`  ${dim('Messages:')}      ${snapshot.message_count ?? '—'}`);
        console.log(`  ${dim('Description:')}   ${snapshot.description || '—'}`);
        console.log(`  ${dim('Tags:')}          ${snapshot.tags.length > 0 ? snapshot.tags.join(', ') : '—'}`);
        console.log(`  ${dim('Parent:')}        ${snapshot.parent_snapshot || '(root)'}`);

        if (totalSize > 0) {
          const sizeStr = totalSize > 1024 * 1024
            ? `${(totalSize / (1024 * 1024)).toFixed(1)} MB`
            : `${(totalSize / 1024).toFixed(1)} KB`;
          console.log(`  ${dim('JSONL Size:')}    ${sizeStr}`);
        }

        if (parentChain.length > 0) {
          console.log(`  ${dim('Lineage:')}       ${parentChain.join(' → ')} → ${bold(snapshot.name)}`);
        }

        if (snapshot.branches.length > 0) {
          console.log(`\n  ${dim('Branches:')}`);
          for (const branch of snapshot.branches) {
            console.log(`    ${chalk.green(branch.name)}  ${dim(formatDate(branch.created_at))}  ${dim(branch.forked_session_id.substring(0, 8) + '…')}`);
          }
        } else {
          console.log(`\n  ${dim('No branches yet.')}`);
        }

        console.log('');
      } catch (err) {
        handleError(err);
      }
    });
}

import { Command } from 'commander';
import { readIndex } from '../core/metadata-store.js';
import { formatTable, formatRelativeTime, truncate, dim, bold, info } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { ListOptions } from '../types/index.js';
import chalk from 'chalk';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List all snapshots with metadata')
    .option('--tag <tag>', 'Filter by tag')
    .option('--sort <field>', 'Sort by: date (default), name, branches', 'date')
    .option('--json', 'Output as JSON')
    .action(async (opts: ListOptions) => {
      try {
        const index = await readIndex();
        let snapshots = Object.values(index.snapshots);

        if (snapshots.length === 0) {
          info('No snapshots yet. Create one with: vmc snapshot <name> --latest');
          return;
        }

        // Filter by tag
        if (opts.tag) {
          snapshots = snapshots.filter(s => s.tags.includes(opts.tag!));
        }

        // Sort
        switch (opts.sort) {
          case 'name':
            snapshots.sort((a, b) => a.name.localeCompare(b.name));
            break;
          case 'branches':
            snapshots.sort((a, b) => b.branches.length - a.branches.length);
            break;
          case 'date':
          default:
            snapshots.sort((a, b) => {
              const aTime = new Date(a.created_at).getTime();
              const bTime = new Date(b.created_at).getTime();
              return bTime - aTime;
            });
        }

        if (opts.json) {
          console.log(JSON.stringify(snapshots, null, 2));
          return;
        }

        // Table output
        const headers = ['Name', 'Created', 'Messages', 'Branches', 'Tags', 'Description'];
        const rows = snapshots.map(s => [
          chalk.cyan(s.name),
          formatRelativeTime(s.created_at),
          String(s.message_count ?? '—'),
          String(s.branches.length),
          s.tags.length > 0 ? s.tags.join(', ') : '—',
          truncate(s.description || '—', 30),
        ]);

        console.log(chalk.bold(`${snapshots.length} snapshot(s):\n`));
        console.log(formatTable(headers, rows));
      } catch (err) {
        handleError(err);
      }
    });
}

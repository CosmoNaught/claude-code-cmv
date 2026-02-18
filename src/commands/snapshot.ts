import { Command } from 'commander';
import { createSnapshot } from '../core/snapshot-manager.js';
import { success, warn, error } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { SnapshotOptions } from '../types/index.js';

export function registerSnapshotCommand(program: Command): void {
  program
    .command('snapshot <name>')
    .description('Snapshot a Claude Code session')
    .option('-s, --session <id>', 'Session ID to snapshot')
    .option('--latest', 'Snapshot the most recently modified session')
    .option('-d, --description <text>', 'Description text')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .action(async (name: string, opts: SnapshotOptions) => {
      try {
        if (!opts.session && !opts.latest) {
          error('Must provide --session <id> or --latest');
          process.exit(1);
        }

        const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined;

        const result = await createSnapshot({
          name,
          sessionId: opts.session,
          latest: opts.latest,
          description: opts.description,
          tags,
        });

        for (const w of result.warnings) {
          warn(w);
        }

        success(`Snapshot "${name}" created (${result.snapshot.id})`);

        if (result.snapshot.message_count) {
          console.log(`  Messages: ${result.snapshot.message_count}`);
        }
        if (result.snapshot.source_project_path) {
          console.log(`  Project: ${result.snapshot.source_project_path}`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}

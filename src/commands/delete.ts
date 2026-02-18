import { Command } from 'commander';
import { deleteSnapshot } from '../core/snapshot-manager.js';
import { getSnapshot } from '../core/metadata-store.js';
import { success, warn, error } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import * as readline from 'node:readline/promises';
import type { DeleteOptions } from '../types/index.js';

export function registerDeleteCommand(program: Command): void {
  program
    .command('delete <name>')
    .description('Delete a snapshot')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (name: string, opts: DeleteOptions) => {
      try {
        const snapshot = await getSnapshot(name);
        if (!snapshot) {
          error(`Snapshot "${name}" not found.`);
          process.exit(1);
        }

        if (snapshot.branches.length > 0) {
          warn(`Snapshot "${name}" has ${snapshot.branches.length} branch(es). Branch records will be lost.`);
        }

        if (!opts.force) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await rl.question(`Delete snapshot "${name}"? (y/N) `);
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
        }

        await deleteSnapshot(name);
        success(`Snapshot "${name}" deleted.`);
      } catch (err) {
        handleError(err);
      }
    });
}

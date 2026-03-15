// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import { importSnapshot } from '../core/importer.js';
import { success, warn } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { ImportOptions } from '../types/index.js';

export function registerImportCommand(program: Command): void {
  program
    .command('import <path>')
    .description('Import snapshot from portable .cmv file')
    .option('--rename <name>', 'Rename snapshot if name conflicts')
    .option('--force', 'Overwrite existing snapshot with same name')
    .action(async (filePath: string, opts: ImportOptions) => {
      try {
        const result = await importSnapshot(filePath, {
          rename: opts.rename,
          force: opts.force,
        });

        for (const w of result.warnings) {
          warn(w);
        }

        success(`Imported snapshot "${result.name}" (${result.snapshotId})`);
      } catch (err) {
        handleError(err);
      }
    });
}

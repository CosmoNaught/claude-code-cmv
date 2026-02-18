import { Command } from 'commander';
import { exportSnapshot } from '../core/exporter.js';
import { success } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { ExportOptions } from '../types/index.js';

export function registerExportCommand(program: Command): void {
  program
    .command('export <name>')
    .description('Export snapshot to portable .vmc file')
    .option('-o, --output <path>', 'Output file path (default: ./<name>.vmc)')
    .action(async (name: string, opts: ExportOptions) => {
      try {
        const outPath = await exportSnapshot(name, opts.output);
        success(`Exported "${name}" to ${outPath}`);
      } catch (err) {
        handleError(err);
      }
    });
}

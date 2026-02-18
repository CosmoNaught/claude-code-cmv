import { Command } from 'commander';
import { buildTree, renderTree, treeToJson } from '../core/tree-builder.js';
import { info } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { TreeOptions } from '../types/index.js';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Show snapshot/branch hierarchy as ASCII tree')
    .option('--depth <n>', 'Max depth to display', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (opts: TreeOptions) => {
      try {
        const roots = await buildTree();

        if (roots.length === 0) {
          info('No snapshots yet. Create one with: vmc snapshot <name> --latest');
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(treeToJson(roots), null, 2));
          return;
        }

        console.log(renderTree(roots, opts.depth));
      } catch (err) {
        handleError(err);
      }
    });
}

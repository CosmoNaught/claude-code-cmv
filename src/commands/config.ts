// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import { readConfig, writeConfig, initialize } from '../core/metadata-store.js';
import { success, info, dim } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { CmvConfig } from '../types/index.js';

const VALID_KEYS: (keyof CmvConfig)[] = ['claude_cli_path', 'default_project'];

export function registerConfigCommand(program: Command): void {
  program
    .command('config [key] [value]')
    .description('View or set CMV configuration')
    .action(async (key?: string, value?: string) => {
      try {
        await initialize();
        const config = await readConfig();

        if (!key) {
          // Show all config
          info('CMV Configuration:');
          if (Object.keys(config).length === 0) {
            console.log(dim('  (no configuration set)'));
          } else {
            for (const [k, v] of Object.entries(config)) {
              console.log(`  ${k} = ${v}`);
            }
          }
          console.log(dim(`\n  Valid keys: ${VALID_KEYS.join(', ')}`));
          return;
        }

        if (!VALID_KEYS.includes(key as keyof CmvConfig)) {
          console.error(`Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
          process.exit(1);
        }

        if (!value) {
          // Show single value
          const val = config[key as keyof CmvConfig];
          if (val !== undefined) {
            console.log(val);
          } else {
            console.log(dim('(not set)'));
          }
          return;
        }

        // Set value
        (config as Record<string, string>)[key] = value;
        await writeConfig(config);
        success(`${key} = ${value}`);
      } catch (err) {
        handleError(err);
      }
    });
}

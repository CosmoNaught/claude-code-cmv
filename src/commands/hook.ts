import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import { getClaudeSettingsPath, getCmvAutoTrimLogPath } from '../utils/paths.js';
import { listBackups, restoreBackup } from '../core/auto-backup.js';
import { success, info, dim } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { AutoTrimLogEntry } from '../types/index.js';

interface ClaudeSettings {
  hooks?: Record<string, Array<{
    matcher: string;
    hooks: Array<{
      type: string;
      command: string;
      timeout?: number;
    }>;
  }>>;
  [key: string]: unknown;
}

const CMV_COMMAND_PREFIX = 'cmv auto-trim';

function buildHookConfig(): Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> {
  return {
    PreCompact: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'cmv auto-trim',
        timeout: 30,
      }],
    }],
    PostToolUse: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'cmv auto-trim --check-size',
        timeout: 10,
      }],
    }],
  };
}

async function readSettings(): Promise<ClaudeSettings> {
  const settingsPath = getClaudeSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSettings(settings: ClaudeSettings): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

function isCmvHookEntry(entry: { matcher: string; hooks: Array<{ command: string }> }): boolean {
  return entry.hooks.some(h => h.command.startsWith(CMV_COMMAND_PREFIX));
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function registerHookCommand(program: Command): void {
  const hook = program
    .command('hook')
    .description('Manage auto-trim hooks for Claude Code');

  hook
    .command('install')
    .description('Install auto-trim hooks into Claude Code settings')
    .action(async () => {
      try {
        const settings = await readSettings();
        if (!settings.hooks) settings.hooks = {};

        const newHooks = buildHookConfig();

        for (const [event, entries] of Object.entries(newHooks)) {
          if (!settings.hooks[event]) {
            settings.hooks[event] = [];
          }
          // Remove existing CMV entries
          settings.hooks[event] = settings.hooks[event]!.filter(e => !isCmvHookEntry(e));
          // Add new CMV entries
          settings.hooks[event]!.push(...entries);
        }

        await writeSettings(settings);
        success('Auto-trim hooks installed.');
        console.log('  PreCompact: trims before compaction fires');
        console.log('  PostToolUse: trims when context gets heavy (~600KB)');
        console.log(`  Settings: ${dim(getClaudeSettingsPath())}`);
      } catch (err) {
        handleError(err);
      }
    });

  hook
    .command('uninstall')
    .description('Remove auto-trim hooks from Claude Code settings')
    .action(async () => {
      try {
        const settings = await readSettings();
        if (!settings.hooks) {
          info('No hooks installed.');
          return;
        }

        let removed = 0;
        for (const event of Object.keys(settings.hooks)) {
          const before = settings.hooks[event]!.length;
          settings.hooks[event] = settings.hooks[event]!.filter(e => !isCmvHookEntry(e));
          removed += before - settings.hooks[event]!.length;
          // Clean up empty arrays
          if (settings.hooks[event]!.length === 0) {
            delete settings.hooks[event];
          }
        }

        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }

        await writeSettings(settings);

        if (removed > 0) {
          success(`Removed ${removed} CMV hook(s).`);
        } else {
          info('No CMV hooks found.');
        }
      } catch (err) {
        handleError(err);
      }
    });

  hook
    .command('status')
    .description('Show auto-trim hook status')
    .action(async () => {
      try {
        const settings = await readSettings();
        const hooks = settings.hooks || {};

        const preCompactInstalled = hooks.PreCompact?.some(e => isCmvHookEntry(e)) ?? false;
        const postToolUseInstalled = hooks.PostToolUse?.some(e => isCmvHookEntry(e)) ?? false;

        console.log('Hook status:');
        console.log(`  PreCompact:  ${preCompactInstalled ? '\x1b[32m● installed\x1b[0m' : '\x1b[90m○ not installed\x1b[0m'}`);
        console.log(`  PostToolUse: ${postToolUseInstalled ? '\x1b[32m● installed\x1b[0m' : '\x1b[90m○ not installed\x1b[0m'}`);

        // Show last trim stats
        try {
          const raw = await fs.readFile(getCmvAutoTrimLogPath(), 'utf-8');
          const log: AutoTrimLogEntry[] = JSON.parse(raw);
          if (log.length > 0) {
            const last = log[0]!;
            console.log('');
            console.log('Last trim:');
            console.log(`  Time:      ${last.timestamp}`);
            console.log(`  Trigger:   ${last.trigger}`);
            console.log(`  Reduction: ${formatSize(last.originalBytes)} → ${formatSize(last.trimmedBytes)} (${last.reductionPercent}%)`);
          }
        } catch {
          // No log yet
        }
      } catch (err) {
        handleError(err);
      }
    });

  hook
    .command('restore')
    .description('Restore a session from auto-backup')
    .option('--list', 'List available backups')
    .argument('[session-id]', 'Session ID to restore')
    .action(async (sessionId?: string, opts?: { list?: boolean }) => {
      try {
        if (opts?.list || !sessionId) {
          const backups = await listBackups(sessionId);
          if (backups.length === 0) {
            info(sessionId ? `No backups for session ${sessionId}.` : 'No backups found.');
            return;
          }
          console.log('Available backups:');
          for (const b of backups) {
            console.log(`  ${b.sessionId.substring(0, 10)}…  ${b.timestamp}  ${formatSize(b.size)}`);
            console.log(`    ${dim(b.path)}`);
          }
          return;
        }

        const backups = await listBackups(sessionId);
        if (backups.length === 0) {
          info(`No backups for session ${sessionId}.`);
          return;
        }

        const latest = backups[0]!;
        // Find the original transcript path from the session ID
        const { getClaudeProjectsDir } = await import('../utils/paths.js');
        const projectsDir = getClaudeProjectsDir();
        const dirs = await fs.readdir(projectsDir, { withFileTypes: true });

        for (const dir of dirs) {
          if (!dir.isDirectory()) continue;
          const { join } = await import('node:path');
          const jsonlPath = join(projectsDir, dir.name, `${sessionId}.jsonl`);
          try {
            await fs.access(jsonlPath);
            await restoreBackup(latest.path, jsonlPath);
            success(`Restored backup from ${latest.timestamp}`);
            console.log(`  ${dim(jsonlPath)}`);
            return;
          } catch {
            continue;
          }
        }

        info('Could not find original session file. Backup is at:');
        console.log(`  ${latest.path}`);
      } catch (err) {
        handleError(err);
      }
    });
}

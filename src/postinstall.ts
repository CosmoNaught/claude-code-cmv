#!/usr/bin/env node
/**
 * Postinstall: auto-install CMV hooks into Claude Code settings.
 * Runs silently — failures are swallowed so npm install never breaks.
 */
import * as fs from 'node:fs/promises';
import { getClaudeSettingsPath } from './utils/paths.js';

const CMV_COMMAND_PREFIX = 'cmv auto-trim';

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

function buildHookConfig() {
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

function isCmvHookEntry(entry: { hooks: Array<{ command: string }> }): boolean {
  return entry.hooks.some(h => h.command.startsWith(CMV_COMMAND_PREFIX));
}

async function main() {
  const settingsPath = getClaudeSettingsPath();

  let settings: ClaudeSettings;
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};

  // Check if already installed
  const alreadyInstalled =
    settings.hooks.PreCompact?.some(e => isCmvHookEntry(e)) &&
    settings.hooks.PostToolUse?.some(e => isCmvHookEntry(e));

  if (alreadyInstalled) return;

  const newHooks = buildHookConfig();

  for (const [event, entries] of Object.entries(newHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    settings.hooks[event] = settings.hooks[event]!.filter(e => !isCmvHookEntry(e));
    settings.hooks[event]!.push(...entries);
  }

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  console.log('CMV: auto-trim hooks installed into Claude Code settings.');
}

main().catch(() => {});

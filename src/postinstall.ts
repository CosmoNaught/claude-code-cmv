#!/usr/bin/env node
// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Postinstall: auto-install CMV hooks into Claude Code settings.
 * Runs silently — failures are swallowed so npm install never breaks.
 */
import * as fs from 'node:fs/promises';
import { getClaudeSettingsPath, resolveCmvBinary } from './utils/paths.js';

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

function buildHookConfig(cmvBin: string) {
  return {
    PreCompact: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `${cmvBin} auto-trim`,
        timeout: 30,
      }],
    }],
    PostToolUse: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `${cmvBin} auto-trim --check-size`,
        timeout: 10,
      }],
    }],
  };
}

/**
 * Matches both bare `cmv auto-trim` (old installs) and absolute-path variants.
 */
function isCmvHookEntry(entry: { hooks: Array<{ command: string }> }): boolean {
  return entry.hooks.some(h => /(?:^|[\\/])cmv(?:\.cmd|\.ps1)?\s+auto-trim/.test(h.command));
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

  const cmvBin = await resolveCmvBinary();

  // Always replace hooks to ensure the path is up-to-date
  const newHooks = buildHookConfig(cmvBin);

  for (const [event, entries] of Object.entries(newHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    settings.hooks[event] = settings.hooks[event]!.filter(e => !isCmvHookEntry(e));
    settings.hooks[event]!.push(...entries);
  }

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  console.log(`CMV: auto-trim hooks installed (binary: ${cmvBin}).`);
}

export { main, buildHookConfig, isCmvHookEntry };

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  main().catch(() => {});
}

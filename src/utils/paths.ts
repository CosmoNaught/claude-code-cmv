// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/**
 * Get the Claude Code projects directory: ~/.claude/projects/
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Get the Claude Code base directory: ~/.claude/
 */
export function getClaudeBaseDir(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Get the CMV storage directory: ~/.cmv/
 */
export function getCmvDir(): string {
  return path.join(os.homedir(), '.cmv');
}

/**
 * Get the CMV snapshots directory: ~/.cmv/snapshots/
 */
export function getCmvSnapshotsDir(): string {
  return path.join(getCmvDir(), 'snapshots');
}

/**
 * Get the CMV index file path: ~/.cmv/index.json
 */
export function getCmvIndexPath(): string {
  return path.join(getCmvDir(), 'index.json');
}

/**
 * Get the CMV config file path: ~/.cmv/config.json
 */
export function getCmvConfigPath(): string {
  return path.join(getCmvDir(), 'config.json');
}

/**
 * List all project directories under ~/.claude/projects/
 * On Windows, deduplicates case-insensitively.
 */
export async function listProjectDirs(): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => path.join(projectsDir, e.name));

    // On Windows, deduplicate case-insensitively (keep the first occurrence)
    if (process.platform === 'win32') {
      const seen = new Set<string>();
      return dirs.filter(d => {
        const lower = d.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    }

    return dirs;
  } catch {
    return [];
  }
}

/**
 * Get the IDE lock files directory: ~/.claude/ide/
 */
export function getClaudeIdeLockDir(): string {
  return path.join(getClaudeBaseDir(), 'ide');
}

/**
 * Get the CMV auto-backups directory: ~/.cmv/auto-backups/
 */
export function getCmvAutoBackupsDir(): string {
  return path.join(getCmvDir(), 'auto-backups');
}

/**
 * Get the CMV auto-trim log path: ~/.cmv/auto-trim-log.json
 */
export function getCmvAutoTrimLogPath(): string {
  return path.join(getCmvDir(), 'auto-trim-log.json');
}

/**
 * Get the Claude Code settings path: ~/.claude/settings.json
 */
export function getClaudeSettingsPath(): string {
  return path.join(getClaudeBaseDir(), 'settings.json');
}

/**
 * Resolve the absolute path to the cmv binary for use in hook commands.
 *
 * Claude Code hooks run in non-interactive shells that don't source .bashrc,
 * so custom PATH entries (like ~/.npm-global/bin) aren't available. Using an
 * absolute path ensures the hook works regardless of shell configuration.
 *
 * Resolution order:
 *   1. Walk up from this file to find the package's dist/index.js
 *   2. Fall back to `which cmv` / `where cmv`
 *   3. Fall back to bare `cmv` (original behavior) if nothing else works
 */
export async function resolveCmvBinary(): Promise<string> {
  // Strategy 1: This file is at <pkg>/dist/utils/paths.js at runtime.
  // Walk up to find package.json, then use dist/index.js.
  try {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    // On Windows, strip leading slash from /C:/... paths
    if (process.platform === 'win32' && dir.match(/^\/[A-Za-z]:\//)) {
      dir = dir.slice(1);
    }
    for (let i = 0; i < 5; i++) {
      const pkgJson = path.join(dir, 'package.json');
      try {
        await fs.access(pkgJson);
        const entryPoint = path.join(dir, 'dist', 'index.js');
        await fs.access(entryPoint);
        return entryPoint;
      } catch {
        dir = path.dirname(dir);
      }
    }
  } catch {
    // import.meta.url resolution failed, continue to next strategy
  }

  // Strategy 2: Use `which` (Unix) or `where` (Windows) to find cmv on PATH
  try {
    const { execFileSync } = await import('node:child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['cmv'], { encoding: 'utf-8', timeout: 5000 }).trim();
    // `where` on Windows can return multiple lines; take the first
    const firstLine = result.split('\n')[0]!.trim();
    if (firstLine) {
      // Resolve symlinks to get the real path
      const resolved = await fs.realpath(firstLine);
      return resolved;
    }
  } catch {
    // cmv not on PATH, continue to fallback
  }

  // Strategy 3: bare command (original behavior, will fail in non-interactive shells
  // but is no worse than before)
  return 'cmv';
}

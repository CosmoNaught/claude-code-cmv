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

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
 * Get the VMC storage directory: ~/.vmc/
 */
export function getVmcDir(): string {
  return path.join(os.homedir(), '.vmc');
}

/**
 * Get the VMC snapshots directory: ~/.vmc/snapshots/
 */
export function getVmcSnapshotsDir(): string {
  return path.join(getVmcDir(), 'snapshots');
}

/**
 * Get the VMC index file path: ~/.vmc/index.json
 */
export function getVmcIndexPath(): string {
  return path.join(getVmcDir(), 'index.json');
}

/**
 * Get the VMC config file path: ~/.vmc/config.json
 */
export function getVmcConfigPath(): string {
  return path.join(getVmcDir(), 'config.json');
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

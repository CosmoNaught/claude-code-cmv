import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { listProjectDirs, getClaudeIdeLockDir } from '../utils/paths.js';
import type { ClaudeSessionsIndex, ClaudeSessionEntry } from '../types/index.js';

/**
 * Reads Claude Code session storage. READ-ONLY — never writes to Claude Code directories.
 */

/**
 * Read sessions-index.json from a project directory.
 * Falls back to scanning .jsonl files directly if the index doesn't exist.
 *
 * Parallelizes all I/O: stats every JSONL for fresh mtime, only parses
 * JSONL content for sessions with messageCount=0 (small/new sessions).
 */
async function readSessionsIndex(projectDir: string): Promise<ClaudeSessionsIndex | null> {
  const indexPath = path.join(projectDir, 'sessions-index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const index = JSON.parse(raw) as ClaudeSessionsIndex;

    const indexedIds = new Set(index.entries.map(e => e.sessionId));

    // Parallel: stat all JSONL files + selectively count messages
    await Promise.all(index.entries.map(async (entry) => {
      const jsonlPath = path.join(projectDir, `${entry.sessionId}.jsonl`);

      // Stat for fresh mtime
      try {
        const stat = await fs.stat(jsonlPath);
        const fileMtime = stat.mtime.toISOString();
        if (!entry.modified || new Date(fileMtime) > new Date(entry.modified)) {
          entry.modified = fileMtime;
          entry.fileMtime = stat.mtimeMs;
        }

        // Parse JSONL for sessions missing message count (small/new) or missing/encoded projectPath
        const needsCount = !entry.messageCount || entry.messageCount === 0;
        const needsPath = !entry.projectPath || entry.projectPath.startsWith('-');

        if (needsCount || needsPath) {
          const counts = await countConversationMessages(jsonlPath);
          if (counts.messageCount > 0) entry.messageCount = counts.messageCount;
          if (!entry.firstPrompt && counts.firstPrompt) entry.firstPrompt = counts.firstPrompt;
          // Update projectPath if we extracted a cwd and the current path looks encoded
          if (counts.cwd && needsPath) {
            entry.projectPath = counts.cwd;
          }
        }
      } catch {
        // JSONL file might not exist (orphaned index entry)
      }
    }));

    // Discover JSONL files not yet in the index (new/active sessions)
    try {
      const items = await fs.readdir(projectDir, { withFileTypes: true });
      const dirName = path.basename(projectDir);
      const fallbackProjectPath = index.originalPath || decodeDirName(dirName);

      await Promise.all(items
        .filter(item => item.isFile() && item.name.endsWith('.jsonl'))
        .filter(item => !indexedIds.has(item.name.replace('.jsonl', '')))
        .map(async (item) => {
          const sessionId = item.name.replace('.jsonl', '');
          const filePath = path.join(projectDir, item.name);
          const stat = await fs.stat(filePath);
          const counts = await countConversationMessages(filePath);

          // Prefer cwd from JSONL over decoded directory name
          const projectPath = counts.cwd || fallbackProjectPath;

          index.entries.push({
            sessionId,
            fullPath: filePath,
            fileMtime: stat.mtimeMs,
            firstPrompt: counts.firstPrompt,
            messageCount: counts.messageCount || undefined,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            projectPath,
          });
        }));
    } catch {
      // Can't read directory
    }

    return index;
  } catch {
    // Fallback: scan for .jsonl files directly
    return scanJsonlFiles(projectDir);
  }
}

/**
 * Count actual conversation messages (user/assistant) in a JSONL file.
 * Returns the count, the first user prompt (best-effort), and the cwd from the session.
 */
async function countConversationMessages(
  jsonlPath: string
): Promise<{ messageCount: number; firstPrompt?: string; cwd?: string }> {
  let messageCount = 0;
  let firstPrompt: string | undefined;
  let cwd: string | undefined;

  try {
    const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' || parsed.type === 'assistant' ||
            parsed.type === 'human' || parsed.role === 'user' || parsed.role === 'assistant') {
          messageCount++;
        }
        if (!firstPrompt && (parsed.type === 'human' || parsed.type === 'user' || parsed.role === 'user')) {
          const content = parsed.message?.content || parsed.content;
          if (typeof content === 'string') {
            firstPrompt = content.slice(0, 100);
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: { type: string }) => b.type === 'text');
            if (textBlock?.text) {
              firstPrompt = (textBlock.text as string).slice(0, 100);
            }
          }
        }
        // Extract cwd from the first record that has it
        if (!cwd && parsed.cwd) {
          cwd = parsed.cwd;
        }
      } catch {
        // Skip unparseable lines
      }
    }
    rl.close();
  } catch {
    // Can't read file
  }

  return { messageCount, firstPrompt, cwd };
}

/**
 * Fallback discovery: build a sessions index from .jsonl files when sessions-index.json is missing.
 */
async function scanJsonlFiles(projectDir: string): Promise<ClaudeSessionsIndex | null> {
  try {
    const items = await fs.readdir(projectDir, { withFileTypes: true });
    const jsonlFiles = items.filter((i: { isFile(): boolean; name: string }) => i.isFile() && i.name.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) return null;

    // Derive project path from directory name as fallback: "d--hiddenstate" → "d:\hiddenstate"
    const dirName = path.basename(projectDir);
    const fallbackProjectPath = decodeDirName(dirName);

    const entries: ClaudeSessionEntry[] = [];
    for (const file of jsonlFiles) {
      const sessionId = file.name.replace('.jsonl', '');
      const filePath = path.join(projectDir, file.name);
      const stat = await fs.stat(filePath);

      // Count conversation messages and extract first prompt and cwd
      const counts = await countConversationMessages(filePath);

      // Prefer cwd from JSONL over decoded directory name
      const projectPath = counts.cwd || fallbackProjectPath;

      entries.push({
        sessionId,
        fullPath: filePath,
        fileMtime: stat.mtimeMs,
        firstPrompt: counts.firstPrompt,
        messageCount: counts.messageCount || undefined,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        projectPath,
      });
    }

    return {
      version: 1,
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * List all sessions across all projects, sorted by modified date (newest first).
 * When projectFilter is provided, only scans matching project directories.
 */
export async function listAllSessions(
  projectFilter?: string
): Promise<(ClaudeSessionEntry & { _projectDir: string })[]> {
  let projectDirs = await listProjectDirs();

  // Early filter: only scan project dirs that match the filter
  if (projectFilter) {
    const filterLower = projectFilter.toLowerCase();
    projectDirs = projectDirs.filter(dir => {
      const dirName = path.basename(dir).toLowerCase();
      return dirName.includes(filterLower);
    });
  }

  // Scan project dirs in parallel
  const results = await Promise.all(
    projectDirs.map(async (dir) => {
      const index = await readSessionsIndex(dir);
      if (!index) return [];
      return index.entries.map(entry => ({ ...entry, _projectDir: dir }));
    })
  );

  const allSessions = results.flat();

  // If project filter was given, also filter by projectPath field (for cases
  // where the dir name encoding doesn't perfectly match the filter)
  let filtered = allSessions;
  if (projectFilter) {
    const filterLower = projectFilter.toLowerCase();
    filtered = allSessions.filter(s => {
      const projPath = s.projectPath?.toLowerCase() || '';
      const dirName = path.basename(s._projectDir).toLowerCase();
      return projPath.includes(filterLower) || dirName.includes(filterLower);
    });
  }

  // Sort by modified date, newest first
  filtered.sort((a, b) => {
    const aTime = a.modified ? new Date(a.modified).getTime() : 0;
    const bTime = b.modified ? new Date(b.modified).getTime() : 0;
    return bTime - aTime;
  });

  return filtered;
}

/**
 * List sessions filtered by project path.
 */
export async function listSessionsByProject(
  projectFilter: string
): Promise<(ClaudeSessionEntry & { _projectDir: string })[]> {
  return listAllSessions(projectFilter);
}

/**
 * Find a specific session by ID across all projects.
 * Supports prefix matching — you only need enough characters to be unique (minimum 4).
 */
export async function findSession(
  sessionId: string
): Promise<(ClaudeSessionEntry & { _projectDir: string }) | null> {
  const all = await listAllSessions();

  // Try exact match first
  const exact = all.find(e => e.sessionId === sessionId);
  if (exact) return exact;

  // Try prefix match (minimum 4 chars)
  if (sessionId.length >= 4) {
    const prefix = sessionId.toLowerCase();
    const matches = all.filter(e => e.sessionId.toLowerCase().startsWith(prefix));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Use more characters.\n` +
        matches.map(m => `  ${m.sessionId}  ${m.projectPath || ''}`).join('\n')
      );
    }
  }

  return null;
}

/**
 * Get the most recently modified session.
 */
export async function getLatestSession(): Promise<(ClaudeSessionEntry & { _projectDir: string }) | null> {
  const all = await listAllSessions();
  return all[0] || null;
}

/**
 * Get the JSONL file path for a session.
 */
export function getSessionJsonlPath(entry: ClaudeSessionEntry & { _projectDir: string }): string {
  return path.join(entry._projectDir, `${entry.sessionId}.jsonl`);
}

/**
 * Check if a session appears to be currently active.
 * Heuristic: fileMtime within last 2 minutes AND an ide/*.lock file has a running PID.
 */
export async function isSessionActive(entry: ClaudeSessionEntry): Promise<boolean> {
  // Check if fileMtime is recent (within 2 minutes)
  const mtime = entry.fileMtime || 0;
  const twoMinutesAgo = Date.now() - 2 * 60 * 1000;

  if (mtime < twoMinutesAgo) {
    return false;
  }

  // Check for IDE lock files
  try {
    const lockDir = getClaudeIdeLockDir();
    const lockFiles = await fs.readdir(lockDir);

    for (const lockFile of lockFiles) {
      if (!lockFile.endsWith('.lock')) continue;
      try {
        const lockContent = await fs.readFile(path.join(lockDir, lockFile), 'utf-8');
        const lockData = JSON.parse(lockContent);
        // If there's a lock file with a PID, session is likely active
        if (lockData.pid) {
          return true;
        }
      } catch {
        // Ignore individual lock file read errors
      }
    }
  } catch {
    // No lock directory or can't read it
  }

  // If fileMtime is very recent but no lock files, still consider it potentially active
  return true;
}

/**
 * Extract Claude Code version from the first line of a JSONL file (best-effort).
 */
export async function extractClaudeVersion(jsonlPath: string): Promise<string | null> {
  try {
    const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.version) {
          rl.close();
          return parsed.version as string;
        }
      } catch {
        // Skip unparseable lines
      }
      // Only check the first few lines
      rl.close();
      break;
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return null;
}

/**
 * Decode a Claude project directory name back to a path.
 * Windows: "d--hiddenstate" → "d:\hiddenstate"
 * Linux:   "home--user--project" → "/home/user/project"
 */
function decodeDirName(dirName: string): string {
  // Windows: single letter prefix = drive letter
  if (process.platform === 'win32') {
    const match = dirName.match(/^([a-zA-Z])--(.+)$/);
    if (match) {
      const drive = match[1]!;
      const rest = match[2]!.replace(/--/g, path.sep);
      return `${drive}:${path.sep}${rest}`;
    }
  }

  // Linux/macOS: "home--user--project" → "/home/user/project"
  if (dirName.includes('--')) {
    return '/' + dirName.replace(/--/g, '/');
  }

  return dirName;
}

/**
 * Delete a Claude Code session: removes the JSONL file, any session
 * subdirectory (subagents, tool-results), and the sessions-index.json entry.
 */
export async function deleteSession(
  entry: ClaudeSessionEntry & { _projectDir: string }
): Promise<void> {
  const { sessionId, _projectDir: projectDir } = entry;

  // Delete the session JSONL file
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    await fs.unlink(jsonlPath);
  } catch {
    // File may already be gone
  }

  // Delete the session subdirectory (newer format: subagents/, tool-results/)
  const sessionDir = path.join(projectDir, sessionId);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch {
    // Directory may not exist (older session format)
  }

  // Remove from sessions-index.json
  const indexPath = path.join(projectDir, 'sessions-index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const index = JSON.parse(raw) as { version: number; entries: Array<{ sessionId: string }>; originalPath?: string };
    index.entries = index.entries.filter(e => e.sessionId !== sessionId);
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  } catch {
    // sessions-index.json may not exist or be malformed
  }
}

/**
 * Read sessions-index.json for a specific project directory.
 * Exported for use by branch-manager (to diff before/after fork).
 */
export { readSessionsIndex };

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getSnapshot, addBranch, removeBranch, readConfig } from './metadata-store.js';
import { generateUUID } from '../utils/id.js';
import { spawnClaudeInteractive, getClaudeCliPath } from '../utils/process.js';
import { getClaudeProjectsDir, getCmvSnapshotsDir } from '../utils/paths.js';
import { trimJsonl } from './trimmer.js';
import type { TrimMetrics } from '../types/index.js';

export interface BranchParams {
  snapshotName: string;
  branchName?: string;
  noLaunch?: boolean;
  dryRun?: boolean;
  trim?: boolean;
  trimThreshold?: number;
  orientationMessage?: string;
}

export interface BranchResult {
  branchName: string;
  forkedSessionId: string;
  command: string;
  launched: boolean;
  projectDir?: string;
  trimMetrics?: TrimMetrics;
}

/**
 * Create a new branch (forked session) from a snapshot.
 *
 * Strategy: Copy the snapshot's JSONL to the Claude project directory
 * with a new session ID, update sessions-index.json, then resume.
 * This is more reliable than --fork-session because we control file placement.
 */
export async function createBranch(params: BranchParams): Promise<BranchResult> {
  const snapshot = await getSnapshot(params.snapshotName);
  if (!snapshot) {
    throw new Error(`Snapshot "${params.snapshotName}" not found.`);
  }

  // Find the snapshot's JSONL file in CMV storage
  const snapshotJsonlPath = path.join(
    getCmvSnapshotsDir(),
    snapshot.snapshot_dir,
    'session',
    `${snapshot.source_session_id}.jsonl`
  );

  try {
    await fs.access(snapshotJsonlPath);
  } catch {
    throw new Error(
      `Snapshot session file not found at ${snapshotJsonlPath}. ` +
      `The snapshot may be corrupted. Try re-creating it.`
    );
  }

  // Verify the JSONL has actual conversation content
  const hasConversation = await checkHasConversation(snapshotJsonlPath);
  if (!hasConversation) {
    throw new Error(
      `Snapshot "${params.snapshotName}" has no conversation messages — only file tracking data. ` +
      `Claude requires conversation content to resume a session.\n` +
      `Delete this snapshot and re-create from a session with messages > 0:\n` +
      `  cmv delete "${params.snapshotName}"\n` +
      `  cmv sessions  # find a session with conversation messages\n` +
      `  cmv snapshot "${params.snapshotName}" --session <id>`
    );
  }

  // Find the Claude project directory for this session
  const projectDir = await findProjectDir(
    snapshot.source_session_id,
    snapshot.source_project_path
  );
  if (!projectDir) {
    throw new Error(
      `Cannot find Claude project directory for "${snapshot.source_project_path}". ` +
      `Make sure Claude Code has been used in this project.`
    );
  }

  // Auto-generate branch name if not provided
  const branchName = params.branchName || generateBranchName(params.snapshotName);

  // Generate new session UUID
  const newSessionId = generateUUID();

  // Build the command (just --resume, no --fork-session needed)
  const config = await readConfig();
  const cliPath = getClaudeCliPath(config.claude_cli_path);
  const args = ['--resume', newSessionId];
  const command = `${cliPath} ${args.join(' ')}`;

  // Derive CWD from source project path (decode if stored as encoded dir name)
  const cwd = decodeProjectPath(snapshot.source_project_path) || process.cwd();

  if (params.dryRun) {
    return {
      branchName,
      forkedSessionId: newSessionId,
      command: `cd "${cwd}" && ${command}`,
      launched: false,
      projectDir,
    };
  }

  // Copy (or trim) snapshot JSONL to project directory with new session ID
  const destJsonlPath = path.join(projectDir, `${newSessionId}.jsonl`);
  let trimMetrics: TrimMetrics | undefined;
  try {
    if (params.trim) {
      trimMetrics = await trimJsonl(snapshotJsonlPath, destJsonlPath, {
        threshold: params.trimThreshold,
      });
    } else {
      await fs.copyFile(snapshotJsonlPath, destJsonlPath);
    }
  } catch (err) {
    throw new Error(`Failed to ${params.trim ? 'trim' : 'copy'} session file: ${(err as Error).message}`);
  }

  // Append orientation message if provided (used by multi-branch)
  if (params.orientationMessage) {
    const orientationLine = JSON.stringify({
      type: 'human',
      message: { role: 'user', content: params.orientationMessage },
    }) + '\n';
    await fs.appendFile(destJsonlPath, orientationLine);
  }

  // Update sessions-index.json in the project directory
  const decodedProjectPath = decodeProjectPath(snapshot.source_project_path);
  await updateSessionsIndex(
    projectDir,
    newSessionId,
    destJsonlPath,
    decodedProjectPath,
    branchName
  );

  // Record the branch in CMV's index
  await addBranch(params.snapshotName, {
    name: branchName,
    forked_session_id: newSessionId,
    created_at: new Date().toISOString(),
  });

  if (params.noLaunch) {
    return {
      branchName,
      forkedSessionId: newSessionId,
      command: `cd "${cwd}" && ${command}`,
      launched: false,
      projectDir,
      trimMetrics,
    };
  }

  // Launch Claude CLI interactively from the correct project directory
  try {
    const exitCode = await spawnClaudeInteractive(args, config.claude_cli_path, cwd);

    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(
        `Claude CLI exited with code ${exitCode}. ` +
        `Session file created at: ${destJsonlPath}\n` +
        `Try running manually: cd "${cwd}" && ${command}`
      );
    }
  } catch (err) {
    if ((err as Error).message.includes('Claude CLI exited')) {
      throw err;
    }
    throw new Error(`Failed to launch Claude CLI: ${(err as Error).message}`);
  }

  return {
    branchName,
    forkedSessionId: newSessionId,
    command,
    launched: true,
    projectDir,
    trimMetrics,
  };
}

/**
 * Delete a branch: remove its session file from the Claude project
 * directory, remove its sessions-index.json entry, and remove the
 * branch record from the CMV index.
 */
export async function deleteBranch(snapshotName: string, branchName: string): Promise<void> {
  const snapshot = await getSnapshot(snapshotName);
  if (!snapshot) {
    throw new Error(`Snapshot "${snapshotName}" not found.`);
  }

  const branch = snapshot.branches.find(b => b.name === branchName);
  if (!branch) {
    throw new Error(`Branch "${branchName}" not found in snapshot "${snapshotName}".`);
  }

  // Find the Claude project directory that contains the branch session file
  const projectDir = await findProjectDir(
    branch.forked_session_id,
    snapshot.source_project_path
  );

  if (projectDir) {
    // Delete the session JSONL file
    const jsonlPath = path.join(projectDir, `${branch.forked_session_id}.jsonl`);
    try {
      await fs.unlink(jsonlPath);
    } catch {
      // File may already be gone
    }

    // Remove from sessions-index.json
    await removeFromSessionsIndex(projectDir, branch.forked_session_id);
  }

  // Remove from CMV index
  await removeBranch(snapshotName, branchName);
}

/**
 * Remove a session entry from sessions-index.json in a Claude project directory.
 */
async function removeFromSessionsIndex(projectDir: string, sessionId: string): Promise<void> {
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
 * Find the Claude project directory for a session.
 * First tries to find by session JSONL file, then by project path encoding.
 */
async function findProjectDir(
  sessionId: string,
  projectPath: string
): Promise<string | null> {
  const projectsDir = getClaudeProjectsDir();

  try {
    const dirs = await fs.readdir(projectsDir, { withFileTypes: true });

    // Strategy 1: Find directory containing the original session JSONL
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(projectsDir, dir.name);
      const jsonlPath = path.join(dirPath, `${sessionId}.jsonl`);
      try {
        await fs.access(jsonlPath);
        return dirPath;
      } catch {
        // Not in this dir
      }
    }

    // Strategy 2: Match by project path encoding (case-insensitive on Windows)
    if (projectPath) {
      const encoded = encodeProjectPath(projectPath);
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        if (dir.name.toLowerCase() === encoded.toLowerCase()) {
          return path.join(projectsDir, dir.name);
        }
      }
    }
  } catch {
    // Can't read projects dir
  }

  return null;
}

/**
 * Encode a project path to Claude's directory name format.
 * Windows: "d:\hiddenstate" → "d--hiddenstate"
 * Linux:   "/home/user/project" → "home--user--project"
 */
function encodeProjectPath(projectPath: string): string {
  return projectPath
    .replace(/:/g, '')
    .replace(/^\//, '')       // strip leading / on Linux
    .replace(/[\\/]+/g, '--');
}

/**
 * Decode a project path that might be an encoded directory name.
 * Handles both platforms:
 *   Windows: "d--hiddenstate" → "d:\hiddenstate"
 *   Linux:   "home--user--project" → "/home/user/project"
 *   Already a path: returned as-is
 * Returns empty string if input is empty/falsy.
 */
function decodeProjectPath(projectPath: string): string {
  if (!projectPath) return '';

  // Already a real path (contains : or starts with /)
  if (projectPath.includes(':') || projectPath.startsWith('/')) {
    return projectPath;
  }

  // Windows: "d--hiddenstate" → "d:\hiddenstate" (single letter = drive)
  if (process.platform === 'win32') {
    const match = projectPath.match(/^([a-zA-Z])--(.+)$/);
    if (match) {
      const drive = match[1]!;
      const rest = match[2]!.replace(/--/g, path.sep);
      return `${drive}:${path.sep}${rest}`;
    }
  }

  // Linux/macOS: "home--user--project" → "/home/user/project"
  if (projectPath.includes('--')) {
    return '/' + projectPath.replace(/--/g, '/');
  }

  return projectPath;
}

/**
 * Update or create sessions-index.json in a Claude project directory.
 * Adds the new session entry so claude --resume can discover it.
 */
async function updateSessionsIndex(
  projectDir: string,
  sessionId: string,
  jsonlPath: string,
  projectPath: string,
  branchName: string
): Promise<void> {
  const indexPath = path.join(projectDir, 'sessions-index.json');

  interface SessionsIndex {
    version: number;
    entries: Array<{
      sessionId: string;
      fullPath: string;
      fileMtime: number;
      firstPrompt: string;
      messageCount: number;
      created: string;
      modified: string;
      gitBranch: string;
      projectPath: string;
      isSidechain: boolean;
    }>;
    originalPath: string;
  }

  let index: SessionsIndex;

  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    index = JSON.parse(raw) as SessionsIndex;
  } catch {
    // Create new index
    index = {
      version: 1,
      entries: [],
      originalPath: projectPath,
    };
  }

  const stat = await fs.stat(jsonlPath);
  const now = new Date().toISOString();

  index.entries.push({
    sessionId,
    fullPath: jsonlPath,
    fileMtime: Math.round(stat.mtimeMs),
    firstPrompt: branchName,
    messageCount: 0,
    created: now,
    modified: now,
    gitBranch: '',
    projectPath,
    isSidechain: false,
  });

  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * Check if a JSONL file has actual conversation messages (user/assistant),
 * not just file-history-snapshot or queue-operation entries.
 */
async function checkHasConversation(jsonlPath: string): Promise<boolean> {
  try {
    const { createReadStream } = await import('node:fs');
    const readline = await import('node:readline');
    const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' || parsed.type === 'assistant' ||
            parsed.type === 'human' || parsed.role === 'user' || parsed.role === 'assistant') {
          rl.close();
          return true;
        }
      } catch {
        // Skip unparseable lines
      }
    }
    rl.close();
  } catch {
    // Can't read file
  }
  return false;
}

/**
 * Auto-generate a branch name: {snapshot-name}-{YYYYMMDD-HHmm}
 */
function generateBranchName(snapshotName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${snapshotName}-${timestamp}`;
}

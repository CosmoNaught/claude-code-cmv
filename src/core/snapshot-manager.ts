import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getVmcSnapshotsDir } from '../utils/paths.js';
import { generateSnapshotId } from '../utils/id.js';
import {
  findSession,
  getLatestSession,
  getSessionJsonlPath,
  isSessionActive,
  extractClaudeVersion,
} from './session-reader.js';
import {
  initialize,
  validateSnapshotName,
  addSnapshot,
  getSnapshot,
} from './metadata-store.js';
import type { VmcSnapshot, VmcSnapshotMeta } from '../types/index.js';

const VMC_VERSION = '1.0.0';

export interface CreateSnapshotParams {
  name: string;
  sessionId?: string;
  latest?: boolean;
  description?: string;
  tags?: string[];
}

export interface CreateSnapshotResult {
  snapshot: VmcSnapshot;
  warnings: string[];
}

/**
 * Create a new snapshot from a Claude Code session.
 */
export async function createSnapshot(params: CreateSnapshotParams): Promise<CreateSnapshotResult> {
  const warnings: string[] = [];

  // Initialize VMC storage
  await initialize();

  // Validate name
  const validation = await validateSnapshotName(params.name);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Find the session
  let session;
  if (params.latest) {
    session = await getLatestSession();
    if (!session) {
      throw new Error('No sessions found. Start a Claude Code session first.');
    }
  } else if (params.sessionId) {
    session = await findSession(params.sessionId);
    if (!session) {
      throw new Error(`Session "${params.sessionId}" not found.`);
    }
  } else {
    throw new Error('Must provide --session <id> or --latest');
  }

  // Check if session is active
  const active = await isSessionActive(session);
  if (active) {
    warnings.push('Session appears to be active. Snapshot may be incomplete.');
  }

  // Check if session has actual conversation content
  if (!session.messageCount || session.messageCount === 0) {
    warnings.push(
      'Session has no conversation messages (only file tracking data). ' +
      'Branching from this snapshot will not work. ' +
      'Use `vmc sessions` to find a session with messages > 0.'
    );
  }

  // Generate snapshot ID and create directory
  const snapshotId = generateSnapshotId();
  const snapshotDir = path.join(getVmcSnapshotsDir(), snapshotId);
  const sessionDir = path.join(snapshotDir, 'session');
  await fs.mkdir(sessionDir, { recursive: true });

  // Copy the JSONL file (JSONL only — not tool-results, subagents, or file-history)
  const jsonlPath = getSessionJsonlPath(session);
  const destJsonlPath = path.join(sessionDir, `${session.sessionId}.jsonl`);

  try {
    await fs.copyFile(jsonlPath, destJsonlPath);
  } catch (err) {
    // Clean up on failure
    await fs.rm(snapshotDir, { recursive: true, force: true });
    throw new Error(`Failed to copy session file: ${(err as Error).message}`);
  }

  // Extract Claude version (best-effort)
  const claudeVersion = await extractClaudeVersion(jsonlPath);

  // Determine parent snapshot (if the source session was a branch of another snapshot)
  let parentSnapshot: string | null = null;
  // Check if the source session ID matches any branch in existing snapshots
  const { readIndex } = await import('./metadata-store.js');
  const index = await readIndex();
  for (const snap of Object.values(index.snapshots)) {
    for (const branch of snap.branches) {
      if (branch.forked_session_id === session.sessionId) {
        parentSnapshot = snap.name;
        break;
      }
    }
    if (parentSnapshot) break;
  }

  const now = new Date().toISOString();

  // Create snapshot record
  const snapshot: VmcSnapshot = {
    id: snapshotId,
    name: params.name,
    description: params.description || '',
    created_at: now,
    source_session_id: session.sessionId,
    source_project_path: session.projectPath || '',
    snapshot_dir: snapshotId,
    message_count: session.messageCount ?? null,
    estimated_tokens: null,
    tags: params.tags || [],
    parent_snapshot: parentSnapshot,
    session_active_at_capture: active,
    branches: [],
  };

  // Write meta.json (for portability)
  const meta: VmcSnapshotMeta = {
    vmc_version: VMC_VERSION,
    snapshot_id: snapshotId,
    name: params.name,
    description: params.description || '',
    created_at: now,
    source_session_id: session.sessionId,
    source_project_path: session.projectPath || '',
    tags: params.tags || [],
    parent_snapshot: parentSnapshot,
    claude_code_version: claudeVersion,
    session_file_format: 'jsonl',
  };

  await fs.writeFile(
    path.join(snapshotDir, 'meta.json'),
    JSON.stringify(meta, null, 2),
    'utf-8'
  );

  // Update index
  await addSnapshot(snapshot);

  return { snapshot, warnings };
}

/**
 * Delete a snapshot and its files.
 */
export async function deleteSnapshot(name: string): Promise<void> {
  const snapshot = await getSnapshot(name);
  if (!snapshot) {
    throw new Error(`Snapshot "${name}" not found.`);
  }

  // Remove snapshot directory
  const snapshotDir = path.join(getVmcSnapshotsDir(), snapshot.snapshot_dir);
  await fs.rm(snapshotDir, { recursive: true, force: true });

  // Remove from index
  const { removeSnapshot } = await import('./metadata-store.js');
  await removeSnapshot(name);
}

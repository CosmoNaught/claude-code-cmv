import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { getCmvSnapshotsDir } from '../utils/paths.js';
import { initialize, getSnapshot, addSnapshot, validateSnapshotName } from './metadata-store.js';
import { generateSnapshotId } from '../utils/id.js';
import type { CmvSnapshot, CmvSnapshotMeta, ImportOptions } from '../types/index.js';

const CMV_VERSION = '1.0.0';

export interface ImportResult {
  name: string;
  snapshotId: string;
  warnings: string[];
}

/**
 * Import a snapshot from a .cmv file.
 */
export async function importSnapshot(filePath: string, options: ImportOptions = {}): Promise<ImportResult> {
  const warnings: string[] = [];

  await initialize();

  // Read and decompress
  const compressed = await fs.readFile(filePath);
  const tarBuffer = zlib.gunzipSync(compressed);

  // Extract tar entries
  const entries = extractTar(tarBuffer);

  // Find meta.json
  const metaEntry = entries.find(e => e.path === 'meta.json');
  if (!metaEntry) {
    throw new Error('Invalid .cmv file: missing meta.json');
  }

  const meta: CmvSnapshotMeta = JSON.parse(metaEntry.content.toString('utf-8'));

  // Determine name
  const name = options.rename || meta.name;

  // Check for conflicts
  const existing = await getSnapshot(name);
  if (existing && !options.force) {
    throw new Error(
      `Snapshot "${name}" already exists. Use --rename <name> or --force to overwrite.`
    );
  }

  if (existing && options.force) {
    // Remove existing snapshot directory
    const existingDir = path.join(getCmvSnapshotsDir(), existing.snapshot_dir);
    await fs.rm(existingDir, { recursive: true, force: true });
  }

  // Validate name if new
  if (!existing) {
    const validation = await validateSnapshotName(name);
    if (!validation.valid && !options.force) {
      throw new Error(validation.error);
    }
  }

  // Generate new snapshot ID
  const snapshotId = generateSnapshotId();
  const snapshotDir = path.join(getCmvSnapshotsDir(), snapshotId);

  // Extract files to snapshot directory
  for (const entry of entries) {
    const destPath = path.join(snapshotDir, entry.path);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, entry.content);
  }

  // Check parent_snapshot — if parent doesn't exist locally, set to null with warning
  let parentSnapshot = meta.parent_snapshot;
  if (parentSnapshot) {
    const parentExists = await getSnapshot(parentSnapshot);
    if (!parentExists) {
      warnings.push(`Parent snapshot "${parentSnapshot}" not found locally. Parent link cleared.`);
      parentSnapshot = null;
    }
  }

  // Version compatibility check
  if (meta.cmv_version && meta.cmv_version !== CMV_VERSION) {
    warnings.push(`Snapshot was created with CMV ${meta.cmv_version} (current: ${CMV_VERSION}).`);
  }

  // Create snapshot record
  const snapshot: CmvSnapshot = {
    id: snapshotId,
    name,
    description: meta.description || '',
    created_at: meta.created_at,
    source_session_id: meta.source_session_id,
    source_project_path: meta.source_project_path,
    snapshot_dir: snapshotId,
    message_count: null,
    estimated_tokens: null,
    tags: meta.tags || [],
    parent_snapshot: parentSnapshot,
    session_active_at_capture: false,
    branches: [],
  };

  await addSnapshot(snapshot);

  return { name, snapshotId, warnings };
}

interface TarEntry {
  path: string;
  content: Buffer;
}

/**
 * Extract files from a tar buffer (minimal POSIX tar parser).
 */
function extractTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);

    // Check for end-of-archive (all zeros)
    if (header.every(b => b === 0)) break;

    // Parse name (0-100)
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100)).toString('utf-8');

    // Parse size (124-136) - octal
    const sizeStr = header.subarray(124, 136).toString('utf-8').replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Parse type flag (156)
    const typeFlag = String.fromCharCode(header[156]!);

    offset += 512;

    if (typeFlag === '0' || typeFlag === '\0') {
      // Regular file
      const content = buffer.subarray(offset, offset + size);
      entries.push({ path: name, content: Buffer.from(content) });
    }

    // Advance past file data (padded to 512-byte boundary)
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;
  }

  return entries;
}

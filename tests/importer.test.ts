import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

const tmpDirRef = { value: '' };

vi.mock('../src/utils/paths.js', () => ({
  getCmvSnapshotsDir: () => path.join(tmpDirRef.value, 'snapshots'),
}));

vi.mock('../src/utils/id.js', () => ({
  generateSnapshotId: () => 'snap_imported1234',
}));

vi.mock('../src/core/metadata-store.js', () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  getSnapshot: vi.fn().mockResolvedValue(null),
  addSnapshot: vi.fn().mockResolvedValue(undefined),
  validateSnapshotName: vi.fn().mockResolvedValue({ valid: true }),
}));

import { importSnapshot } from '../src/core/importer.js';
import { getSnapshot, addSnapshot, validateSnapshotName } from '../src/core/metadata-store.js';

/**
 * Build a minimal .cmv (gzipped tar) buffer for testing.
 */
function createTestCmv(meta: object, sessionContent: string): Buffer {
  const files = [
    { path: 'meta.json', content: Buffer.from(JSON.stringify(meta)) },
    { path: 'session/test.jsonl', content: Buffer.from(sessionContent) },
  ];
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512, 0);
    header.write(file.path, 0, Math.min(file.path.length, 100), 'utf-8');
    header.write('0000644\0', 100, 8, 'utf-8');
    header.write('0001000\0', 108, 8, 'utf-8');
    header.write('0001000\0', 116, 8, 'utf-8');
    const sizeOctal = file.content.length.toString(8).padStart(11, '0');
    header.write(sizeOctal + '\0', 124, 12, 'utf-8');
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
    header.write(mtime + '\0', 136, 12, 'utf-8');
    header.write('        ', 148, 8, 'utf-8');
    header.write('0', 156, 1, 'utf-8');
    header.write('ustar\0', 257, 6, 'utf-8');
    header.write('00', 263, 2, 'utf-8');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');
    blocks.push(header);
    blocks.push(file.content);
    const padding = 512 - (file.content.length % 512);
    if (padding < 512) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const validMeta = {
  cmv_version: '1.0.0',
  snapshot_id: 'snap_original',
  name: 'test-import',
  description: 'A test snapshot',
  created_at: '2025-06-01T00:00:00Z',
  source_session_id: 'sess-orig',
  source_project_path: '/original/project',
  tags: ['test'],
  parent_snapshot: null,
  claude_code_version: '1.0.0',
  session_file_format: 'jsonl',
};

let cmvFilePath: string;

beforeEach(async () => {
  tmpDirRef.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-import-test-'));
  await fs.mkdir(path.join(tmpDirRef.value, 'snapshots'), { recursive: true });

  // Write a valid .cmv file to disk
  cmvFilePath = path.join(tmpDirRef.value, 'test.cmv');
  const cmvBuf = createTestCmv(validMeta, '{"type":"user","content":"imported"}\n');
  await fs.writeFile(cmvFilePath, cmvBuf);

  // Reset mocks
  vi.mocked(getSnapshot).mockResolvedValue(null);
  vi.mocked(addSnapshot).mockResolvedValue(undefined);
  vi.mocked(validateSnapshotName).mockResolvedValue({ valid: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDirRef.value, { recursive: true, force: true });
});

describe('importSnapshot', () => {
  it('imports a valid .cmv file', async () => {
    const result = await importSnapshot(cmvFilePath);

    expect(result.name).toBe('test-import');
    expect(result.snapshotId).toBe('snap_imported1234');
    expect(result.warnings).toEqual([]);
    expect(addSnapshot).toHaveBeenCalled();

    // Verify files were extracted
    const snapDir = path.join(tmpDirRef.value, 'snapshots', 'snap_imported1234');
    const metaRaw = await fs.readFile(path.join(snapDir, 'meta.json'), 'utf-8');
    expect(JSON.parse(metaRaw).name).toBe('test-import');

    const jsonl = await fs.readFile(path.join(snapDir, 'session', 'test.jsonl'), 'utf-8');
    expect(jsonl).toContain('imported');
  });

  it('import with rename option', async () => {
    const result = await importSnapshot(cmvFilePath, { rename: 'renamed-snap' });

    expect(result.name).toBe('renamed-snap');
    expect(addSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renamed-snap' }),
    );
  });

  it('throws on duplicate without force', async () => {
    vi.mocked(getSnapshot).mockResolvedValue({
      id: 'snap_existing',
      name: 'test-import',
      description: '',
      created_at: '2025-01-01T00:00:00Z',
      source_session_id: 'sess-1',
      source_project_path: '/test',
      snapshot_dir: 'snap_existing',
      message_count: 5,
      estimated_tokens: null,
      tags: [],
      parent_snapshot: null,
      session_active_at_capture: false,
      branches: [],
    });

    await expect(importSnapshot(cmvFilePath)).rejects.toThrow(
      'Snapshot "test-import" already exists',
    );
  });

  it('import with force overwrites existing', async () => {
    // Create the existing snapshot directory
    const existingDir = path.join(tmpDirRef.value, 'snapshots', 'snap_existing');
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, 'old.txt'), 'old content');

    vi.mocked(getSnapshot).mockResolvedValue({
      id: 'snap_existing',
      name: 'test-import',
      description: '',
      created_at: '2025-01-01T00:00:00Z',
      source_session_id: 'sess-1',
      source_project_path: '/test',
      snapshot_dir: 'snap_existing',
      message_count: 5,
      estimated_tokens: null,
      tags: [],
      parent_snapshot: null,
      session_active_at_capture: false,
      branches: [],
    });

    const result = await importSnapshot(cmvFilePath, { force: true });

    expect(result.name).toBe('test-import');
    expect(result.snapshotId).toBe('snap_imported1234');

    // Old directory should have been removed
    await expect(fs.access(path.join(existingDir, 'old.txt'))).rejects.toThrow();
  });

  it('warns on missing parent snapshot', async () => {
    const metaWithParent = { ...validMeta, parent_snapshot: 'nonexistent-parent' };
    const cmvBuf = createTestCmv(metaWithParent, '{"type":"user"}\n');
    const cmvPath = path.join(tmpDirRef.value, 'with-parent.cmv');
    await fs.writeFile(cmvPath, cmvBuf);

    // getSnapshot returns null for the parent lookup
    vi.mocked(getSnapshot).mockResolvedValue(null);

    const result = await importSnapshot(cmvPath);

    expect(result.warnings.some(w => w.includes('Parent snapshot') && w.includes('not found locally'))).toBe(true);
  });

  it('warns on version mismatch', async () => {
    const metaOldVersion = { ...validMeta, cmv_version: '0.5.0' };
    const cmvBuf = createTestCmv(metaOldVersion, '{"type":"user"}\n');
    const cmvPath = path.join(tmpDirRef.value, 'old-version.cmv');
    await fs.writeFile(cmvPath, cmvBuf);

    const result = await importSnapshot(cmvPath);

    expect(result.warnings.some(w => w.includes('CMV 0.5.0'))).toBe(true);
  });

  it('throws on malformed .cmv (missing meta.json)', async () => {
    // Build a tar with no meta.json
    const blocks: Buffer[] = [];
    const content = Buffer.from('{"type":"user"}\n');
    const header = Buffer.alloc(512, 0);
    header.write('session/test.jsonl', 0, 18, 'utf-8');
    header.write('0000644\0', 100, 8, 'utf-8');
    header.write('0001000\0', 108, 8, 'utf-8');
    header.write('0001000\0', 116, 8, 'utf-8');
    const sizeOctal = content.length.toString(8).padStart(11, '0');
    header.write(sizeOctal + '\0', 124, 12, 'utf-8');
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
    header.write(mtime + '\0', 136, 12, 'utf-8');
    header.write('        ', 148, 8, 'utf-8');
    header.write('0', 156, 1, 'utf-8');
    header.write('ustar\0', 257, 6, 'utf-8');
    header.write('00', 263, 2, 'utf-8');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');
    blocks.push(header);
    blocks.push(content);
    const padding = 512 - (content.length % 512);
    if (padding < 512) blocks.push(Buffer.alloc(padding, 0));
    blocks.push(Buffer.alloc(1024, 0));

    const malformedCmv = zlib.gzipSync(Buffer.concat(blocks));
    const malformedPath = path.join(tmpDirRef.value, 'malformed.cmv');
    await fs.writeFile(malformedPath, malformedCmv);

    await expect(importSnapshot(malformedPath)).rejects.toThrow('missing meta.json');
  });
});

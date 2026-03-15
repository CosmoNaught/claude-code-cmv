import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

const tmpDirRef = { value: '' };

vi.mock('../src/utils/paths.js', () => ({
  getCmvSnapshotsDir: () => path.join(tmpDirRef.value, 'snapshots'),
}));

vi.mock('../src/core/metadata-store.js', () => ({
  getSnapshot: vi.fn(),
}));

import { exportSnapshot } from '../src/core/exporter.js';
import { getSnapshot } from '../src/core/metadata-store.js';

beforeEach(async () => {
  tmpDirRef.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-export-test-'));

  // Create a snapshot directory structure
  const snapDir = path.join(tmpDirRef.value, 'snapshots', 'snap_test');
  await fs.mkdir(path.join(snapDir, 'session'), { recursive: true });
  await fs.writeFile(path.join(snapDir, 'meta.json'), JSON.stringify({ name: 'test', cmv_version: '1.0.0' }));
  await fs.writeFile(path.join(snapDir, 'session', 'sess.jsonl'), '{"type":"user"}\n');

  vi.mocked(getSnapshot).mockResolvedValue({
    id: 'snap_test',
    name: 'test',
    description: '',
    created_at: '2025-01-01T00:00:00Z',
    source_session_id: 'sess-1',
    source_project_path: '/test',
    snapshot_dir: 'snap_test',
    message_count: 5,
    estimated_tokens: null,
    tags: [],
    parent_snapshot: null,
    session_active_at_capture: false,
    branches: [],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDirRef.value, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

describe('exportSnapshot', () => {
  it('creates a valid gzipped file', async () => {
    const outPath = path.join(tmpDirRef.value, 'output.cmv');
    const result = await exportSnapshot('test', outPath);

    expect(result).toBe(outPath);
    const stat = await fs.stat(outPath);
    expect(stat.size).toBeGreaterThan(0);

    // Verify it starts with gzip magic bytes
    const buf = await fs.readFile(outPath);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it('exported file can be decompressed with zlib.gunzipSync', async () => {
    const outPath = path.join(tmpDirRef.value, 'output.cmv');
    await exportSnapshot('test', outPath);

    const compressed = await fs.readFile(outPath);
    const decompressed = zlib.gunzipSync(compressed);

    // Should be a valid tar (at least 512 bytes for a header)
    expect(decompressed.length).toBeGreaterThanOrEqual(512);
  });

  it('throws on missing snapshot', async () => {
    vi.mocked(getSnapshot).mockResolvedValue(null);

    await expect(exportSnapshot('nonexistent')).rejects.toThrow(
      'Snapshot "nonexistent" not found',
    );
  });

  it('respects custom output path', async () => {
    const customDir = path.join(tmpDirRef.value, 'custom');
    await fs.mkdir(customDir, { recursive: true });
    const customPath = path.join(customDir, 'my-export.cmv');

    const result = await exportSnapshot('test', customPath);

    expect(result).toBe(customPath);
    const stat = await fs.stat(customPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('contains expected files (meta.json + session jsonl)', async () => {
    const outPath = path.join(tmpDirRef.value, 'output.cmv');
    await exportSnapshot('test', outPath);

    const compressed = await fs.readFile(outPath);
    const tar = zlib.gunzipSync(compressed);

    // Parse tar entries to find file names
    const fileNames: string[] = [];
    let offset = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(b => b === 0)) break;

      const nameEnd = header.indexOf(0, 0);
      const name = header.subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100)).toString('utf-8');
      const sizeStr = header.subarray(124, 136).toString('utf-8').replace(/\0/g, '').trim();
      const size = parseInt(sizeStr, 8) || 0;

      if (name) fileNames.push(name);
      offset += 512 + Math.ceil(size / 512) * 512;
    }

    expect(fileNames).toContain('meta.json');
    expect(fileNames.some(n => n.includes('session/') && n.endsWith('.jsonl'))).toBe(true);
  });
});

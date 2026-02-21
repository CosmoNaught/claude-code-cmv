import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { getCmvSnapshotsDir } from '../utils/paths.js';
import { getSnapshot } from './metadata-store.js';

/**
 * Export a snapshot as a .cmv file (tar.gz containing meta.json + session/*.jsonl).
 * Branch data is excluded from export (branches reference local session IDs).
 */
export async function exportSnapshot(name: string, outputPath?: string): Promise<string> {
  const snapshot = await getSnapshot(name);
  if (!snapshot) {
    throw new Error(`Snapshot "${name}" not found.`);
  }

  const snapshotDir = path.join(getCmvSnapshotsDir(), snapshot.snapshot_dir);
  const outFile = outputPath || path.join(process.cwd(), `${name}.cmv`);

  // Build a simple tar archive manually (to avoid external dependency)
  const files = await collectFiles(snapshotDir, snapshotDir);

  const tarBuffer = createTar(files);

  // Gzip the tar
  const gzipped = zlib.gzipSync(tarBuffer);
  await fs.writeFile(outFile, gzipped);

  return outFile;
}

interface TarEntry {
  relativePath: string;
  content: Buffer;
}

async function collectFiles(dir: string, baseDir: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const items = await fs.readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (item.isFile()) {
      const content = await fs.readFile(fullPath);
      entries.push({ relativePath, content });
    } else if (item.isDirectory()) {
      const subEntries = await collectFiles(fullPath, baseDir);
      entries.push(...subEntries);
    }
  }

  return entries;
}

/**
 * Create a simple tar archive buffer from file entries.
 * Implements POSIX ustar format (minimal).
 */
function createTar(files: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    // Create header (512 bytes)
    const header = Buffer.alloc(512, 0);

    // Name (0-100)
    header.write(file.relativePath, 0, Math.min(file.relativePath.length, 100), 'utf-8');

    // Mode (100-108)
    header.write('0000644\0', 100, 8, 'utf-8');

    // UID (108-116)
    header.write('0001000\0', 108, 8, 'utf-8');

    // GID (116-124)
    header.write('0001000\0', 116, 8, 'utf-8');

    // Size (124-136) - octal
    const sizeOctal = file.content.length.toString(8).padStart(11, '0');
    header.write(sizeOctal + '\0', 124, 12, 'utf-8');

    // Mtime (136-148)
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
    header.write(mtime + '\0', 136, 12, 'utf-8');

    // Checksum placeholder (148-156) - spaces
    header.write('        ', 148, 8, 'utf-8');

    // Type flag (156) - '0' for regular file
    header.write('0', 156, 1, 'utf-8');

    // USTAR magic (257-263)
    header.write('ustar\0', 257, 6, 'utf-8');

    // USTAR version (263-265)
    header.write('00', 263, 2, 'utf-8');

    // Calculate checksum
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i]!;
    }
    const checksumOctal = checksum.toString(8).padStart(6, '0');
    header.write(checksumOctal + '\0 ', 148, 8, 'utf-8');

    blocks.push(header);

    // File data, padded to 512-byte blocks
    blocks.push(file.content);
    const padding = 512 - (file.content.length % 512);
    if (padding < 512) {
      blocks.push(Buffer.alloc(padding, 0));
    }
  }

  // End-of-archive marker (two 512-byte zero blocks)
  blocks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(blocks);
}

// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Make the package walk fail so the PATH-based strategies run
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: vi.fn().mockRejectedValue(new Error('ENOENT')),
    realpath: vi.fn(async (p: string) => p),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { resolveCmvBinary, isCmvAutoTrimCommand } from '../../src/utils/paths.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';

describe('resolveCmvBinary fallbacks', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('runs a PATH-found .js entry point through the absolute node binary', async () => {
    vi.mocked(execFileSync).mockReturnValue('/usr/local/bin/cmv\n' as never);
    vi.mocked(fs.realpath).mockResolvedValueOnce('/usr/local/lib/node_modules/cmv/dist/index.js' as never);

    const cmd = await resolveCmvBinary();

    expect(cmd).toBe(`"${process.execPath}" "/usr/local/lib/node_modules/cmv/dist/index.js"`);
    expect(isCmvAutoTrimCommand(`${cmd} auto-trim`)).toBe(true);
  });

  it('quotes a PATH-found native shim as-is', async () => {
    vi.mocked(execFileSync).mockReturnValue('C:\\npm\\cmv.cmd\r\nC:\\npm\\cmv\r\n' as never);

    const cmd = await resolveCmvBinary();

    expect(cmd).toBe('"C:\\npm\\cmv.cmd"');
    expect(isCmvAutoTrimCommand(`${cmd} auto-trim`)).toBe(true);
  });

  it('falls back to bare cmv when it is not on PATH', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });

    expect(await resolveCmvBinary()).toBe('cmv');
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const tmpDirRef = { value: '' };

vi.mock('../src/utils/paths.js', () => ({
  getClaudeSettingsPath: () => path.join(tmpDirRef.value, 'settings.json'),
}));

// Import after mock
const { main, buildHookConfig, isCmvHookEntry } = await import('../src/postinstall.js');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-postinstall-'));
  tmpDirRef.value = tmpDir;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

describe('postinstall', () => {
  describe('buildHookConfig', () => {
    it('returns PreCompact and PostToolUse entries', () => {
      const config = buildHookConfig();
      expect(config).toHaveProperty('PreCompact');
      expect(config).toHaveProperty('PostToolUse');
      expect(config.PreCompact[0].hooks[0].command).toBe('cmv auto-trim');
      expect(config.PostToolUse[0].hooks[0].command).toBe('cmv auto-trim --check-size');
    });
  });

  describe('isCmvHookEntry', () => {
    it('returns true for CMV hook entries', () => {
      expect(isCmvHookEntry({ hooks: [{ command: 'cmv auto-trim' }] })).toBe(true);
      expect(isCmvHookEntry({ hooks: [{ command: 'cmv auto-trim --check-size' }] })).toBe(true);
    });

    it('returns false for non-CMV entries', () => {
      expect(isCmvHookEntry({ hooks: [{ command: 'other-tool' }] })).toBe(false);
    });
  });

  describe('main', () => {
    it('creates hooks in empty settings file', async () => {
      await fs.writeFile(path.join(tmpDir, 'settings.json'), '{}');
      await main();
      const settings = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'));
      expect(settings.hooks.PreCompact).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toHaveLength(1);
    });

    it('creates settings file if it does not exist', async () => {
      await main();
      const settings = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'));
      expect(settings.hooks.PreCompact).toHaveLength(1);
    });

    it('preserves existing non-CMV hooks', async () => {
      const existing = {
        hooks: {
          PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool' }] }],
        },
      };
      await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify(existing));
      await main();
      const settings = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'));
      expect(settings.hooks.PreCompact).toHaveLength(2);
      expect(settings.hooks.PreCompact[0].hooks[0].command).toBe('other-tool');
    });

    it('skips if already installed', async () => {
      // Install once
      await main();
      const first = await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8');
      // Install again
      await main();
      const second = await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8');
      // Content should be identical (skipped)
      expect(JSON.parse(second)).toEqual(JSON.parse(first));
    });

    it('replaces old CMV hooks with new ones', async () => {
      const existing = {
        hooks: {
          PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'cmv auto-trim --old-flag', timeout: 10 }] }],
        },
      };
      await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify(existing));
      await main();
      const settings = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'));
      // Old CMV entry replaced, not duplicated
      const cmvEntries = settings.hooks.PreCompact.filter((e: any) =>
        e.hooks.some((h: any) => h.command.startsWith('cmv auto-trim'))
      );
      expect(cmvEntries).toHaveLength(1);
      expect(cmvEntries[0].hooks[0].command).toBe('cmv auto-trim');
    });
  });
});

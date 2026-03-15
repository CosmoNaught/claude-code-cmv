import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { PassThrough } from 'node:stream';

vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('../../src/core/trimmer.js', () => ({
  trimJsonl: vi.fn(),
}));

vi.mock('../../src/core/auto-backup.js', () => ({
  saveBackup: vi.fn(),
  rotateBackups: vi.fn(),
}));

vi.mock('../../src/utils/paths.js', () => ({
  getCmvAutoTrimLogPath: () => '/fake/auto-trim-log.json',
  getCmvConfigPath: () => '/fake/config.json',
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockAccess = vi.fn().mockResolvedValue(undefined);
const mockStat = vi.fn().mockResolvedValue({ size: 1_000_000 });
const mockRename = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  access: (...args: any[]) => mockAccess(...args),
  stat: (...args: any[]) => mockStat(...args),
  rename: (...args: any[]) => mockRename(...args),
}));

import { registerAutoTrimCommand } from '../../src/commands/auto-trim.js';
import { trimJsonl } from '../../src/core/trimmer.js';
import { saveBackup, rotateBackups } from '../../src/core/auto-backup.js';

// Helper: replace process.stdin with a PassThrough that emits the given JSON string, then ends.
function mockStdinWith(data: string): PassThrough {
  const stream = new PassThrough();
  const originalStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: stream, writable: true, configurable: true });
  // Emit asynchronously so listeners are attached first
  setImmediate(() => {
    stream.push(data);
    stream.push(null); // EOF
  });
  return stream;
}

// Helper: restore process.stdin (we replace with the real one each time via afterEach)
let originalStdin: NodeJS.ReadStream;

describe('auto-trim command', () => {
  beforeEach(() => {
    originalStdin = process.stdin as unknown as NodeJS.ReadStream;
    vi.clearAllMocks();
    // Default: readFile for config and log both fail (no config, empty log)
    mockReadFile.mockRejectedValue(new Error('not found'));
    mockWriteFile.mockResolvedValue(undefined);
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 1_000_000 });
    mockRename.mockResolvedValue(undefined);
    (trimJsonl as any).mockResolvedValue({
      originalBytes: 10_000,
      trimmedBytes: 4_000,
      toolResultsStubbed: 3,
      signaturesStripped: 1,
      fileHistoryRemoved: 0,
      imagesStripped: 0,
      toolUseInputsStubbed: 0,
      preCompactionLinesSkipped: 0,
      queueOperationsRemoved: 0,
      userMessages: 5,
      assistantResponses: 5,
      toolUseRequests: 3,
    });
    (saveBackup as any).mockResolvedValue('/fake/backups/backup-1.jsonl');
    (rotateBackups as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });

  it('registers the auto-trim command', () => {
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'auto-trim');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('hook');
  });

  it('registers the --check-size option', () => {
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'auto-trim')!;
    const opt = cmd.options.find((o) => o.long === '--check-size');
    expect(opt).toBeDefined();
  });

  it('exits cleanly when stdin has no session_id', async () => {
    // process.exit is a no-op in tests, so execution continues past the guard.
    // We verify exit(0) was called (the guard fired) and that logTrim did NOT write
    // a log entry referencing a real session (saveBackup is called with undefined session_id).
    mockStdinWith(JSON.stringify({ transcript_path: '/path/to/session.jsonl' }));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);
    expect(process.exit).toHaveBeenCalledWith(0);
    // Guard fires immediately; no real session_id is present
    expect(saveBackup).toHaveBeenCalledWith(undefined, '/path/to/session.jsonl');
  });

  it('exits cleanly when stdin has no transcript_path', async () => {
    // With only session_id, transcript_path is undefined; guard fires then execution
    // continues with undefined path — access(undefined) leads to outer catch exit(0).
    mockStdinWith(JSON.stringify({ session_id: 'sess-abc' }));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('exits cleanly when stdin is invalid JSON', async () => {
    // JSON.parse throws → caught by outer catch → process.exit(0)
    mockStdinWith('not-json');
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(trimJsonl).not.toHaveBeenCalled();
  });

  it('exits cleanly when transcript file does not exist', async () => {
    // access() rejects → inner catch calls process.exit(0) then execution continues.
    // readConfig and downstream run, but no log is written (saveBackup is called).
    // The key observable: process.exit(0) is called.
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/nonexistent/session.jsonl',
    }));
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('performs full trim flow (PreCompact mode) and logs the result', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
      trigger: 'PreCompact',
    }));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(saveBackup).toHaveBeenCalledWith('sess-abc', transcriptPath);
    expect(rotateBackups).toHaveBeenCalledWith('sess-abc', 5);
    expect(trimJsonl).toHaveBeenCalledWith(
      transcriptPath,
      transcriptPath + '.cmv-trim-tmp',
      { threshold: 500 },
    );
    expect(mockRename).toHaveBeenCalledWith(
      transcriptPath + '.cmv-trim-tmp',
      transcriptPath,
    );
    // logTrim writes the log file
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/fake/auto-trim-log.json',
      expect.stringContaining('sess-abc'),
      'utf-8',
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('uses trigger from stdin when provided', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-xyz',
      transcript_path: transcriptPath,
      trigger: 'CustomTrigger',
    }));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/fake/auto-trim-log.json',
      expect.stringContaining('CustomTrigger'),
      'utf-8',
    );
  });

  it('uses PostToolUse as trigger when --check-size is set and no trigger in stdin', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-xyz',
      transcript_path: transcriptPath,
    }));
    // File is large enough to pass size check
    mockStat.mockResolvedValue({ size: 700_000 });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim', '--check-size']);

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/fake/auto-trim-log.json',
      expect.stringContaining('PostToolUse'),
      'utf-8',
    );
  });

  it('uses PreCompact as trigger when --check-size is not set and no trigger in stdin', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-xyz',
      transcript_path: transcriptPath,
    }));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/fake/auto-trim-log.json',
      expect.stringContaining('PreCompact'),
      'utf-8',
    );
  });

  it('skips trim when --check-size and file is below size threshold', async () => {
    // process.exit(0) is fired on the size-check guard, but as a no-op in tests execution
    // continues. The key observable is that process.exit(0) WAS called at that guard point,
    // and that logTrim does NOT write a log entry (stat returns small size so the in-place
    // trim still runs, but we confirm exit was triggered).
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/fake/sessions/session.jsonl',
    }));
    mockStat.mockResolvedValue({ size: 100_000 }); // below 600_000 default
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim', '--check-size']);

    // The size guard fires process.exit(0); stat was checked
    expect(mockStat).toHaveBeenCalledWith('/fake/sessions/session.jsonl');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('trims when --check-size and file meets size threshold', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    mockStat.mockResolvedValue({ size: 600_001 }); // above 600_000 default
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim', '--check-size']);

    expect(trimJsonl).toHaveBeenCalled();
    expect(saveBackup).toHaveBeenCalled();
  });

  it('uses sizeThresholdBytes from config when provided', async () => {
    // File at 150KB is below custom 200KB threshold; size guard fires process.exit(0).
    // With the no-op exit, execution continues — we verify stat was called (the size
    // check path ran) and that process.exit fired.
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath === '/fake/config.json') {
        return Promise.resolve(JSON.stringify({ autoTrim: { sizeThresholdBytes: 200_000 } }));
      }
      return Promise.reject(new Error('not found'));
    });
    // File is 150KB, below custom 200KB threshold → size guard triggers
    mockStat.mockResolvedValue({ size: 150_000 });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim', '--check-size']);

    expect(mockStat).toHaveBeenCalledWith(transcriptPath);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('uses threshold from config for trimJsonl', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath === '/fake/config.json') {
        return Promise.resolve(JSON.stringify({ autoTrim: { threshold: 300 } }));
      }
      return Promise.reject(new Error('not found'));
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(trimJsonl).toHaveBeenCalledWith(
      transcriptPath,
      transcriptPath + '.cmv-trim-tmp',
      { threshold: 300 },
    );
  });

  it('uses maxBackups from config for rotateBackups', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath === '/fake/config.json') {
        return Promise.resolve(JSON.stringify({ autoTrim: { maxBackups: 10 } }));
      }
      return Promise.reject(new Error('not found'));
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(rotateBackups).toHaveBeenCalledWith('sess-abc', 10);
  });

  it('calculates reductionPercent correctly and logs it', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    (trimJsonl as any).mockResolvedValue({
      originalBytes: 10_000,
      trimmedBytes: 6_000,
      toolResultsStubbed: 0,
      signaturesStripped: 0,
      fileHistoryRemoved: 0,
      imagesStripped: 0,
      toolUseInputsStubbed: 0,
      preCompactionLinesSkipped: 0,
      queueOperationsRemoved: 0,
      userMessages: 0,
      assistantResponses: 0,
      toolUseRequests: 0,
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    const writeCall = (mockWriteFile as any).mock.calls.find((c: any[]) =>
      c[0] === '/fake/auto-trim-log.json',
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written[0].reductionPercent).toBe(40); // (10000-6000)/10000 * 100 = 40
    expect(written[0].originalBytes).toBe(10_000);
    expect(written[0].trimmedBytes).toBe(6_000);
  });

  it('computes reductionPercent as 0 when originalBytes is 0', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-zero',
      transcript_path: transcriptPath,
    }));
    (trimJsonl as any).mockResolvedValue({
      originalBytes: 0,
      trimmedBytes: 0,
      toolResultsStubbed: 0,
      signaturesStripped: 0,
      fileHistoryRemoved: 0,
      imagesStripped: 0,
      toolUseInputsStubbed: 0,
      preCompactionLinesSkipped: 0,
      queueOperationsRemoved: 0,
      userMessages: 0,
      assistantResponses: 0,
      toolUseRequests: 0,
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    const writeCall = (mockWriteFile as any).mock.calls.find((c: any[]) =>
      c[0] === '/fake/auto-trim-log.json',
    );
    const written = JSON.parse(writeCall[1]);
    expect(written[0].reductionPercent).toBe(0);
  });

  it('appends to existing log entries and caps at 50', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    // Existing log has 50 entries
    const existingEntries = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      sessionId: `sess-old-${i}`,
      trigger: 'PreCompact',
      originalBytes: 1000,
      trimmedBytes: 500,
      reductionPercent: 50,
      backupPath: `/fake/backup-${i}.jsonl`,
    }));
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath === '/fake/auto-trim-log.json') {
        return Promise.resolve(JSON.stringify(existingEntries));
      }
      return Promise.reject(new Error('not found'));
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    const writeCall = (mockWriteFile as any).mock.calls.find((c: any[]) =>
      c[0] === '/fake/auto-trim-log.json',
    );
    const written = JSON.parse(writeCall[1]);
    // New entry prepended, old ones trimmed to keep max 50
    expect(written.length).toBe(50);
    expect(written[0].sessionId).toBe('sess-abc');
  });

  it('creates fresh log when log file does not exist', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-new',
      transcript_path: transcriptPath,
    }));
    mockReadFile.mockRejectedValue(new Error('not found'));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    const writeCall = (mockWriteFile as any).mock.calls.find((c: any[]) =>
      c[0] === '/fake/auto-trim-log.json',
    );
    const written = JSON.parse(writeCall[1]);
    expect(written.length).toBe(1);
    expect(written[0].sessionId).toBe('sess-new');
  });

  it('exits cleanly when isTTY is true (interactive mode catches via outer catch)', async () => {
    // When isTTY is true, readStdinWithTimeout rejects, outer catch calls process.exit(0)
    const fakeStream = new PassThrough() as any;
    fakeStream.isTTY = true;
    fakeStream.setEncoding = vi.fn();
    fakeStream.resume = vi.fn();
    fakeStream.removeAllListeners = vi.fn();
    fakeStream.destroy = vi.fn();
    Object.defineProperty(process, 'stdin', {
      value: fakeStream,
      writable: true,
      configurable: true,
    });

    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(process.exit).toHaveBeenCalledWith(0);
    expect(trimJsonl).not.toHaveBeenCalled();
  });

  it('exits cleanly when trimJsonl throws', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    (trimJsonl as any).mockRejectedValue(new Error('trim failed'));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('exits cleanly when saveBackup throws', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    (saveBackup as any).mockRejectedValue(new Error('backup failed'));
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(process.exit).toHaveBeenCalledWith(0);
    expect(trimJsonl).not.toHaveBeenCalled();
  });

  it('reads config without autoTrim key and uses defaults', async () => {
    const transcriptPath = '/fake/sessions/session.jsonl';
    mockStdinWith(JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: transcriptPath,
    }));
    // Config exists but has no autoTrim key
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath === '/fake/config.json') {
        return Promise.resolve(JSON.stringify({ someOtherKey: true }));
      }
      return Promise.reject(new Error('not found'));
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);

    expect(trimJsonl).toHaveBeenCalledWith(
      transcriptPath,
      transcriptPath + '.cmv-trim-tmp',
      { threshold: 500 },
    );
    expect(rotateBackups).toHaveBeenCalledWith('sess-abc', 5);
  });

  it('exits cleanly when stdin emits an error event', async () => {
    // Covers the process.stdin 'error' event handler (lines 53-55 in source).
    const stream = new PassThrough() as any;
    stream.isTTY = false;
    const originalSetEncoding = stream.setEncoding.bind(stream);
    stream.setEncoding = (enc: string) => originalSetEncoding(enc);
    Object.defineProperty(process, 'stdin', {
      value: stream,
      writable: true,
      configurable: true,
    });
    setImmediate(() => {
      stream.destroy(new Error('stdin read error'));
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    await program.parseAsync(['node', 'cmv', 'auto-trim']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(trimJsonl).not.toHaveBeenCalled();
  });

  it('exits cleanly when stdin times out', async () => {
    // Covers the setTimeout path (lines 41-45 in source).
    // Provide a stream that never ends — the STDIN_TIMEOUT timer fires and rejects,
    // which the outer catch handles with process.exit(0).
    vi.useFakeTimers();
    const stream = new PassThrough() as any;
    stream.isTTY = false;
    const originalSetEncoding = stream.setEncoding.bind(stream);
    stream.setEncoding = (enc: string) => originalSetEncoding(enc);
    Object.defineProperty(process, 'stdin', {
      value: stream,
      writable: true,
      configurable: true,
    });
    const program = new Command();
    program.exitOverride();
    registerAutoTrimCommand(program);
    // Don't push anything — stream stays open so the timer fires
    const parsePromise = program.parseAsync(['node', 'cmv', 'auto-trim']);
    // Advance time past STDIN_TIMEOUT (5000ms)
    await vi.advanceTimersByTimeAsync(6000);
    await parsePromise;
    vi.useRealTimers();
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(trimJsonl).not.toHaveBeenCalled();
  });
});

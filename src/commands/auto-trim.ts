// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { trimJsonl } from '../core/trimmer.js';
import { saveBackup, rotateBackups } from '../core/auto-backup.js';
import { getCmvAutoTrimLogPath, getCmvConfigPath } from '../utils/paths.js';
import type { AutoTrimConfig, AutoTrimLogEntry } from '../types/index.js';

const DEFAULT_SIZE_THRESHOLD = 600_000; // ~600KB, roughly 70% of 200k token context
const DEFAULT_TRIM_THRESHOLD = 500;
const DEFAULT_MAX_BACKUPS = 5;
const STDIN_TIMEOUT = 5000;
// Once a session is trimmed and saturated, skip re-trimming until the file has
// grown this much past the last trimmed size. Avoids a full backup + rewrite on
// every tool call for ~0% gain on large, already-trimmed sessions.
const DEFAULT_RETRIM_GROWTH = 65_536; // ~64KB

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  trigger?: string;
  cwd?: string;
}

async function readConfig(): Promise<AutoTrimConfig> {
  try {
    const raw = await fs.readFile(getCmvConfigPath(), 'utf-8');
    const config = JSON.parse(raw);
    return config.autoTrim || {};
  } catch {
    return {};
  }
}

async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error('No stdin input (running interactively)'));
      return;
    }

    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      reject(new Error('Stdin timeout'));
    }, timeoutMs);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    process.stdin.resume();
  });
}

async function logTrim(entry: AutoTrimLogEntry): Promise<void> {
  const logPath = getCmvAutoTrimLogPath();
  let entries: AutoTrimLogEntry[] = [];
  try {
    const raw = await fs.readFile(logPath, 'utf-8');
    entries = JSON.parse(raw);
  } catch {
    // Start fresh
  }

  entries.unshift(entry);
  // Keep last 50 entries
  if (entries.length > 50) entries = entries.slice(0, 50);

  await fs.writeFile(logPath, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * The trimmed size from this session's most recent trim, or null if none.
 * Used to skip re-trimming a saturated file that has barely grown since.
 */
async function getLastTrimmedBytes(sessionId: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(getCmvAutoTrimLogPath(), 'utf-8');
    const entries: AutoTrimLogEntry[] = JSON.parse(raw);
    const last = entries.find(e => e.sessionId === sessionId);
    return last ? last.trimmedBytes : null;
  } catch {
    return null;
  }
}

export function registerAutoTrimCommand(program: Command): void {
  program
    .command('auto-trim')
    .description('Internal command called by Claude Code hooks')
    .option('--check-size', 'Only trim if file exceeds size threshold (PostToolUse mode)')
    .action(async (opts: { checkSize?: boolean }) => {
      try {
        const stdinRaw = await readStdinWithTimeout(STDIN_TIMEOUT);
        const input: HookInput = JSON.parse(stdinRaw);

        if (!input.session_id || !input.transcript_path) {
          process.exit(0);
        }

        const transcriptPath = input.transcript_path;

        // Verify file exists
        try {
          await fs.access(transcriptPath);
        } catch {
          process.exit(0);
        }

        const config = await readConfig();

        // PostToolUse mode: check file size first
        if (opts.checkSize) {
          const sizeThreshold = config.sizeThresholdBytes ?? DEFAULT_SIZE_THRESHOLD;
          const stat = await fs.stat(transcriptPath);
          if (stat.size < sizeThreshold) {
            process.exit(0); // Under threshold, skip trim (~1ms)
          }
          // Skip re-trim churn: if this session was already trimmed and the file
          // has barely grown since, re-trimming would back up and rewrite the
          // whole file for ~0% gain. Only re-trim once it grows past the margin.
          const lastTrimmed = await getLastTrimmedBytes(input.session_id);
          const growthMargin = config.reTrimGrowthBytes ?? DEFAULT_RETRIM_GROWTH;
          if (lastTrimmed !== null && stat.size - lastTrimmed < growthMargin) {
            process.exit(0);
          }
        }

        // Save backup before trimming
        const backupPath = await saveBackup(input.session_id, transcriptPath);
        await rotateBackups(input.session_id, config.maxBackups ?? DEFAULT_MAX_BACKUPS);

        // Trim in-place via temp file
        const tmpPath = transcriptPath + '.cmv-trim-tmp';
        const metrics = await trimJsonl(transcriptPath, tmpPath, {
          threshold: config.threshold ?? DEFAULT_TRIM_THRESHOLD,
          stubWriteInputs: config.stubWriteInputs ?? false,
        });

        // Atomic replace
        await fs.rename(tmpPath, transcriptPath);

        // Log the trim
        const reductionPercent = metrics.originalBytes > 0
          ? Math.round(((metrics.originalBytes - metrics.trimmedBytes) / metrics.originalBytes) * 100)
          : 0;

        await logTrim({
          timestamp: new Date().toISOString(),
          sessionId: input.session_id,
          trigger: input.trigger ?? (opts.checkSize ? 'PostToolUse' : 'PreCompact'),
          originalBytes: metrics.originalBytes,
          trimmedBytes: metrics.trimmedBytes,
          reductionPercent,
          backupPath,
        });

        process.exit(0);
      } catch {
        // Hook must not break Claude Code
        process.exit(0);
      }
    });
}

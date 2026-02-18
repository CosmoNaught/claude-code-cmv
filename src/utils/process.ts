import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Find the claude CLI executable path.
 * On Windows, resolves to the full path to avoid needing shell: true.
 */
export function getClaudeCliPath(configPath?: string): string {
  if (configPath) return configPath;

  if (process.platform === 'win32') {
    // Try common Windows locations
    const candidates = [
      path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
      'claude.exe',
    ];

    for (const candidate of candidates) {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' });
        return candidate;
      } catch {
        // Try next
      }
    }
  }

  return 'claude';
}

/**
 * Spawn the claude CLI with given arguments in interactive mode.
 * Uses async spawn so the event loop keeps running — critical on Windows
 * after the Ink TUI, where spawnSync inherits a console handle whose input
 * mode hasn't fully settled yet (keyboard input never reaches the child).
 */
export function spawnClaudeInteractive(args: string[], cliPath?: string, cwd?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const cmd = getClaudeCliPath(cliPath);

    // On Windows, if stdin has been destroyed (e.g. after Ink TUI teardown),
    // stdio: 'inherit' fails because the underlying console handle was closed.
    // Open a fresh handle to CONIN$ (the Windows console input buffer) so the
    // child gets a valid stdin.  stdout/stderr are unaffected.
    let stdinFd: number | undefined;
    let stdio: 'inherit' | [number, 'inherit', 'inherit'] = 'inherit';

    if (process.platform === 'win32' && process.stdin.destroyed) {
      try {
        stdinFd = openSync('CONIN$', 'r+');
        stdio = [stdinFd, 'inherit', 'inherit'];
      } catch {
        // CONIN$ unavailable (no console attached) — fall back to inherit
      }
    }

    const child = spawn(cmd, args, {
      stdio,
      ...(cwd ? { cwd } : {}),
    });

    const cleanup = () => {
      if (stdinFd !== undefined) {
        try { closeSync(stdinFd); } catch { /* already closed */ }
        stdinFd = undefined;
      }
    };

    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code) => { cleanup(); resolve(code); });
  });
}

/**
 * Spawn the claude CLI and capture output (non-interactive).
 */
export function spawnClaudeCapture(args: string[], cliPath?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const cmd = getClaudeCliPath(cliPath);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

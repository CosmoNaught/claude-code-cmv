import { spawn, execFileSync } from 'node:child_process';
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
 * Spawn the claude CLI with given arguments in interactive mode (stdio: inherit).
 * Returns a promise that resolves with the exit code when the process exits.
 */
export function spawnClaudeInteractive(args: string[], cliPath?: string, cwd?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const cmd = getClaudeCliPath(cliPath);
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      ...(cwd ? { cwd } : {}),
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code));
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

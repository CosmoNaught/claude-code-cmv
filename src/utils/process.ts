import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, accessSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Resolve the full absolute path of `claude` via the shell's `command -v`.
 * Returns undefined if resolution fails.
 */
function resolveFullPath(name: string): string | undefined {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${name}`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the claude CLI executable path.
 * Always resolves to a full absolute path when possible, because
 * spawn() without shell:true can fail to find bare command names
 * when called with a different cwd.
 */
export function getClaudeCliPath(configPath?: string): string {
  if (configPath) return configPath;

  // Try bare name first — resolve to full path to avoid spawn() issues
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    // Bare name works, but resolve the full path for robustness
    const fullPath = resolveFullPath('claude');
    return fullPath || 'claude';
  } catch {
    // Not found via PATH — try known locations
  }

  const candidates = process.platform === 'win32'
    ? [
        path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
        'claude.exe',
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try next
    }
  }

  // Last resort: return bare name and let spawn() fail with a clear error
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

    // Validate cwd exists — spawn() throws a confusing ENOENT
    // (with the command name, not the directory) when cwd is invalid.
    // Fall back to current directory so the session can still be resumed.
    let effectiveCwd = cwd;
    if (effectiveCwd) {
      try {
        accessSync(effectiveCwd);
      } catch {
        effectiveCwd = undefined; // fall back to process.cwd()
      }
    }

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
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
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

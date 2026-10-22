// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn, execFileSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync, accessSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const execAsync = promisify(exec);

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

/** A terminal emulator we know how to open a new window in. */
interface TerminalPreset {
  /** Executable name on Linux (also used for `which` detection). */
  bin: string;
  /** macOS application name for `open -na <App> --args ...`. */
  macApp?: string;
  /** Arguments that open a window titled `title` running `inner`. */
  args: (title: string, cwd: string | undefined, inner: string[]) => string[];
}

const TERMINAL_PRESETS: Record<string, TerminalPreset> = {
  'x-terminal-emulator': { bin: 'x-terminal-emulator', args: (t, _c, inner) => ['-T', t, '-e', ...inner] },
  kitty: { bin: 'kitty', macApp: 'kitty', args: (t, _c, inner) => ['-T', t, ...inner] },
  ptyxis: { bin: 'ptyxis', args: (_t, _c, inner) => ['--new-window', '--', ...inner] },
  'gnome-terminal': { bin: 'gnome-terminal', args: (t, _c, inner) => [`--title=${t}`, '--', ...inner] },
  alacritty: { bin: 'alacritty', macApp: 'Alacritty', args: (t, _c, inner) => ['-T', t, '-e', ...inner] },
  wezterm: { bin: 'wezterm', macApp: 'WezTerm', args: (_t, c, inner) => ['start', ...(c ? ['--cwd', c] : []), '--', ...inner] },
  foot: { bin: 'foot', args: (t, _c, inner) => ['-T', t, ...inner] },
  ghostty: { bin: 'ghostty', macApp: 'Ghostty', args: (t, _c, inner) => [`--title=${t}`, '-e', ...inner] },
  konsole: { bin: 'konsole', args: (t, _c, inner) => ['-p', `tabtitle=${t}`, '-e', ...inner] },
  'xfce4-terminal': { bin: 'xfce4-terminal', args: (t, _c, inner) => ['-T', t, '-x', ...inner] },
  xterm: { bin: 'xterm', args: (t, _c, inner) => ['-T', t, '-e', ...inner] },
};

/** Presets that only exist on macOS (handled via AppleScript). */
const MAC_SCRIPT_PRESETS = new Set(['terminal', 'iterm']);

/** Every value `cmv config terminal <name>` accepts besides a custom template. */
export const TERMINAL_PRESET_NAMES = [...MAC_SCRIPT_PRESETS, ...Object.keys(TERMINAL_PRESETS)];

/**
 * Guess the terminal cmv itself is running in, so new windows open in the
 * same emulator the user already chose. Returns a preset name or undefined.
 */
export function detectCurrentTerminal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const termProgram = (env.TERM_PROGRAM || '').toLowerCase();
  if (termProgram === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty';
  if (termProgram === 'iterm.app') return 'iterm';
  if (termProgram === 'wezterm') return 'wezterm';
  if (termProgram === 'apple_terminal') return 'terminal';
  if (env.KITTY_WINDOW_ID) return 'kitty';
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return 'alacritty';
  if (env.PTYXIS_VERSION) return 'ptyxis';
  if (env.KONSOLE_VERSION) return 'konsole';
  return undefined;
}

/**
 * The POSIX shell script a new window runs: cd into the project, then
 * replace the shell with claude. Doing the cd ourselves means the window
 * lands in the right folder even when the terminal ignores the caller's cwd
 * (gnome-terminal, ptyxis and konsole all open in $HOME otherwise).
 */
export function buildResumeScript(cmd: string, sessionId: string, cwd?: string): string {
  const cdPart = cwd ? `cd ${shellEscape(cwd)} && ` : '';
  return `${cdPart}exec ${shellEscape(cmd)} --resume ${shellEscape(sessionId)}`;
}

/**
 * Expand a custom terminal template from `cmv config terminal`.
 * Placeholders are shell-quoted: {cmd} (sh -c '<cd && claude --resume>'),
 * {cwd}, {title}, {session}, {claude}.
 */
export function expandTerminalTemplate(
  template: string,
  vars: { script: string; cwd?: string; title: string; sessionId: string; claude: string }
): string {
  const values: Record<string, string> = {
    cmd: `sh -c ${shellEscape(vars.script)}`,
    cwd: shellEscape(vars.cwd || '.'),
    title: shellEscape(vars.title),
    session: shellEscape(vars.sessionId),
    claude: shellEscape(vars.claude),
  };
  return template.replace(/\{(cmd|cwd|title|session|claude)\}/g, (_m, key: string) => values[key]!);
}

function commandExists(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launchDetached(bin: string, args: string[], cwd?: string): void {
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    ...(cwd ? { cwd } : {}),
  });
  child.on('error', () => { /* terminal vanished between detection and launch */ });
  child.unref();
}

function launchMacAppleScript(preset: string, script: string, title: string): void {
  const quoted = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = preset === 'iterm'
    ? [
        'tell application "iTerm"',
        '  set newWindow to (create window with default profile)',
        `  tell current session of newWindow to write text "${quoted}"`,
        'end tell',
      ]
    : [
        'tell application "Terminal"',
        `  do script "${quoted}"`,
        `  set custom title of front window to "${title.replace(/"/g, '\\"')}"`,
        'end tell',
      ];
  launchDetached('osascript', lines.flatMap(l => ['-e', l]));
}

/**
 * Open a new terminal window running `claude --resume <id>` in `cwd`.
 *
 * `terminal` (from `cmv config terminal`) is either a preset name
 * (see TERMINAL_PRESET_NAMES) or a custom command template containing
 * {cmd}. Without it we use the terminal cmv is running in, then fall back to
 * the platform default (Terminal.app on macOS, first installed on Linux).
 */
export function spawnClaudeInNewWindow(sessionId: string, cliPath?: string, cwd?: string, title?: string, terminal?: string): void {
  const cmd = getClaudeCliPath(cliPath);
  const windowTitle = title || `claude ${sessionId.substring(0, 8)}`;

  let effectiveCwd = cwd;
  if (effectiveCwd) {
    try { accessSync(effectiveCwd); } catch { effectiveCwd = undefined; }
  }

  if (process.platform === 'win32') {
    // `start "title"` opens a new console window; cmd /k keeps it open.
    // /D sets the new window's directory explicitly.
    const dirPart = effectiveCwd ? ` /D "${effectiveCwd}"` : '';
    if (terminal && terminal.includes('{')) {
      exec(terminal
        .replace(/\{cmd\}/g, `"${cmd}" --resume ${sessionId}`)
        .replace(/\{cwd\}/g, `"${effectiveCwd || '.'}"`)
        .replace(/\{title\}/g, `"${windowTitle}"`)
        .replace(/\{session\}/g, sessionId)
        .replace(/\{claude\}/g, `"${cmd}"`), { cwd: effectiveCwd });
      return;
    }
    exec(`start "${windowTitle}"${dirPart} cmd /k "${cmd}" --resume ${sessionId}`, { cwd: effectiveCwd });
    return;
  }

  const script = buildResumeScript(cmd, sessionId, effectiveCwd);
  const inner = ['sh', '-c', script];

  // Custom template: run through the shell exactly as configured
  if (terminal && terminal.includes('{')) {
    exec(expandTerminalTemplate(terminal, {
      script, cwd: effectiveCwd, title: windowTitle, sessionId, claude: cmd,
    }), { cwd: effectiveCwd });
    return;
  }

  const requested = terminal?.toLowerCase() || detectCurrentTerminal();

  if (process.platform === 'darwin') {
    const preset = requested ? TERMINAL_PRESETS[requested] : undefined;
    if (preset?.macApp) {
      launchDetached('open', ['-na', preset.macApp, '--args', ...preset.args(windowTitle, effectiveCwd, inner)], effectiveCwd);
      return;
    }
    launchMacAppleScript(requested === 'iterm' ? 'iterm' : 'terminal', script, windowTitle);
    return;
  }

  // Linux: preferred terminal first, then common emulators in order
  const order = [
    ...(requested && TERMINAL_PRESETS[requested] ? [requested] : []),
    ...Object.keys(TERMINAL_PRESETS),
  ];
  for (const name of order) {
    const preset = TERMINAL_PRESETS[name]!;
    if (commandExists(preset.bin)) {
      launchDetached(preset.bin, preset.args(windowTitle, effectiveCwd, inner), effectiveCwd);
      return;
    }
  }
  // Fallback: detached spawn without a new window
  launchDetached(cmd, ['--resume', sessionId], effectiveCwd);
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''").replace(/^/, "'").replace(/$/, "'");
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

/**
 * Query the OS process list for all running `claude --resume <id>` sessions.
 * Returns the set of session IDs that have a live Claude process.
 * Single async call per poll — cheap enough for 3s intervals.
 */
export async function getRunningSessionIds(): Promise<Set<string>> {
  try {
    const cmd = process.platform === 'win32'
      ? 'wmic process where "CommandLine like \'%--resume%\'" get CommandLine 2>nul'
      : 'ps -eo args 2>/dev/null';

    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    return parseRunningSessionIds(stdout);
  } catch {
    return new Set();
  }
}

/**
 * Extract session IDs from a process listing (one command line per line),
 * counting only processes that are claude itself. Terminal emulators,
 * `cmd /k` wrappers and macOS apps that outlive their window also carry
 * `--resume <id>` in their arguments and would otherwise keep a closed
 * session marked busy forever.
 */
export function parseRunningSessionIds(listing: string): Set<string> {
  const ids = new Set<string>();
  const resume = /--resume\s+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  for (const line of listing.split(/\r?\n/)) {
    const match = resume.exec(line);
    if (!match) continue;
    const [exe, script] = commandTokens(line.slice(0, match.index));
    const base = (p?: string) => (p || '').split(/[\\/]/).pop()!.toLowerCase();
    const isClaude = (p?: string) => /^claude(\.exe)?$/.test(base(p));
    const isNode = /^(node|bun)(\.exe)?$/.test(base(exe));
    if (isClaude(exe) || (isNode && (isClaude(script) || /claude/i.test(script || '')))) {
      ids.add(match[1]!.toLowerCase());
    }
  }
  return ids;
}

/** Split the start of a command line into its first two tokens, honouring double quotes. */
function commandTokens(cmdline: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while (tokens.length < 2 && (m = re.exec(cmdline)) !== null) {
    tokens.push(m[1] ?? m[2]!);
  }
  return tokens;
}

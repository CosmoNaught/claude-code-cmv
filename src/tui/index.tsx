import { fork } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardResult } from './Dashboard.js';

export type { DashboardResult };

/**
 * Launch the interactive TUI dashboard in a forked child process.
 *
 * Running Ink in a separate process avoids a Windows-specific problem:
 * Ink puts stdin into raw mode and starts a background libuv reader thread.
 * In the same process, there is no reliable way to fully stop that thread
 * AND keep the console input handle valid for a subsequent child spawn
 * (destroy() stops the thread but closes the handle; pause() keeps the
 * handle but the thread keeps consuming keystrokes).
 *
 * By forking, the worker owns its own stdin handle.  When the worker
 * exits, the OS frees everything.  The parent's stdin is never touched,
 * so spawning Claude with stdio:'inherit' works correctly.
 */
export async function launchDashboard(): Promise<DashboardResult> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, 'tui-worker.js');

  return new Promise<DashboardResult>((resolve) => {
    let resolved = false;

    const child = fork(workerPath, [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (msg) => {
      if (!resolved) {
        resolved = true;
        resolve(msg as DashboardResult);
      }
    });

    child.on('error', () => {
      if (!resolved) {
        resolved = true;
        resolve({ action: 'quit' });
      }
    });

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        resolve({ action: 'quit' });
      }
    });
  });
}

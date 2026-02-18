/**
 * TUI worker — runs in a forked child process so that Ink's stdin
 * manipulation (raw mode, libuv reader thread on Windows) never
 * touches the parent process's console handle.  When this process
 * exits, all handles are freed by the OS and the parent can safely
 * spawn Claude with stdio: 'inherit'.
 */
import React from 'react';
import { render } from 'ink';
import { Dashboard } from './Dashboard.js';
import type { DashboardResult } from './Dashboard.js';

async function main() {
  let result: DashboardResult = { action: 'quit' };

  const { waitUntilExit } = render(
    <Dashboard onExit={(r) => { result = r; }} />
  );

  await waitUntilExit().catch(() => {});

  // Send result to parent via IPC
  if (process.send) {
    process.send(result);
  }

  process.exit(0);
}

main().catch(() => process.exit(1));

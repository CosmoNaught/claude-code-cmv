import React from 'react';
import { render } from 'ink';
import { Dashboard } from './Dashboard.js';
import type { DashboardResult } from './Dashboard.js';

export type { DashboardResult };

export async function launchDashboard(): Promise<DashboardResult> {
  let dashboardResult: DashboardResult = { action: 'quit' };

  const { unmount, waitUntilExit } = render(
    <Dashboard onExit={(result) => { dashboardResult = result; }} />
  );

  // Wait for Ink to fully unmount and restore the terminal before returning.
  await waitUntilExit().catch(() => {});

  // Explicitly unmount in case app.exit() didn't fully tear down Ink internals.
  try { unmount(); } catch { /* already unmounted */ }

  // Restore terminal after Ink — Ink puts stdin in raw mode and uses a
  // background libuv thread (on Windows) to read from the console input
  // handle. pause() alone does NOT stop that thread, so it keeps consuming
  // keyboard input from the OS buffer, starving any child process spawned
  // with stdio: 'inherit'. destroy() fully tears down the readable stream
  // and stops the reader thread, but does NOT close the underlying OS file
  // descriptor (fd 0), so the child can still inherit it.
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.removeAllListeners();
  process.stdin.destroy();

  // Give the event loop a tick so libuv flushes any pending cleanup.
  await new Promise(resolve => setTimeout(resolve, 50));

  return dashboardResult;
}

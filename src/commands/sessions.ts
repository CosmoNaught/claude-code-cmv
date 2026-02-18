import { Command } from 'commander';
import { listAllSessions, listSessionsByProject } from '../core/session-reader.js';
import { readIndex } from '../core/metadata-store.js';
import { formatTable, formatRelativeTime, truncate, dim, info } from '../utils/display.js';
import { handleError } from '../utils/errors.js';
import type { SessionsOptions } from '../types/index.js';
import chalk from 'chalk';

/**
 * Build lookup maps from VMC index:
 *   sessionId → "branch: branchName (from snapshotName)"
 *   sessionId → "snap: snapshotName"
 */
async function buildVmcLookup(): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();
  try {
    const index = await readIndex();
    for (const snap of Object.values(index.snapshots)) {
      // Mark the source session as snapshotted
      lookup.set(snap.source_session_id, `snap: ${snap.name}`);
      // Mark each branch's forked session
      for (const branch of snap.branches) {
        lookup.set(branch.forked_session_id, `branch: ${branch.name}`);
      }
    }
  } catch {
    // VMC index doesn't exist yet — no annotations
  }
  return lookup;
}

export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List discoverable Claude Code sessions')
    .option('-p, --project <path>', 'Filter by project path')
    .option('--sort <field>', 'Sort by: date (default), size', 'date')
    .option('--all', 'Include empty sessions (file-tracking only, 0 messages)')
    .option('--json', 'Output as JSON')
    .action(async (opts: SessionsOptions & { all?: boolean }) => {
      try {
        let sessions = opts.project
          ? await listSessionsByProject(opts.project)
          : await listAllSessions();

        // Filter out empty file-tracking sessions by default
        const totalCount = sessions.length;
        if (!opts.all) {
          sessions = sessions.filter(s => s.messageCount && s.messageCount > 0);
        }
        const hiddenCount = totalCount - sessions.length;

        if (sessions.length === 0) {
          if (hiddenCount > 0) {
            info(`No conversation sessions found (${hiddenCount} empty file-tracking session(s) hidden). Use --all to show them.`);
          } else {
            info('No sessions found. Start a Claude Code session first.');
          }
          return;
        }

        // Sort
        if (opts.sort === 'size') {
          sessions.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
        }

        // Build VMC annotation lookup
        const vmcLookup = await buildVmcLookup();

        if (opts.json) {
          console.log(JSON.stringify(sessions.map(s => ({
            sessionId: s.sessionId,
            project: s.projectPath,
            summary: s.summary,
            messageCount: s.messageCount,
            created: s.created,
            modified: s.modified,
            vmc: vmcLookup.get(s.sessionId) || null,
          })), null, 2));
          return;
        }

        // Table output
        const headers = ['Session ID', 'Project', 'Msgs', 'Modified', 'VMC', 'Summary'];
        const rows = sessions.map(s => [
          s.sessionId.substring(0, 8) + '…',
          truncate(s.projectPath || '—', 20),
          String(s.messageCount ?? '—'),
          s.modified ? formatRelativeTime(s.modified) : '—',
          truncate(vmcLookup.get(s.sessionId) || '', 20),
          truncate(s.summary || s.firstPrompt || '—', 35),
        ]);

        const hiddenNote = hiddenCount > 0 ? dim(` (${hiddenCount} empty hidden, use --all)`) : '';
        console.log(chalk.bold(`Found ${sessions.length} session(s):`) + hiddenNote + '\n');
        console.log(formatTable(headers, rows));
        console.log(dim('\nUse full session ID with: vmc snapshot <name> --session <id>'));

        // Also print full IDs for easy copy
        console.log(dim('\nFull session IDs:'));
        for (const s of sessions) {
          const vmcTag = vmcLookup.get(s.sessionId);
          const suffix = vmcTag ? `  ${vmcTag}` : '';
          console.log(dim(`  ${s.sessionId}  ${truncate(s.projectPath || '', 30)}${suffix}`));
        }
      } catch (err) {
        handleError(err);
      }
    });
}

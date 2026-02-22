import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { useProjects } from './hooks/useProjects.js';
import { useTreeNavigation } from './hooks/useTreeNavigation.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { ProjectPane } from './ProjectPane.js';
import { TreePane } from './TreePane.js';
import { DetailPane } from './DetailPane.js';
import { ActionBar } from './ActionBar.js';
import { BranchPrompt } from './BranchPrompt.js';
import { MultiBranchPrompt } from './MultiBranchPrompt.js';
import { SessionViewer } from './SessionViewer.js';
import { SnapshotPrompt } from './SnapshotPrompt.js';
import { ConfirmDelete } from './ConfirmDelete.js';
import { ImportPrompt } from './ImportPrompt.js';
import { createSnapshot } from '../core/snapshot-manager.js';
import { createBranch, deleteBranch } from '../core/branch-manager.js';
import { deleteSnapshot } from '../core/snapshot-manager.js';
import { deleteSession } from '../core/session-reader.js';
import { exportSnapshot } from '../core/exporter.js';
import { importSnapshot } from '../core/importer.js';
import { initialize } from '../core/metadata-store.js';
import type { TreeNode, ClaudeSessionEntry } from '../types/index.js';
import * as path from 'node:path';

export type DashboardAction = 'quit' | 'branch-launch' | 'trim-launch' | 'resume';

export interface DashboardResult {
  action: DashboardAction;
  snapshotName?: string;
  branchName?: string;
  sessionId?: string;
  cwd?: string;
}

interface DashboardProps {
  onExit: (result: DashboardResult) => void;
}

type Mode = 'navigate' | 'branch-prompt' | 'branch-launch-prompt' | 'trim-prompt' | 'snapshot-prompt' | 'confirm-delete' | 'confirm-delete-branch' | 'confirm-delete-session' | 'import-prompt' | 'multi-branch-prompt';
type FocusPane = 'projects' | 'tree';

interface StatusMessage {
  text: string;
  type: 'success' | 'error' | 'info';
}

export function Dashboard({ onExit }: DashboardProps) {
  const app = useApp();
  const { columns, rows } = useTerminalSize();
  const { projects, loading, error: loadError, refresh } = useProjects();
  const [mode, setMode] = useState<Mode>('navigate');
  const [focus, setFocus] = useState<FocusPane>('tree');
  const [projectIndex, setProjectIndex] = useState(0);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [watchedSession, setWatchedSession] = useState<{
    sessionId: string;
    branchName: string;
    snapshotName: string;
    jsonlPath: string;
  } | null>(null);

  // Clamp project index
  const clampedProjectIndex = Math.min(projectIndex, Math.max(0, projects.length - 1));
  useEffect(() => {
    if (clampedProjectIndex !== projectIndex) setProjectIndex(clampedProjectIndex);
  }, [clampedProjectIndex, projectIndex]);

  const selectedProject = projects[clampedProjectIndex] || null;

  // Build combined tree nodes for selected project: snapshots + separator + sessions
  const combinedRoots = useMemo((): TreeNode[] => {
    if (!selectedProject) return [];
    const items: TreeNode[] = [];

    // Add snapshots under a separator header
    if (selectedProject.snapshotRoots.length > 0) {
      items.push({ type: 'separator', name: 'Snapshots', children: [] });
      for (const root of selectedProject.snapshotRoots) {
        items.push(root);
      }
    }

    // Add sessions under a separator header
    if (selectedProject.sessions.length > 0) {
      items.push({ type: 'separator', name: 'Sessions', children: [] });
      for (const session of selectedProject.sessions) {
        items.push({
          type: 'session',
          name: session.sessionId,
          session,
          children: [],
        });
      }
    }

    return items;
  }, [selectedProject]);

  const isNavigating = mode === 'navigate';
  const treeFocused = focus === 'tree' && isNavigating;
  const nav = useTreeNavigation(combinedRoots, treeFocused);

  // Initialize CMV storage on mount
  useEffect(() => {
    initialize().then(() => setInitialized(true));
  }, []);

  // Auto-dismiss status messages
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  // Keyboard handler for navigate mode
  useInput((input, key) => {
    if (!isNavigating) return;

    // Escape: dismiss session viewer
    if (key.escape && watchedSession) {
      setWatchedSession(null);
      return;
    }

    // Tab to switch focus between panes
    if (key.tab) {
      setFocus(prev => prev === 'projects' ? 'tree' : 'projects');
      return;
    }

    // Quit
    if (input === 'q') {
      onExit({ action: 'quit' });
      app.exit();
      return;
    }

    // Project pane navigation
    if (focus === 'projects') {
      if (input === 'j' || key.downArrow) {
        setProjectIndex(prev => Math.min(prev + 1, projects.length - 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setProjectIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      // Right arrow or Enter moves focus to tree pane
      if (key.rightArrow || key.return) {
        setFocus('tree');
        return;
      }
      return; // other keys ignored in project pane
    }

    // Tree pane actions (focus === 'tree')
    // Left arrow at tree pane root goes back to project pane
    if (key.leftArrow && nav.selectedNode && nav.selectedNode.children.length === 0) {
      // Only go back if the node can't collapse further
      setFocus('projects');
      return;
    }

    // Branch from selected snapshot
    if (input === 'b' && nav.selectedNode?.type === 'snapshot') {
      setMode('branch-prompt');
      return;
    }

    // Snapshot — if session is selected, snapshot that session; otherwise snapshot latest
    if (input === 's') {
      setMode('snapshot-prompt');
      return;
    }

    // Delete selected snapshot or branch
    if (input === 'd' && nav.selectedNode?.type === 'snapshot') {
      setMode('confirm-delete');
      return;
    }
    if (input === 'd' && nav.selectedNode?.type === 'branch') {
      setMode('confirm-delete-branch');
      return;
    }
    if (input === 'd' && nav.selectedNode?.type === 'session') {
      setMode('confirm-delete-session');
      return;
    }

    // Export selected snapshot
    if (input === 'e' && nav.selectedNode?.type === 'snapshot') {
      handleExport();
      return;
    }

    // Trim from selected snapshot
    if (input === 't' && nav.selectedNode?.type === 'snapshot') {
      setMode('trim-prompt');
      return;
    }

    // Multi-branch from selected snapshot
    if (input === 'm' && nav.selectedNode?.type === 'snapshot') {
      setMode('multi-branch-prompt');
      return;
    }

    // Import
    if (input === 'i') {
      setMode('import-prompt');
      return;
    }

    // Enter: watch an existing branch session in the viewer
    if (key.return && nav.selectedNode?.type === 'branch' && nav.selectedNode.branch) {
      const branchSession = selectedProject?.sessions.find(
        s => s.sessionId === nav.selectedNode!.branch!.forked_session_id
      );
      const parentName = findParentSnapshotName(nav.selectedNode) || 'unknown';
      if (branchSession) {
        setWatchedSession({
          sessionId: branchSession.sessionId,
          branchName: nav.selectedNode.name,
          snapshotName: parentName,
          jsonlPath: path.join(branchSession._projectDir, `${branchSession.sessionId}.jsonl`),
        });
      }
      return;
    }

    // o: open branch session externally
    if (input === 'o' && nav.selectedNode?.type === 'branch' && nav.selectedNode.branch) {
      onExit({
        action: 'resume',
        sessionId: nav.selectedNode.branch.forked_session_id,
        cwd: selectedProject?.path,
      });
      app.exit();
      return;
    }

    // Enter: resume a session directly
    if (key.return && nav.selectedNode?.type === 'session' && nav.selectedNode.session) {
      onExit({
        action: 'resume',
        sessionId: nav.selectedNode.session.sessionId,
        cwd: selectedProject?.path,
      });
      app.exit();
      return;
    }

    // Enter: branch and launch for snapshots (prompts for name first)
    if (key.return && nav.selectedNode?.type === 'snapshot') {
      setMode('branch-launch-prompt');
      return;
    }
  }, { isActive: isNavigating });

  const handleBranch = useCallback(async (branchName: string) => {
    setMode('navigate');
    if (!nav.selectedNode?.snapshot) return;
    try {
      await createBranch({
        snapshotName: nav.selectedNode.name,
        branchName,
        noLaunch: true,
        trim: true,
      });
      setStatus({ text: `Branch "${branchName}" created`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Branch failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, refresh]);

  const handleBranchAndLaunch = useCallback((branchName: string) => {
    if (!nav.selectedNode?.snapshot) return;
    onExit({
      action: 'branch-launch',
      snapshotName: nav.selectedNode.name,
      branchName,
    });
    app.exit();
  }, [nav.selectedNode, onExit, app]);

  const handleSnapshot = useCallback(async (name: string) => {
    setMode('navigate');
    try {
      // If a session is selected, snapshot that specific session
      if (nav.selectedNode?.type === 'session' && nav.selectedNode.session) {
        await createSnapshot({
          name,
          sessionId: nav.selectedNode.session.sessionId,
        });
      } else {
        await createSnapshot({ name, latest: true });
      }
      setStatus({ text: `Snapshot "${name}" created`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Snapshot failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, refresh]);

  const handleDelete = useCallback(async () => {
    setMode('navigate');
    if (!nav.selectedNode?.snapshot) return;
    const name = nav.selectedNode.name;
    try {
      await deleteSnapshot(name);
      setStatus({ text: `Snapshot "${name}" deleted`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Delete failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, refresh]);

  // Find the parent snapshot name for a branch node by searching the tree
  const findParentSnapshotName = useCallback((branchNode: TreeNode): string | null => {
    for (const root of combinedRoots) {
      if (root.type === 'snapshot') {
        for (const child of root.children) {
          if (child.type === 'branch' && child.name === branchNode.name) {
            return root.name;
          }
        }
        // Check nested snapshots
        const stack = [...root.children.filter(c => c.type === 'snapshot')];
        while (stack.length > 0) {
          const node = stack.pop()!;
          for (const child of node.children) {
            if (child.type === 'branch' && child.name === branchNode.name) {
              return node.name;
            }
            if (child.type === 'snapshot') stack.push(child);
          }
        }
      }
    }
    return null;
  }, [combinedRoots]);

  const handleDeleteBranch = useCallback(async () => {
    setMode('navigate');
    if (!nav.selectedNode?.branch) return;
    const branchName = nav.selectedNode.name;
    const snapshotName = findParentSnapshotName(nav.selectedNode);
    if (!snapshotName) {
      setStatus({ text: `Cannot find parent snapshot for branch "${branchName}"`, type: 'error' });
      return;
    }
    try {
      await deleteBranch(snapshotName, branchName);
      setStatus({ text: `Branch "${branchName}" deleted`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Delete failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, findParentSnapshotName, refresh]);

  const handleDeleteSession = useCallback(async () => {
    setMode('navigate');
    if (!nav.selectedNode?.session) return;
    const session = nav.selectedNode.session;
    const sessionId = session.sessionId;
    // _projectDir is present at runtime (from listAllSessions) but not in the base type
    const entry = session as typeof session & { _projectDir: string };
    try {
      await deleteSession(entry);
      setStatus({ text: `Session ${sessionId.substring(0, 8)}… deleted`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Delete failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, refresh]);

  const handleExport = useCallback(async () => {
    if (!nav.selectedNode?.snapshot) return;
    const name = nav.selectedNode.name;
    try {
      const outputPath = await exportSnapshot(name);
      setStatus({ text: `Exported to ${outputPath}`, type: 'success' });
    } catch (err) {
      setStatus({ text: `Export failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode]);

  const handleImport = useCallback(async (filePath: string) => {
    setMode('navigate');
    try {
      const result = await importSnapshot(filePath);
      setStatus({ text: `Imported "${result.name}"`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Import failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [refresh]);

  const handleTrim = useCallback(async (branchName: string) => {
    setMode('navigate');
    if (!nav.selectedNode?.snapshot) return;
    try {
      const result = await createBranch({
        snapshotName: nav.selectedNode.name,
        branchName,
        noLaunch: true,
        trim: true,
      });
      const m = result.trimMetrics;
      const msg = m
        ? `Trimmed branch "${branchName}" created (${formatBytes(m.originalBytes)} → ${formatBytes(m.trimmedBytes)})`
        : `Trimmed branch "${branchName}" created`;
      setStatus({ text: msg, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Trim failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, refresh]);

  const handleMultiBranch = useCallback(async (branchNames: string[]) => {
    setMode('navigate');
    if (!nav.selectedNode?.snapshot) return;
    const snapshotName = nav.selectedNode.name;
    let created = 0;
    for (const name of branchNames) {
      try {
        await createBranch({
          snapshotName,
          branchName: name,
          noLaunch: true,
          trim: true,
          orientationMessage: `You are continuing from a branched snapshot called "${name}", forked from "${snapshotName}". Focus area: ${name}.`,
        });
        created++;
      } catch {
        // Continue with remaining branches
      }
    }
    setStatus({ text: `Created ${created} branch${created !== 1 ? 'es' : ''} from "${snapshotName}"`, type: 'success' });
    refresh();
  }, [nav.selectedNode, refresh]);

  const cancelPrompt = useCallback(() => {
    setMode('navigate');
  }, []);

  // Layout calculations — two columns: left (projects + details) and right (tree / viewer)
  const leftWidth = Math.max(20, Math.floor(columns * 0.35));
  const rightWidth = columns - leftWidth;
  const bodyHeight = rows - 4;
  const projectHeight = Math.min(Math.max(5, projects.length + 3), Math.floor(bodyHeight * 0.35));
  const detailHeight = bodyHeight - projectHeight;

  if (loading || !initialized) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Text color="cyan">Loading...</Text>
        </Box>
      </Box>
    );
  }

  if (loadError) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Text color="red">Error: {loadError}</Text>
        </Box>
      </Box>
    );
  }

  // Determine snapshot prompt label based on selection
  const snapshotPromptLabel = nav.selectedNode?.type === 'session'
    ? `Snapshot session ${nav.selectedNode.session?.sessionId.substring(0, 8)}…`
    : undefined;

  return (
    <Box flexDirection="column" height={rows}>
      {/* Main body: two columns */}
      <Box flexGrow={1} height={bodyHeight}>
        {/* Left column: projects + details */}
        <Box flexDirection="column" width={leftWidth}>
          <ProjectPane
            projects={projects}
            selectedIndex={clampedProjectIndex}
            focused={focus === 'projects' && isNavigating}
            height={projectHeight}
            width={leftWidth}
          />
          {watchedSession ? (
            <SessionViewer
              sessionId={watchedSession.sessionId}
              branchName={watchedSession.branchName}
              snapshotName={watchedSession.snapshotName}
              jsonlPath={watchedSession.jsonlPath}
              width={leftWidth}
              height={detailHeight}
            />
          ) : (
            <DetailPane
              node={nav.selectedNode}
              width={leftWidth}
              sessions={selectedProject?.sessions}
            />
          )}
        </Box>
        {/* Right column: snapshots / sessions tree */}
        <TreePane
          flatNodes={nav.flatNodes}
          selectedIndex={nav.selectedIndex}
          focused={focus === 'tree' && isNavigating}
          height={bodyHeight}
          width={rightWidth}
          projectName={selectedProject?.path}
          sessions={selectedProject?.sessions}
        />
      </Box>

      {/* Bottom bar */}
      {mode === 'navigate' && <ActionBar selectedNode={nav.selectedNode} watching={!!watchedSession} />}
      {mode === 'branch-prompt' && nav.selectedNode && (
        <BranchPrompt
          snapshotName={nav.selectedNode.name}
          onSubmit={handleBranch}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'branch-launch-prompt' && nav.selectedNode && (
        <BranchPrompt
          snapshotName={nav.selectedNode.name}
          onSubmit={handleBranchAndLaunch}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'snapshot-prompt' && (
        <SnapshotPrompt
          onSubmit={handleSnapshot}
          onCancel={cancelPrompt}
          label={snapshotPromptLabel}
        />
      )}
      {mode === 'confirm-delete' && nav.selectedNode?.snapshot && (
        <ConfirmDelete
          name={nav.selectedNode.name}
          branchCount={nav.selectedNode.snapshot.branches.length}
          onConfirm={handleDelete}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'confirm-delete-branch' && nav.selectedNode?.branch && (
        <ConfirmDelete
          name={nav.selectedNode.name}
          branchCount={0}
          onConfirm={handleDeleteBranch}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'confirm-delete-session' && nav.selectedNode?.session && (
        <ConfirmDelete
          name={nav.selectedNode.session.sessionId.substring(0, 8) + '…'}
          branchCount={0}
          onConfirm={handleDeleteSession}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'trim-prompt' && nav.selectedNode && (
        <BranchPrompt
          snapshotName={nav.selectedNode.name}
          onSubmit={handleTrim}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'multi-branch-prompt' && nav.selectedNode && (
        <MultiBranchPrompt
          snapshotName={nav.selectedNode.name}
          onSubmit={handleMultiBranch}
          onCancel={cancelPrompt}
        />
      )}
      {mode === 'import-prompt' && (
        <ImportPrompt onSubmit={handleImport} onCancel={cancelPrompt} />
      )}

      {/* Status message */}
      {status && (
        <Box paddingX={1}>
          <Text
            color={status.type === 'success' ? 'green' : status.type === 'error' ? 'red' : 'blue'}
          >
            {status.type === 'success' ? '✓' : status.type === 'error' ? '✗' : 'ℹ'} {status.text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

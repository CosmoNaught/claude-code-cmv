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
import { SnapshotPrompt } from './SnapshotPrompt.js';
import { ConfirmDelete } from './ConfirmDelete.js';
import { ImportPrompt } from './ImportPrompt.js';
import { createSnapshot } from '../core/snapshot-manager.js';
import { createBranch, deleteBranch } from '../core/branch-manager.js';
import { deleteSnapshot } from '../core/snapshot-manager.js';
import { exportSnapshot } from '../core/exporter.js';
import { importSnapshot } from '../core/importer.js';
import { initialize } from '../core/metadata-store.js';
import type { TreeNode } from '../types/index.js';

export type DashboardAction = 'quit' | 'branch-launch' | 'resume';

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

type Mode = 'navigate' | 'branch-prompt' | 'branch-launch-prompt' | 'snapshot-prompt' | 'confirm-delete' | 'confirm-delete-branch' | 'import-prompt';
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

    // Add snapshot roots for this project
    for (const root of selectedProject.snapshotRoots) {
      items.push(root);
    }

    // Add sessions as flat nodes below a separator
    if (selectedProject.sessions.length > 0) {
      if (items.length > 0) {
        items.push({ type: 'separator', name: 'Sessions', children: [] });
      }
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

  // Initialize VMC storage on mount
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

    // Export selected snapshot
    if (input === 'e' && nav.selectedNode?.type === 'snapshot') {
      handleExport();
      return;
    }

    // Import
    if (input === 'i') {
      setMode('import-prompt');
      return;
    }

    // Enter: resume an existing branch session
    if (key.return && nav.selectedNode?.type === 'branch' && nav.selectedNode.branch) {
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

  const cancelPrompt = useCallback(() => {
    setMode('navigate');
  }, []);

  // Layout calculations — three columns
  const projectWidth = Math.max(16, Math.floor(columns * 0.2));
  const treeWidth = Math.max(20, Math.floor(columns * 0.35));
  const detailWidth = columns - projectWidth - treeWidth;
  const bodyHeight = rows - 4;

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
      {/* Main body: three panes */}
      <Box flexGrow={1} height={bodyHeight}>
        <ProjectPane
          projects={projects}
          selectedIndex={clampedProjectIndex}
          focused={focus === 'projects' && isNavigating}
          height={bodyHeight}
          width={projectWidth}
        />
        <TreePane
          flatNodes={nav.flatNodes}
          selectedIndex={nav.selectedIndex}
          focused={focus === 'tree' && isNavigating}
          height={bodyHeight}
          width={treeWidth}
          projectName={selectedProject?.path}
        />
        <DetailPane
          node={nav.selectedNode}
          width={detailWidth}
        />
      </Box>

      {/* Bottom bar */}
      {mode === 'navigate' && <ActionBar selectedNode={nav.selectedNode} />}
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

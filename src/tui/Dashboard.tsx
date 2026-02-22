import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { spawnClaudeInNewWindow, getRunningSessionIds } from '../utils/process.js';
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';

export type DashboardAction = 'quit';

export interface DashboardResult {
  action: DashboardAction;
}

interface DashboardProps {
  onExit: (result: DashboardResult) => void;
}

type Mode = 'navigate' | 'branch-prompt' | 'branch-launch-prompt' | 'snapshot-prompt' | 'confirm-delete' | 'confirm-delete-branch' | 'confirm-delete-session' | 'import-prompt' | 'multi-branch-prompt';
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

    if (selectedProject.snapshotRoots.length > 0) {
      items.push({ type: 'separator', name: 'Snapshots', children: [] });
      for (const root of selectedProject.snapshotRoots) {
        items.push(root);
      }
    }

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

  // Hybrid status detection: process list + file growth + JSONL last-line type
  // - No Claude process running → idle (grey)
  // - Process running + file growing → busy (amber)
  // - Process running + file stable → read last JSONL line:
  //     last line type "assistant" → active (green, Claude finished, waiting for input)
  //     anything else → busy (amber, Claude is thinking/working)
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, 'active' | 'busy' | 'idle'>>({});
  const prevSizesRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!selectedProject) return;

    // Read the last complete line of a file (cheap: only reads tail bytes)
    const readLastLineType = async (filePath: string, fileSize: number): Promise<string | null> => {
      try {
        // Read last 4KB — more than enough for any single JSONL line's type field
        const chunkSize = Math.min(4096, fileSize);
        const fh = await fsPromises.open(filePath, 'r');
        const buf = Buffer.alloc(chunkSize);
        await fh.read(buf, 0, chunkSize, Math.max(0, fileSize - chunkSize));
        await fh.close();
        const text = buf.toString('utf-8');
        // Find last complete line (ends with \n, take the one before trailing newline)
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        const lastLine = lines[lines.length - 1];
        if (!lastLine) return null;
        // Quick regex to extract top-level "type" without parsing full JSON
        const match = lastLine.match(/"type"\s*:\s*"([^"]+)"/);
        return match?.[1] || null;
      } catch {
        return null;
      }
    };

    const checkSession = async (id: string, jsonlPath: string, isRunning: boolean): Promise<'active' | 'busy' | 'idle'> => {
      const prevSizes = prevSizesRef.current;

      if (!isRunning) {
        delete prevSizes[id];
        return 'idle';
      }

      try {
        const stat = await fsPromises.stat(jsonlPath);
        const currentSize = stat.size;
        const prevSize = prevSizes[id];
        prevSizes[id] = currentSize;

        // File grew since last poll → definitely busy
        if (prevSize !== undefined && currentSize !== prevSize) {
          return 'busy';
        }

        // File stable — check last JSONL entry type to distinguish
        // "Claude thinking mid-response" from "Claude waiting for input"
        const lastType = await readLastLineType(jsonlPath, currentSize);

        // If file has never grown while we've been watching (prevSize === undefined
        // means first poll, or same size as first seen), Claude hasn't done anything
        // yet in this polling session — treat as active (waiting for input)
        if (prevSize === undefined) {
          return 'active';
        }

        if (lastType === 'assistant') {
          return 'active'; // Claude finished responding → waiting for input
        }
        return 'busy'; // user/progress/tool_result → Claude is still working
      } catch {
        return 'active';
      }
    };

    const check = async () => {
      const runningIds = await getRunningSessionIds();
      const statuses: Record<string, 'active' | 'busy' | 'idle'> = {};

      for (const session of selectedProject.sessions) {
        const id = session.sessionId;
        const jsonlPath = path.join(session._projectDir, `${id}.jsonl`);
        statuses[id] = await checkSession(id, jsonlPath, runningIds.has(id));
      }

      // Also check branches — their forked_session_id may not be in the sessions list
      const projectDir = selectedProject.sessions[0]?._projectDir;
      if (projectDir) {
        for (const root of selectedProject.snapshotRoots) {
          const stack = [root];
          while (stack.length > 0) {
            const node = stack.pop()!;
            if (node.type === 'branch' && node.branch) {
              const bid = node.branch.forked_session_id;
              if (!statuses[bid]) {
                const jsonlPath = path.join(projectDir, `${bid}.jsonl`);
                statuses[bid] = await checkSession(bid, jsonlPath, runningIds.has(bid));
              }
            }
            for (const child of node.children) stack.push(child);
          }
        }
      }

      setSessionStatuses(statuses);
    };
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [selectedProject]);

  // Keyboard handler
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
      if (key.rightArrow || key.return) {
        setFocus('tree');
        return;
      }
      return;
    }

    // Tree pane actions (focus === 'tree')
    if (key.leftArrow && nav.selectedNode && nav.selectedNode.children.length === 0) {
      setFocus('projects');
      return;
    }

    // Branch from selected snapshot
    if (input === 'b' && nav.selectedNode?.type === 'snapshot') {
      setMode('branch-prompt');
      return;
    }

    // Snapshot
    if (input === 's') {
      setMode('snapshot-prompt');
      return;
    }

    // Delete
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

    // Export
    if (input === 'e' && nav.selectedNode?.type === 'snapshot') {
      handleExport();
      return;
    }

    // Multi-branch
    if (input === 'm' && nav.selectedNode?.type === 'snapshot') {
      setMode('multi-branch-prompt');
      return;
    }

    // Import
    if (input === 'i') {
      setMode('import-prompt');
      return;
    }

    // Refresh
    if (input === 'r') {
      refresh();
      setStatus({ text: 'Refreshed', type: 'info' });
      return;
    }

    // Enter on branch: open claude --resume in a new terminal window
    if (key.return && nav.selectedNode?.type === 'branch' && nav.selectedNode.branch) {
      const sid = nav.selectedNode.branch.forked_session_id;
      if (sessionStatuses[sid] && sessionStatuses[sid] !== 'idle') {
        setStatus({ text: `Session already running`, type: 'error' });
        return;
      }
      const parentSnap = findParentSnapshotName(nav.selectedNode) || '?';
      const projectName = selectedProject?.path.split(/[\\/]/).pop() || '';
      const title = `${projectName}/${parentSnap}/${nav.selectedNode.name}`;
      spawnClaudeInNewWindow(sid, undefined, selectedProject?.path, title);
      setStatus({ text: `Opened "${nav.selectedNode.name}" in new window`, type: 'info' });
      return;
    }

    // Enter on session: open claude --resume in a new terminal window
    if (key.return && nav.selectedNode?.type === 'session' && nav.selectedNode.session) {
      const sid = nav.selectedNode.session.sessionId;
      if (sessionStatuses[sid] && sessionStatuses[sid] !== 'idle') {
        setStatus({ text: `Session already running`, type: 'error' });
        return;
      }
      const projectName = selectedProject?.path.split(/[\\/]/).pop() || '';
      const title = `${projectName}/${sid.substring(0, 10)}`;
      spawnClaudeInNewWindow(sid, undefined, selectedProject?.path, title);
      setStatus({ text: `Opened session ${sid.substring(0, 8)}… in new window`, type: 'info' });
      return;
    }

    // Enter on snapshot: branch and launch
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

  const handleBranchAndLaunch = useCallback(async (branchName: string) => {
    setMode('navigate');
    if (!nav.selectedNode?.snapshot) return;
    try {
      const result = await createBranch({
        snapshotName: nav.selectedNode.name,
        branchName,
        noLaunch: true,
        trim: true,
      });
      const projectName = selectedProject?.path.split(/[\\/]/).pop() || '';
      const title = `${projectName}/${nav.selectedNode.name}/${branchName}`;
      spawnClaudeInNewWindow(result.forkedSessionId, undefined, selectedProject?.path, title);
      setStatus({ text: `Branch "${branchName}" opened in new window`, type: 'success' });
      refresh();
    } catch (err) {
      setStatus({ text: `Branch failed: ${(err as Error).message}`, type: 'error' });
    }
  }, [nav.selectedNode, selectedProject, refresh]);

  const handleSnapshot = useCallback(async (name: string) => {
    setMode('navigate');
    try {
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

  const findParentSnapshotName = useCallback((branchNode: TreeNode): string | null => {
    for (const root of combinedRoots) {
      if (root.type === 'snapshot') {
        for (const child of root.children) {
          if (child.type === 'branch' && child.name === branchNode.name) {
            return root.name;
          }
        }
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
    const entry = session as typeof session & { _projectDir: string };
    try {
      await deleteSession(entry);
      setStatus({ text: `Session ${sessionId.substring(0, 8)}... deleted`, type: 'success' });
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

  // Layout calculations
  const leftWidth = Math.floor(columns / 2);
  const rightWidth = columns - leftWidth;
  const bodyHeight = rows - 4;

  // Fixed 50/50 height split: both rows stay the same stable size
  const topBoxHeight = Math.floor(bodyHeight / 2);
  const bottomBoxHeight = bodyHeight - topBoxHeight;

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

  const snapshotPromptLabel = nav.selectedNode?.type === 'session'
    ? `Snapshot session ${nav.selectedNode.session?.sessionId.substring(0, 8)}...`
    : undefined;

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1} height={bodyHeight}>
        {/* Left column: projects + details */}
        <Box flexDirection="column" width={leftWidth}>
          <ProjectPane
            projects={projects}
            selectedIndex={clampedProjectIndex}
            focused={focus === 'projects' && isNavigating}
            height={topBoxHeight}
            width={leftWidth}
          />
          <DetailPane
            node={nav.selectedNode}
            width={leftWidth}
            height={bottomBoxHeight}
            sessions={selectedProject?.sessions}
            project={selectedProject}
            focusPane={focus}
            sessionStatuses={sessionStatuses}
          />
        </Box>
        {/* Right column: snapshots + sessions */}
        <TreePane
          flatNodes={nav.flatNodes}
          selectedIndex={nav.selectedIndex}
          focused={focus === 'tree' && isNavigating}
          snapshotBoxHeight={topBoxHeight}
          sessionBoxHeight={bottomBoxHeight}
          width={rightWidth}
          sessionStatuses={sessionStatuses}
        />
      </Box>

      {/* Bottom bar */}
      {mode === 'navigate' && <ActionBar selectedNode={nav.selectedNode} focusPane={focus} />}
      {mode === 'branch-prompt' && nav.selectedNode && (
        <BranchPrompt snapshotName={nav.selectedNode.name} onSubmit={handleBranch} onCancel={cancelPrompt} />
      )}
      {mode === 'branch-launch-prompt' && nav.selectedNode && (
        <BranchPrompt snapshotName={nav.selectedNode.name} onSubmit={handleBranchAndLaunch} onCancel={cancelPrompt} />
      )}
      {mode === 'snapshot-prompt' && (
        <SnapshotPrompt onSubmit={handleSnapshot} onCancel={cancelPrompt} label={snapshotPromptLabel} />
      )}
      {mode === 'confirm-delete' && nav.selectedNode?.snapshot && (
        <ConfirmDelete name={nav.selectedNode.name} branchCount={nav.selectedNode.snapshot.branches.length} onConfirm={handleDelete} onCancel={cancelPrompt} />
      )}
      {mode === 'confirm-delete-branch' && nav.selectedNode?.branch && (
        <ConfirmDelete name={nav.selectedNode.name} branchCount={0} onConfirm={handleDeleteBranch} onCancel={cancelPrompt} />
      )}
      {mode === 'confirm-delete-session' && nav.selectedNode?.session && (
        <ConfirmDelete name={nav.selectedNode.session.sessionId.substring(0, 8) + '...'} branchCount={0} onConfirm={handleDeleteSession} onCancel={cancelPrompt} />
      )}
      {mode === 'multi-branch-prompt' && nav.selectedNode && (
        <MultiBranchPrompt snapshotName={nav.selectedNode.name} onSubmit={handleMultiBranch} onCancel={cancelPrompt} />
      )}
      {mode === 'import-prompt' && (
        <ImportPrompt onSubmit={handleImport} onCancel={cancelPrompt} />
      )}

      {status && (
        <Box paddingX={1}>
          <Text color={status.type === 'success' ? 'green' : status.type === 'error' ? 'red' : 'blue'}>
            {status.type === 'success' ? '✓' : status.type === 'error' ? '✗' : 'i'} {status.text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

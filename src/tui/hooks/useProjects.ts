import { useState, useEffect, useCallback } from 'react';
import { listAllSessions } from '../../core/session-reader.js';
import { readIndex } from '../../core/metadata-store.js';
import { buildTree } from '../../core/tree-builder.js';
import type { ClaudeSessionEntry, TreeNode, VmcIndex } from '../../types/index.js';

export interface ProjectInfo {
  path: string;            // human-readable project path
  dirPath: string;         // actual directory path (_projectDir)
  sessions: (ClaudeSessionEntry & { _projectDir: string })[];
  snapshotRoots: TreeNode[];  // tree roots for snapshots from this project
}

export interface ProjectsState {
  projects: ProjectInfo[];
  index: VmcIndex | null;
  allRoots: TreeNode[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProjects(): ProjectsState {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [index, setIndex] = useState<VmcIndex | null>(null);
  const [allRoots, setAllRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sessions, idx, roots] = await Promise.all([
        listAllSessions(),
        readIndex(),
        buildTree(),
      ]);

      setIndex(idx);
      setAllRoots(roots);

      // Normalize project path for use as Map key (case-insensitive on Windows)
      const normalizeKey = (p: string): string =>
        process.platform === 'win32' ? p.toLowerCase() : p;

      // Group sessions by project path
      const projectMap = new Map<string, ProjectInfo>();

      for (const session of sessions) {
        // Skip empty sessions
        if (!session.messageCount || session.messageCount === 0) continue;

        const projectPath = session.projectPath || session._projectDir;
        const key = normalizeKey(projectPath);
        let project = projectMap.get(key);
        if (!project) {
          project = {
            path: projectPath,
            dirPath: session._projectDir,
            sessions: [],
            snapshotRoots: [],
          };
          projectMap.set(key, project);
        }
        project.sessions.push(session);
      }

      // Assign snapshot tree roots to projects based on source_project_path
      for (const root of roots) {
        if (root.type === 'snapshot' && root.snapshot) {
          const projPath = root.snapshot.source_project_path;
          const key = normalizeKey(projPath);
          let project = projectMap.get(key);
          if (!project) {
            // Snapshot's project has no active sessions — still show it
            project = {
              path: projPath,
              dirPath: '',
              sessions: [],
              snapshotRoots: [],
            };
            projectMap.set(key, project);
          }
          project.snapshotRoots.push(root);
        }
      }

      // Sort projects: most recent activity first
      const sorted = Array.from(projectMap.values()).sort((a, b) => {
        const aTime = getLatestTime(a);
        const bTime = getLatestTime(b);
        return bTime - aTime;
      });

      setProjects(sorted);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { projects, index, allRoots, loading, error, refresh: load };
}

function getLatestTime(project: ProjectInfo): number {
  let latest = 0;
  for (const s of project.sessions) {
    const t = s.modified ? new Date(s.modified).getTime() : 0;
    if (t > latest) latest = t;
  }
  for (const r of project.snapshotRoots) {
    if (r.snapshot?.created_at) {
      const t = new Date(r.snapshot.created_at).getTime();
      if (t > latest) latest = t;
    }
  }
  return latest;
}

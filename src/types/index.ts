// ============================================================
// Claude Code Session Types (mirrors sessions-index.json)
// ============================================================

export interface ClaudeSessionEntry {
  sessionId: string;
  fullPath: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

export interface ClaudeSessionsIndex {
  version: number;
  entries: ClaudeSessionEntry[];
  originalPath?: string;
}

// ============================================================
// VMC Types
// ============================================================

export interface VmcBranch {
  name: string;
  forked_session_id: string;
  created_at: string;
}

export interface VmcSnapshot {
  id: string;
  name: string;
  description: string;
  created_at: string;
  source_session_id: string;
  source_project_path: string;
  snapshot_dir: string;
  message_count: number | null;
  estimated_tokens: number | null;
  tags: string[];
  parent_snapshot: string | null;
  session_active_at_capture: boolean;
  branches: VmcBranch[];
}

export interface VmcIndex {
  version: string;
  snapshots: Record<string, VmcSnapshot>;
}

export interface VmcSnapshotMeta {
  vmc_version: string;
  snapshot_id: string;
  name: string;
  description: string;
  created_at: string;
  source_session_id: string;
  source_project_path: string;
  tags: string[];
  parent_snapshot: string | null;
  claude_code_version: string | null;
  session_file_format: string;
}

export interface VmcConfig {
  claude_cli_path?: string;
  default_project?: string;
}

// ============================================================
// Command Option Types
// ============================================================

export interface SnapshotOptions {
  session?: string;
  latest?: boolean;
  description?: string;
  tags?: string;
}

export interface BranchOptions {
  name?: string;
  noLaunch?: boolean;
  dryRun?: boolean;
}

export interface SessionsOptions {
  project?: string;
  sort?: 'date' | 'size';
  json?: boolean;
}

export interface ListOptions {
  tag?: string;
  sort?: 'date' | 'name' | 'branches';
  json?: boolean;
}

export interface TreeOptions {
  depth?: number;
  json?: boolean;
}

export interface DeleteOptions {
  force?: boolean;
}

export interface ExportOptions {
  output?: string;
}

export interface ImportOptions {
  rename?: string;
  force?: boolean;
}

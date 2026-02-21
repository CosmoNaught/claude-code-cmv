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
// CMV Types
// ============================================================

export interface CmvBranch {
  name: string;
  forked_session_id: string;
  created_at: string;
}

export interface CmvSnapshot {
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
  branches: CmvBranch[];
}

export interface CmvIndex {
  version: string;
  snapshots: Record<string, CmvSnapshot>;
}

export interface CmvSnapshotMeta {
  cmv_version: string;
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

export interface CmvConfig {
  claude_cli_path?: string;
  default_project?: string;
}

export interface TreeNode {
  type: 'snapshot' | 'branch' | 'session' | 'separator';
  name: string;
  snapshot?: CmvSnapshot;
  branch?: CmvBranch;
  session?: ClaudeSessionEntry;
  children: TreeNode[];
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
  trim?: boolean;
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

// ============================================================
// Trim Types
// ============================================================

export interface TrimMetrics {
  originalBytes: number;
  trimmedBytes: number;
  toolResultsStubbed: number;
  signaturesStripped: number;
  fileHistoryRemoved: number;
  imagesStripped: number;
  toolUseInputsStubbed: number;
  preCompactionLinesSkipped: number;
  queueOperationsRemoved: number;
  userMessages: number;
  assistantResponses: number;
  toolUseRequests: number;
}

export interface SessionAnalysis {
  totalBytes: number;
  estimatedTokens: number;
  contextLimit: number;
  contextUsedPercent: number;
  breakdown: {
    toolResults: { bytes: number; count: number; percent: number };
    thinkingSignatures: { bytes: number; count: number; percent: number };
    fileHistory: { bytes: number; count: number; percent: number };
    conversation: { bytes: number; percent: number };
    toolUseRequests: { bytes: number; count: number; percent: number };
    other: { bytes: number; percent: number };
  };
  messageCount: { user: number; assistant: number; toolResults: number };
}

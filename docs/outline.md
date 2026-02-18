# CMV — Contextual Memory Virtualisation

## What This Is

CMV is a CLI tool and interactive TUI that brings git-like snapshot and branching semantics to Claude Code sessions. It treats conversation context as a first-class versioned artifact — something you can snapshot, name, branch from, and manage like source code.

## The Problem

Claude Code sessions are linear and disposable. When you spend 50k+ tokens having Claude analyze a codebase, discuss architecture, and reach decisions — that context is trapped in a single session. You have three bad options:

1. **Continue in the same session** until context fills up, then lose fidelity to compaction
2. **Start a new session** and re-explain everything from scratch
3. **Fork once** with `--fork-session`, but this flag is unreliable for stored sessions and doesn't work with session files that aren't already in the project directory

There is no way to:
- Save a "known good" context state and branch from it multiple times
- Build a library of reusable starting points (e.g., "codebase fully analyzed", "auth design agreed")
- Share context snapshots between machines or teammates
- Track the lineage of which sessions branched from where

## What CMV Does

CMV wraps Claude Code's existing session storage with a thin management layer that adds:

- **Interactive TUI dashboard**: Three-pane Ranger-style interface for browsing projects, snapshots, branches, and sessions
- **Named snapshots**: Capture the full session state at any point in time
- **Repeatable branching**: Create unlimited new sessions from any snapshot
- **Branch management**: Delete branches and their session files to keep things tidy
- **Snapshot tree**: Visualize the lineage of snapshots and their branches
- **Snapshot metadata**: Tags, descriptions, token estimates, timestamps
- **Portable snapshots**: Export/import for sharing or backup

## Why This Is Useful

### Expensive Context Is Reusable
You spend 20 minutes and 50k tokens having Claude deeply analyze a codebase. With CMV, that analysis becomes a permanent asset. Branch from it for auth work, branch again for API work, branch again next week when requirements change. Never re-pay the analysis cost (in human time — prompt caching handles the token cost on Anthropic's side).

### Experimentation Without Risk
Before a risky refactor discussion, snapshot. Try approach A in one branch, approach B in another. Compare results. Neither pollutes the other. If both fail, branch from the snapshot again.

### Context Lifecycle Management
Instead of one session that degrades over time as compaction eats detail, you work in focused branches. When a branch's context fills up, its conclusions feed back into CLAUDE.md or a new snapshot — not lost to a lossy summary.

### Team Workflows
A tech lead analyzes the codebase, makes architectural decisions, snapshots. Each team member branches from that snapshot with their own implementation task. Everyone starts with the same shared understanding.

## Usage

```bash
# Launch the interactive TUI dashboard (recommended)
cmv

# Or use individual CLI commands:

# List discoverable Claude Code sessions (to find session IDs)
cmv sessions

# Snapshot the most recent session
cmv snapshot "codebase-analyzed" --latest -d "Full codebase analysis"

# Branch for different tasks — each gets the full context
cmv branch "codebase-analyzed" --name "implement-auth"
cmv branch "codebase-analyzed" --name "implement-api"

# Show the tree
cmv tree

# Snapshot a branch, then branch from that
cmv snapshot "auth-designed" --session <auth-session-id>
cmv branch "auth-designed" --name "auth-frontend"
cmv branch "auth-designed" --name "auth-backend"

# Export/import for sharing
cmv export "codebase-analyzed" -o ./team-context.cmv
cmv import ./team-context.cmv

# Delete snapshots or branches (branches via TUI 'd' key)
cmv delete "old-snapshot"
```

---

## Architecture

### Core Design Principles

1. **Minimal writes to Claude Code storage.** CMV reads from `~/.claude/` for session discovery and snapshot creation. When branching, CMV writes two things to the Claude project directory: (a) the snapshot's JSONL file with a new session UUID, and (b) an updated `sessions-index.json` entry. This is necessary because `claude --resume` requires the session file to be in the project directory.
2. **Opaque session data.** CMV copies session files verbatim without parsing internal message format. This makes CMV resilient to Claude Code format changes.
3. **Cross-platform.** All paths use `os.homedir()` and `path.join()`. No hardcoded Unix paths. Must work on Windows, macOS, and Linux.
4. **Explicit over magic.** No auto-detection of "current session." User provides session IDs or uses `--latest` flag.

### High-Level Design

```
┌─────────────────────────────────────────────┐
│              CMV TUI Dashboard               │
│         (Ink/React, forked process)          │
│  Three-pane Ranger-style interface           │
│  Projects · Snapshots/Branches · Details     │
└──────────────┬──────────────────────────────┘
               │ IPC result
               ▼
┌─────────────────────────────────────────────┐
│                   CMV CLI                    │
│                                              │
│  dashboard · snapshot · branch · list        │
│  tree · info · sessions · delete             │
│  export · import · config · completions      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│              CMV Core Library                │
│                                              │
│  SessionReader     SnapshotManager           │
│  BranchManager     TreeBuilder               │
│  MetadataStore     Exporter/Importer         │
└──────┬──────────────────┬───────────────────┘
       │                  │
       ▼                  ▼
┌──────────────┐  ┌──────────────────────────┐
│ Claude Code  │  │      CMV Storage         │
│ Session      │  │  <homedir>/.cmv/         │
│ Storage      │  │  ├── snapshots/          │
│              │  │  │   └── <hash>/        │
│ <homedir>/   │  │  │       ├── meta.json   │
│  .claude/    │  │  │       └── session/    │
│  projects/   │  │  │           └── (files) │
│  (read for   │  │  ├── index.json          │
│   discovery) │  │  └── config.json         │
└──────┬───────┘  └──────────────────────────┘
       │                  │
       │ branch/delete    │
       │ writes JSONL +   │
       │ sessions-index   │
       ▼                  │
┌──────────────────────┐  │
│ Copy JSONL to:       │  │
│ .claude/projects/    │◄─┘
│   {dir}/{new-id}.jsonl│
│ Update sessions-     │
│   index.json         │
│ Then launch:         │
│ claude --resume      │
│   <new-id>           │
└──────────────────────┘
```

The TUI runs in a **forked child process** to avoid corrupting the parent's stdin on Windows. When the user selects an action (branch, resume, quit), the worker sends the result via IPC and exits. The parent then spawns Claude with a clean `stdio: 'inherit'`.

### Storage Layout

```
<homedir>/.cmv/
├── index.json                    # Master index of all snapshots and branches
├── config.json                   # CMV configuration
└── snapshots/
    └── <snapshot-id>/
        ├── meta.json             # Snapshot metadata (separate from index for portability)
        └── session/              # Verbatim copy of Claude Code session files
            └── (whatever files Claude Code stores — copied opaque)
```

### index.json Schema

```json
{
  "version": "1.0.0",
  "snapshots": {
    "codebase-analyzed": {
      "id": "snap_a1b2c3d4",
      "name": "codebase-analyzed",
      "description": "Full codebase analysis with arch discussion",
      "created_at": "2025-02-17T14:30:00Z",
      "source_session_id": "abc-123-def",
      "source_project_path": "C:\\Users\\me\\myproject",
      "snapshot_dir": "snap_a1b2c3d4",
      "message_count": null,
      "estimated_tokens": null,
      "tags": ["analysis", "architecture"],
      "parent_snapshot": null,
      "session_active_at_capture": false,
      "branches": [
        {
          "name": "implement-auth",
          "forked_session_id": "xyz-789-uvw",
          "created_at": "2025-02-17T14:35:00Z"
        },
        {
          "name": "implement-api",
          "forked_session_id": "hij-456-klm",
          "created_at": "2025-02-17T14:40:00Z"
        }
      ]
    },
    "auth-designed": {
      "id": "snap_e5f6g7h8",
      "name": "auth-designed",
      "parent_snapshot": "codebase-analyzed"
    }
  }
}
```

Note: `message_count` and `estimated_tokens` are nullable. We populate them if we can extract the info from session files, but we don't fail if we can't.

### meta.json Schema (per snapshot, for portability)

```json
{
  "cmv_version": "1.0.0",
  "snapshot_id": "snap_a1b2c3d4",
  "name": "codebase-analyzed",
  "description": "Full codebase analysis with arch discussion",
  "created_at": "2025-02-17T14:30:00Z",
  "source_session_id": "abc-123-def",
  "source_project_path": "C:\\Users\\me\\myproject",
  "tags": ["analysis", "architecture"],
  "parent_snapshot": null,
  "claude_code_version": "1.0.25",
  "session_file_format": "jsonl"
}
```

### Technology Choice

**Node.js (TypeScript)** — rationale:
- Claude Code is a Node.js application; users already have Node.js installed
- npm distribution for easy installation (`npm install -g cmv`)
- Native JSON/JSONL handling
- `child_process.spawn` for shelling out to `claude` CLI
- `path` and `os` modules for cross-platform support

---

## Components

### 1. SessionReader

Reads Claude Code session storage. **Read-only — never writes to Claude Code directories.**

Responsibilities:
- Discover Claude Code's storage location across platforms
- List available sessions with basic metadata by reading `sessions-index.json` from each project directory
- Copy session JSONL files to CMV storage for snapshots
- Detect active sessions and warn the user

Platform paths (all resolve via `os.homedir()` + `path.join()`):
```
Windows:  %USERPROFILE%\.claude\projects\
macOS:    ~/.claude/projects/
Linux:    ~/.claude/projects/
```

#### Discovered Storage Structure

Each project directory under `projects/` is named using an encoding of the project path:
```
~/.claude/projects/
├── D--myproject/              # D:\myproject  (Windows)
├── home--user--repos--app/    # /home/user/repos/app  (Linux)
├── d--S-G/                    # d:\S&G (special chars stripped)
└── ...
```

Each project directory contains:
```
{project-dir}/
├── sessions-index.json       # Index of all sessions for this project
├── {sessionId}.jsonl         # Session conversation data (one per session)
└── {sessionId}/              # Per-session artifacts (NOT needed for snapshots)
    ├── tool-results/         # Tool execution outputs
    └── subagents/            # Sub-agent conversation logs
```

#### sessions-index.json

Each project directory has a `sessions-index.json` with rich metadata — **CMV reads this as a starting point, then supplements with actual JSONL file stats** (real mtime, accurate message counts) since the index can be stale for active sessions:

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "30334ea2-f3d4-4071-9eda-4fd3c9b85c59",
      "fullPath": "C:\\Users\\you\\.claude\\projects\\D--myproject\\30334ea2-...jsonl",
      "fileMtime": 1769451328152,
      "firstPrompt": "analyze this entire codebase...",
      "summary": "Full codebase analysis with architecture discussion",
      "messageCount": 63,
      "created": "2026-01-26T17:30:12.656Z",
      "modified": "2026-01-26T18:14:29.034Z",
      "gitBranch": "",
      "projectPath": "D:\\myproject",
      "isSidechain": false
    }
  ],
  "originalPath": "D:\\myproject"
}
```

This gives us `sessionId`, `messageCount`, `summary`, `firstPrompt`, `created`, `modified`, and `projectPath` without any JSONL parsing.

#### Path Encoding Warnings

- **Path encoding is mostly reversible** for simple paths (e.g., `d--hiddenstate` → `d:\hiddenstate`), but NOT for paths with special characters (`d:\S&G` → `d--S-G`, ampersand stripped). CMV uses `decodeProjectPath()` / `decodeDirName()` to reverse simple encodings, and falls back to `originalPath`/`projectPath` from `sessions-index.json` when available.
- **Case varies on Windows.** `D--TLI` and `d--TLI` may both exist for the same project. CMV must deduplicate using case-insensitive comparison on Windows.
- Session files are JSONL format (one JSON object per line). The Claude Code version can be extracted from the `version` field in message lines (e.g., `"version": "2.1.19"`).

#### Active Session Detection

- `~/.claude/ide/{port}.lock` files contain JSON with `pid`, `workspaceFolders`, `ideName`.
- `~/.claude/tasks/{taskId}/.lock` files indicate active tasks.
- Heuristic: if a session's `fileMtime` is within the last 2 minutes AND an `ide/*.lock` file references a running process with a matching workspace, the session is likely active. Warn but don't block.

#### Snapshot Scope

Snapshots capture **only the JSONL conversation file** — not `tool-results/`, `subagents/`, or `file-history/`. The JSONL is all that `claude --resume` needs to restore a conversation. This keeps snapshots small (typically 100KB–2MB).

**Important**: Some sessions contain only `file-history-snapshot` entries with zero user/assistant messages. These are file-tracking sessions, not conversations. CMV warns during snapshot creation and refuses to branch from such snapshots, since Claude cannot resume a conversation that has no messages.

### 2. SnapshotManager

Creates, stores, retrieves, and deletes snapshots.

Responsibilities:
- Copy session files from Claude Code storage to CMV storage (verbatim, opaque)
- Generate snapshot IDs: `snap_` + 8 random hex chars
- Validate snapshot names: unique, filesystem-safe (alphanumeric, hyphens, underscores)
- Store metadata in both index.json and per-snapshot meta.json
- Handle snapshot chaining (parent_snapshot references)
- Record Claude Code version at snapshot time (for compatibility warnings)

### 3. BranchManager

Creates and deletes Claude Code sessions from snapshots using a direct file copy approach.

**How branching works** (`--fork-session` was unreliable for stored snapshots, so CMV uses direct JSONL copy):

1. Read the `source_session_id` from the snapshot metadata
2. Validate the snapshot has actual conversation messages (not just file-tracking data)
3. Find the Claude project directory for the source session
4. Generate a new UUID via `crypto.randomUUID()`
5. Copy the snapshot's JSONL file into the project directory with the new UUID as filename
6. Update `sessions-index.json` in the project directory with the new session entry
7. Execute: `claude --resume <new-uuid>` (Claude finds the JSONL and loads the conversation)
8. Record the branch in CMV's index

**How branch deletion works:**

1. Look up the branch record in the parent snapshot's metadata
2. Find the Claude project directory containing the branch's session file
3. Delete the forked session JSONL from `~/.claude/projects/{encoded-path}/`
4. Remove the entry from the project's `sessions-index.json`
5. Remove the branch record from CMV's `index.json`

Responsibilities:
- Copy snapshot JSONL to Claude project directory with new session UUID
- Update `sessions-index.json` so Claude can discover the session
- Delete branch session files and clean up `sessions-index.json` entries
- Decode project path from directory name encoding (e.g., `d--hiddenstate` → `d:\hiddenstate`)
- Validate conversation content exists before branching
- Launch `claude --resume <new-id>` from the correct working directory
- Provide `--skip-launch` mode that creates the session file without launching
- Handle errors (no conversation content, project dir not found, CLI exit codes, etc.)

### 4. TreeBuilder

Builds and renders the snapshot/branch hierarchy.

Responsibilities:
- Traverse `parent_snapshot` links to build tree structure
- Render ASCII tree for terminal display
- Show metadata inline (date, token estimate, branch count)
- Support `--json` output for programmatic use

Example output:
```
codebase-analyzed (2025-02-17 14:30, ~51k tokens)
├── implement-auth (branch, 14:35)
├── implement-api (branch, 14:40)
├── refactor-db-schema (branch, 15:00)
└── auth-designed (snapshot, 15:30, ~68k tokens)
    ├── auth-frontend (branch, 15:35)
    └── auth-backend (branch, 15:40)
```

### 5. MetadataStore

Manages the index.json file with atomic operations.

Responsibilities:
- CRUD operations on snapshot and branch metadata
- Atomic writes: write to temp file, then rename (prevents corruption on crash)
- Initialize CMV storage directory on first use
- Schema migration support for future versions
- Cross-platform file locking (advisory)

### 6. Exporter/Importer

Handles portable snapshot files for sharing.

Responsibilities:
- Export: tar.gz the snapshot directory (meta.json + session files) into a single `.cmv` file
- Import: validate, extract, and register in local index.json
- Handle name conflicts (prompt rename or use `--force`)
- Validate CMV version compatibility on import

### 7. TUI Dashboard (Ink/React)

Interactive three-pane terminal interface for managing all CMV operations visually.

**Architecture:** The dashboard runs in a **forked child process** (`tui-worker.tsx`) to isolate Ink's stdin manipulation from the parent process. On Windows, Ink starts a background libuv reader thread that cannot be stopped without closing the console handle — which would break `stdio: 'inherit'` for subsequent child spawns. By forking, the worker owns its own stdin; when it exits, the OS frees everything and the parent can spawn Claude cleanly.

**Components:**
- `Dashboard.tsx` — Main component: three-pane layout, keyboard handling, mode state machine
- `ProjectPane.tsx` — Left column: lists Claude Code projects
- `TreePane.tsx` — Middle column: snapshot/branch/session tree with expand/collapse
- `DetailPane.tsx` — Right column: metadata for selected item
- `ActionBar.tsx` — Bottom bar: context-sensitive key hints
- `BranchPrompt.tsx` — Inline prompt for branch name input
- `SnapshotPrompt.tsx` — Inline prompt for snapshot name input
- `ConfirmDelete.tsx` — Confirmation dialog for snapshot/branch deletion
- `ImportPrompt.tsx` — Inline prompt for import file path
- `tui-worker.tsx` — Forked process entry point: renders Dashboard, sends result via IPC
- `index.tsx` — `launchDashboard()`: forks the worker, waits for IPC result

**Hooks:**
- `useProjects` — Discovers all Claude Code projects, their snapshots, and sessions
- `useTreeNavigation` — Flattens tree with expand/collapse, keyboard navigation (j/k, arrows)
- `useTerminalSize` — Tracks terminal dimensions for responsive layout

**Modes:** `navigate` | `branch-prompt` | `branch-launch-prompt` | `snapshot-prompt` | `confirm-delete` | `confirm-delete-branch` | `import-prompt`

**Key bindings (navigate mode):**

| Key | Context | Action |
|-----|---------|--------|
| `j/k`, `↑/↓` | Any pane | Navigate |
| `←/→` | Tree pane | Collapse/expand nodes |
| `Tab` | Any | Switch focus between panes |
| `Enter` | Snapshot | Prompt for name, branch and launch Claude |
| `Enter` | Branch/Session | Resume session (launch Claude) |
| `b` | Snapshot | Create branch without launching |
| `s` | Any | Create snapshot (from selected session or latest) |
| `d` | Snapshot | Delete snapshot (with confirmation) |
| `d` | Branch | Delete branch and its session file (with confirmation) |
| `e` | Snapshot | Export to `.cmv` file |
| `i` | Any | Import `.cmv` file |
| `q` | Any | Quit |

---

## CLI Interface

### Commands

| Command | Description |
|---------|-------------|
| `cmv` / `cmv dashboard` | Launch the interactive TUI dashboard |
| `cmv snapshot <n>` | Snapshot a session |
| `cmv branch <snapshot>` | Create a new session from a snapshot |
| `cmv list` | List all snapshots with metadata |
| `cmv sessions` | List discoverable Claude Code sessions |
| `cmv tree` | Show snapshot/branch hierarchy as ASCII tree |
| `cmv info <snapshot>` | Show detailed info about a snapshot |
| `cmv delete <snapshot>` | Delete a snapshot (with confirmation) |
| `cmv export <snapshot> -o <path>` | Export snapshot to portable file |
| `cmv import <path>` | Import snapshot from portable file |
| `cmv config` | Show/edit CMV configuration |
| `cmv completions` | Install or output shell completion script |

### Command Details

```
cmv snapshot <n> [options]
  --session, -s       Session ID to snapshot (required unless --latest)
  --latest            Snapshot the most recently modified session
  --description, -d   Description text
  --tags, -t          Comma-separated tags

cmv branch <snapshot-name> [options]
  --name, -n          Name for the branch (default: auto-generated timestamp)
  --skip-launch       Don't launch Claude Code, just create the session file
  --dry-run           Show what would happen without doing it

cmv sessions [options]
  --project, -p       Filter by project path (also speeds up lookup)
  --sort              Sort by: date (default), size
  --all               Include empty file-tracking sessions (hidden by default)
  --json              Output as JSON

cmv list [options]
  --tag               Filter by tag
  --sort              Sort by: date (default), name, branches
  --json              Output as JSON

cmv tree [options]
  --depth             Max depth to display (default: unlimited)
  --json              Output as JSON

cmv info <snapshot-name>
  (no options — displays all metadata, branches, and parent chain)

cmv delete <snapshot-name> [options]
  --force, -f         Skip confirmation prompt

cmv export <snapshot-name> [options]
  --output, -o        Output file path (default: ./<n>.cmv)

cmv import <path> [options]
  --rename <n>        Rename snapshot if name conflicts
  --force             Overwrite existing snapshot with same name

cmv config [key] [value]
  (no args: show all config)
  (key only: show value)
  (key + value: set value)
```

---

## Implementation Status

All core phases are complete:

1. **Discovery** — Claude Code session storage format mapped, `--fork-session` tested and abandoned in favor of direct JSONL copy. See `DISCOVERY.md`.
2. **Core MVP** — `snapshot`, `branch`, `list`, `sessions` commands working end-to-end.
3. **Visibility** — `tree`, `info`, `config` commands, filtering and sorting.
4. **Portability** — `export` and `import` with `.cmv` file format.
5. **Polish** — Error handling, shell completions (PowerShell + bash), README.
6. **TUI Dashboard** — Interactive three-pane interface with Ink/React, forked worker process for Windows stdin compatibility.
7. **Branch deletion** — Delete branches and their session files from both TUI (`d` key) and core API.

---

## Key Risks and Mitigations

### Risk 1: Claude Code session storage format is undocumented
**Impact**: High — if we can't find session files or extract session IDs, snapshotting doesn't work.
**Mitigation**: Phase 1 is entirely dedicated to this. CMV treats session data as opaque — we copy files without parsing internals. We only need to: (a) locate session files, (b) extract session IDs, (c) copy files. We don't need to understand message content.

### Risk 2: `claude --resume <id> --fork-session` is unreliable for stored sessions
**Impact**: High — `--fork-session` couldn't reliably locate sessions from snapshot files stored outside the project directory.
**Resolution**: Abandoned `--fork-session` entirely. CMV now copies the snapshot JSONL directly into the Claude project directory with a pre-generated UUID, updates `sessions-index.json`, and uses `claude --resume <new-uuid>`. This is fully reliable because CMV controls file placement.

### Risk 3: Session format changes between Claude Code versions
**Impact**: Medium — could break snapshot restoration.
**Mitigation**: Record `claude_code_version` in snapshot metadata. Warn on version mismatch. Since branching uses `claude --resume` (Claude Code's own session loader), format changes are Claude Code's problem, not ours — as long as Claude Code remains backward-compatible with its own JSONL format.

### Risk 4: Session files reference external state
**Impact**: Low-Medium — if sessions reference temp files or caches, forking a snapshot might behave unexpectedly.
**Mitigation**: Document this limitation. CMV snapshots conversation state, not filesystem state. Recommend pairing CMV snapshots with git commits for full reproducibility.

### Risk 5: Active session locking
**Impact**: Low — snapshotting a session that's being actively written to could produce a corrupted copy.
**Mitigation**: Detect active sessions (via lock files, PID checks, or file modification recency). Warn or refuse to snapshot active sessions. Recommend snapshotting after exiting the session.

### Risk 6: Cross-platform path differences
**Impact**: Low — Windows vs Unix path handling.
**Mitigation**: Use `path.join()` and `os.homedir()` exclusively. Test on Windows (user's primary platform) first. Never use `/` as a path separator in code.

---

## Project Setup

```
cmv/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI entry point + default dashboard action
│   ├── commands/
│   │   ├── snapshot.ts
│   │   ├── branch.ts
│   │   ├── list.ts
│   │   ├── sessions.ts
│   │   ├── tree.ts
│   │   ├── info.ts
│   │   ├── delete.ts
│   │   ├── export.ts
│   │   ├── import.ts
│   │   ├── config.ts
│   │   ├── completions.ts
│   │   └── dashboard.ts
│   ├── core/
│   │   ├── session-reader.ts
│   │   ├── snapshot-manager.ts
│   │   ├── branch-manager.ts  # createBranch + deleteBranch
│   │   ├── tree-builder.ts
│   │   ├── metadata-store.ts
│   │   ├── exporter.ts
│   │   └── importer.ts
│   ├── tui/
│   │   ├── index.tsx          # launchDashboard() — forks tui-worker
│   │   ├── tui-worker.tsx     # Forked process: renders Dashboard, sends result via IPC
│   │   ├── Dashboard.tsx      # Main TUI component (state machine, key handlers)
│   │   ├── ProjectPane.tsx    # Left column: project list
│   │   ├── TreePane.tsx       # Middle column: snapshot/branch/session tree
│   │   ├── DetailPane.tsx     # Right column: metadata display
│   │   ├── ActionBar.tsx      # Bottom bar: context-sensitive key hints
│   │   ├── BranchPrompt.tsx   # Inline branch name input
│   │   ├── SnapshotPrompt.tsx # Inline snapshot name input
│   │   ├── ConfirmDelete.tsx  # y/N confirmation dialog
│   │   ├── ImportPrompt.tsx   # Inline import path input
│   │   └── hooks/
│   │       ├── useProjects.ts      # Discover projects + snapshots + sessions
│   │       ├── useTreeNavigation.ts # Flatten/navigate tree with collapse state
│   │       └── useTerminalSize.ts   # Track terminal dimensions
│   ├── types/
│   │   └── index.ts           # All TypeScript interfaces
│   └── utils/
│       ├── paths.ts           # Cross-platform path resolution
│       ├── id.ts              # Snapshot ID generation
│       ├── process.ts         # Shell out to claude CLI (CONIN$ fallback on Windows)
│       ├── display.ts         # Terminal formatting (chalk)
│       └── errors.ts          # Error handling utilities
├── docs/
│   └── outline.md             # This file
├── tests/
└── DISCOVERY.md               # Phase 1 findings
```

### Dependencies

```json
{
  "dependencies": {
    "@inkjs/ui": "^2.0.0",
    "chalk": "^5.0.0",
    "commander": "^12.0.0",
    "ink": "^5.0.0",
    "react": "^18.0.0"
  },
  "devDependencies": {
    "@types/node": "^25.2.3",
    "@types/react": "^18.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

Commander for CLI parsing, chalk for terminal colors, Ink/React for the TUI dashboard.

### Build and Run

```bash
npm install
npm run build        # tsc compiles to dist/
npm link             # makes `cmv` available globally
cmv --help
```

---

## Development Notes

### Key Constraints

- **Minimal writes to `~/.claude/`.** CMV reads from Claude storage for discovery. When branching, CMV writes the snapshot JSONL (with new UUID) and updates `sessions-index.json`. When deleting a branch, it removes the JSONL and the `sessions-index.json` entry. No other Claude files are modified.
- **Branching uses direct JSONL copy + `claude --resume <new-id>`.** The `--fork-session` approach was abandoned because it couldn't reliably find stored sessions. CMV places the file where Claude expects it, then resumes by the new UUID.
- **All paths must use `path.join()` and `os.homedir()`.** Primary development platform is Windows.
- **Session data is opaque.** Copy verbatim. Don't parse internal message format (except to count user/assistant messages for validation).
- **Atomic file writes for index.json.** Write to temp file, then `fs.rename()`.
- **Warn on active sessions.** Don't snapshot a session that's currently being written to.
- **Validate conversation content.** Refuse to branch from snapshots that have zero user/assistant messages (file-tracking-only sessions).
- **TUI runs in a forked process.** Ink's stdin manipulation (raw mode, background reader thread on Windows) makes it impossible to spawn an interactive child process from the same process afterward. The worker process isolates this entirely.

### Windows-Specific Considerations

- **Forked TUI worker:** `tui-worker.tsx` runs Ink in a child process. When the worker exits, the OS frees all handles. The parent's stdin is never touched, so `spawn` with `stdio: 'inherit'` works cleanly.
- **CONIN$ fallback:** `spawnClaudeInteractive()` in `process.ts` detects `process.stdin.destroyed` on Windows and opens a fresh console handle via `CONIN$` as a safety net.
- **Claude CLI path resolution:** `getClaudeCliPath()` checks `~/.local/bin/claude.exe` first to avoid needing `shell: true` on Windows.

---

## Non-Goals (For Now)

- **Context compression/optimization**: CMV snapshots full session state. Compaction optimization is a separate tool.
- **Automatic snapshot triggers**: No hooks into Claude Code's lifecycle yet. User explicitly snapshots. (Future: SessionStart/SessionEnd hooks could auto-snapshot.)
- **Merge**: No merging of diverged branches. Git does this for code; there's no meaningful merge for conversation state.
- **Diff**: No semantic diff between branches. The divergence point is known (the snapshot), but comparing conversation content is out of scope for v1.
- **KV cache management**: CMV operates at the session/message layer, not the model inference layer.
- **MCP server**: CMV is a standalone CLI, not an MCP tool the model calls. The model doesn't need to manage its own snapshots — the user does.
- **Modifying existing Claude Code sessions**: CMV only adds new session files when branching and removes them when deleting branches. It never modifies existing Claude-created session files.

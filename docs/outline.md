# VMC — Virtual Memory Contextualization

## What This Is

VMC is a CLI tool that brings git-like snapshot and branching semantics to Claude Code sessions. It treats conversation context as a first-class versioned artifact — something you can snapshot, name, branch from, and manage like source code.

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

## What VMC Does

VMC wraps Claude Code's existing session storage with a thin management layer that adds:

- **Named snapshots**: Capture the full session state at any point in time
- **Repeatable branching**: Create unlimited new sessions from any snapshot
- **Snapshot tree**: Visualize the lineage of snapshots and their branches
- **Snapshot metadata**: Tags, descriptions, token estimates, timestamps
- **Portable snapshots**: Export/import for sharing or backup

## Why This Is Useful

### Expensive Context Is Reusable
You spend 20 minutes and 50k tokens having Claude deeply analyze a codebase. With VMC, that analysis becomes a permanent asset. Branch from it for auth work, branch again for API work, branch again next week when requirements change. Never re-pay the analysis cost (in human time — prompt caching handles the token cost on Anthropic's side).

### Experimentation Without Risk
Before a risky refactor discussion, snapshot. Try approach A in one branch, approach B in another. Compare results. Neither pollutes the other. If both fail, branch from the snapshot again.

### Context Lifecycle Management
Instead of one session that degrades over time as compaction eats detail, you work in focused branches. When a branch's context fills up, its conclusions feed back into CLAUDE.md or a new snapshot — not lost to a lossy summary.

### Team Workflows
A tech lead analyzes the codebase, makes architectural decisions, snapshots. Each team member branches from that snapshot with their own implementation task. Everyone starts with the same shared understanding.

## How It Would Be Used

```bash
# Start a Claude Code session, have it analyze the codebase
claude
> analyze this entire codebase, understand the architecture, dependencies, and patterns

# ... long discussion about architecture ...

# Snapshot this state (requires session ID — get it from `claude` status bar or `vmc sessions`)
vmc snapshot "codebase-analyzed" --session <session-id> --description "Full codebase analysis with arch discussion"

# Or if you just finished a session and want to snapshot the most recent one:
vmc snapshot "codebase-analyzed" --latest --description "Full codebase analysis with arch discussion"

# Branch for different tasks — each gets the full context
vmc branch "codebase-analyzed" --name "implement-auth"
# ^ Copies snapshot JSONL to project dir with new UUID, then runs: claude --resume <new-id>
# ^ Opens a new Claude Code session with the full conversation history

vmc branch "codebase-analyzed" --name "implement-api"
# ^ Another independent session, same starting point

vmc branch "codebase-analyzed" --name "refactor-db-schema"
# ^ And another

# List all snapshots and branches
vmc list

# List discoverable Claude Code sessions (to find session IDs)
vmc sessions

# Show the tree
vmc tree
# codebase-analyzed (snapshot, 2025-02-17 14:30, ~51k tokens)
# ├── implement-auth (branch, 2025-02-17 14:35)
# ├── implement-api (branch, 2025-02-17 14:40)
# └── refactor-db-schema (branch, 2025-02-17 15:00)

# Later, snapshot a branch too — snapshots can chain
# (after more work in the implement-auth session)
vmc snapshot "auth-designed" --session <auth-session-id>

vmc branch "auth-designed" --name "auth-frontend"
vmc branch "auth-designed" --name "auth-backend"

# Show info about a snapshot
vmc info "codebase-analyzed"

# Export a snapshot for sharing
vmc export "codebase-analyzed" -o ./snapshots/codebase-analyzed.vmc

# Import on another machine
vmc import ./snapshots/codebase-analyzed.vmc

# Delete old snapshots
vmc delete "codebase-analyzed"
```

---

## Architecture

### Core Design Principles

1. **Minimal writes to Claude Code storage.** VMC reads from `~/.claude/` for session discovery and snapshot creation. When branching, VMC writes two things to the Claude project directory: (a) the snapshot's JSONL file with a new session UUID, and (b) an updated `sessions-index.json` entry. This is necessary because `claude --resume` requires the session file to be in the project directory.
2. **Opaque session data.** VMC copies session files verbatim without parsing internal message format. This makes VMC resilient to Claude Code format changes.
3. **Cross-platform.** All paths use `os.homedir()` and `path.join()`. No hardcoded Unix paths. Must work on Windows, macOS, and Linux.
4. **Explicit over magic.** No auto-detection of "current session." User provides session IDs or uses `--latest` flag.

### High-Level Design

```
┌─────────────────────────────────────────────┐
│                   VMC CLI                    │
│                                              │
│  snapshot · branch · list · tree · info      │
│  sessions · export · import · delete         │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│              VMC Core Library                │
│                                              │
│  SessionReader     SnapshotManager           │
│  BranchManager     TreeBuilder               │
│  MetadataStore     Exporter/Importer         │
└──────┬──────────────────┬───────────────────┘
       │                  │
       ▼                  ▼
┌──────────────┐  ┌──────────────────────────┐
│ Claude Code  │  │      VMC Storage         │
│ Session      │  │  <homedir>/.vmc/         │
│ Storage      │  │  ├── snapshots/          │
│              │  │  │   └── <hash>/        │
│ <homedir>/   │  │  │       ├── meta.json   │
│  .claude/    │  │  │       └── session/    │
│  projects/   │  │  │           └── (files) │
│  (read for   │  │  ├── index.json          │
│   discovery) │  │  └── config.json         │
└──────┬───────┘  └──────────────────────────┘
       │                  │
       │ branch command   │
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

### Storage Layout

```
<homedir>/.vmc/
├── index.json                    # Master index of all snapshots and branches
├── config.json                   # VMC configuration
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
  "vmc_version": "1.0.0",
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
- npm distribution for easy installation (`npm install -g vmc`)
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
- Copy session JSONL files to VMC storage for snapshots
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
├── D--idleking/              # D:\idleking
├── D--TLI/                   # D:\TLI
├── d--S-G/                   # d:\S&G (special chars stripped)
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

Each project directory has a `sessions-index.json` with rich metadata — **VMC reads this as a starting point, then supplements with actual JSONL file stats** (real mtime, accurate message counts) since the index can be stale for active sessions:

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "30334ea2-f3d4-4071-9eda-4fd3c9b85c59",
      "fullPath": "C:\\Users\\yasin\\.claude\\projects\\D--idleking\\30334ea2-...jsonl",
      "fileMtime": 1769451328152,
      "firstPrompt": "analyze this entire codebase...",
      "summary": "Full codebase analysis with architecture discussion",
      "messageCount": 63,
      "created": "2026-01-26T17:30:12.656Z",
      "modified": "2026-01-26T18:14:29.034Z",
      "gitBranch": "",
      "projectPath": "D:\\idleking",
      "isSidechain": false
    }
  ],
  "originalPath": "D:\\idleking"
}
```

This gives us `sessionId`, `messageCount`, `summary`, `firstPrompt`, `created`, `modified`, and `projectPath` without any JSONL parsing.

#### Path Encoding Warnings

- **Path encoding is mostly reversible** for simple paths (e.g., `d--hiddenstate` → `d:\hiddenstate`), but NOT for paths with special characters (`d:\S&G` → `d--S-G`, ampersand stripped). VMC uses `decodeProjectPath()` / `decodeDirName()` to reverse simple encodings, and falls back to `originalPath`/`projectPath` from `sessions-index.json` when available.
- **Case varies on Windows.** `D--TLI` and `d--TLI` may both exist for the same project. VMC must deduplicate using case-insensitive comparison on Windows.
- Session files are JSONL format (one JSON object per line). The Claude Code version can be extracted from the `version` field in message lines (e.g., `"version": "2.1.19"`).

#### Active Session Detection

- `~/.claude/ide/{port}.lock` files contain JSON with `pid`, `workspaceFolders`, `ideName`.
- `~/.claude/tasks/{taskId}/.lock` files indicate active tasks.
- Heuristic: if a session's `fileMtime` is within the last 2 minutes AND an `ide/*.lock` file references a running process with a matching workspace, the session is likely active. Warn but don't block.

#### Snapshot Scope

Snapshots capture **only the JSONL conversation file** — not `tool-results/`, `subagents/`, or `file-history/`. The JSONL is all that `claude --resume` needs to restore a conversation. This keeps snapshots small (typically 100KB–2MB).

**Important**: Some sessions contain only `file-history-snapshot` entries with zero user/assistant messages. These are file-tracking sessions, not conversations. VMC warns during snapshot creation and refuses to branch from such snapshots, since Claude cannot resume a conversation that has no messages.

### 2. SnapshotManager

Creates, stores, retrieves, and deletes snapshots.

Responsibilities:
- Copy session files from Claude Code storage to VMC storage (verbatim, opaque)
- Generate snapshot IDs: `snap_` + 8 random hex chars
- Validate snapshot names: unique, filesystem-safe (alphanumeric, hyphens, underscores)
- Store metadata in both index.json and per-snapshot meta.json
- Handle snapshot chaining (parent_snapshot references)
- Record Claude Code version at snapshot time (for compatibility warnings)

### 3. BranchManager

Creates new Claude Code sessions from snapshots using a direct file copy approach.

**How branching actually works** (discovered through testing — `--fork-session` was unreliable for stored snapshots):

1. Read the `source_session_id` from the snapshot metadata
2. Validate the snapshot has actual conversation messages (not just file-tracking data)
3. Find the Claude project directory for the source session
4. Generate a new UUID via `crypto.randomUUID()`
5. Copy the snapshot's JSONL file into the project directory with the new UUID as filename
6. Update `sessions-index.json` in the project directory with the new session entry
7. Execute: `claude --resume <new-uuid>` (Claude finds the JSONL and loads the conversation)
8. Record the branch in VMC's index

Note: The original plan was to use `claude --resume <source-id> --fork-session`, but this failed because `--resume` couldn't reliably locate sessions from snapshot files. The direct copy approach is more reliable — we place the file exactly where Claude expects it and let `--resume` find it by UUID.

Responsibilities:
- Copy snapshot JSONL to Claude project directory with new session UUID
- Update `sessions-index.json` so Claude can discover the session
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
- Initialize VMC storage directory on first use
- Schema migration support for future versions
- Cross-platform file locking (advisory)

### 6. Exporter/Importer

Handles portable snapshot files for sharing.

Responsibilities:
- Export: tar.gz the snapshot directory (meta.json + session files) into a single `.vmc` file
- Import: validate, extract, and register in local index.json
- Handle name conflicts (prompt rename or use `--force`)
- Validate VMC version compatibility on import

---

## CLI Interface

### Commands

| Command | Description |
|---------|-------------|
| `vmc snapshot <n>` | Snapshot a session |
| `vmc branch <snapshot>` | Create a new session from a snapshot |
| `vmc list` | List all snapshots with metadata |
| `vmc sessions` | List discoverable Claude Code sessions |
| `vmc tree` | Show snapshot/branch hierarchy as ASCII tree |
| `vmc info <snapshot>` | Show detailed info about a snapshot |
| `vmc delete <snapshot>` | Delete a snapshot (with confirmation) |
| `vmc export <snapshot> -o <path>` | Export snapshot to portable file |
| `vmc import <path>` | Import snapshot from portable file |
| `vmc config` | Show/edit VMC configuration |
| `vmc completions` | Install or output shell completion script |

### Command Details

```
vmc snapshot <n> [options]
  --session, -s       Session ID to snapshot (required unless --latest)
  --latest            Snapshot the most recently modified session
  --description, -d   Description text
  --tags, -t          Comma-separated tags

vmc branch <snapshot-name> [options]
  --name, -n          Name for the branch (default: auto-generated timestamp)
  --skip-launch       Don't launch Claude Code, just create the session file
  --dry-run           Show what would happen without doing it

vmc sessions [options]
  --project, -p       Filter by project path (also speeds up lookup)
  --sort              Sort by: date (default), size
  --all               Include empty file-tracking sessions (hidden by default)
  --json              Output as JSON

vmc list [options]
  --tag               Filter by tag
  --sort              Sort by: date (default), name, branches
  --json              Output as JSON

vmc tree [options]
  --depth             Max depth to display (default: unlimited)
  --json              Output as JSON

vmc info <snapshot-name>
  (no options — displays all metadata, branches, and parent chain)

vmc delete <snapshot-name> [options]
  --force, -f         Skip confirmation prompt

vmc export <snapshot-name> [options]
  --output, -o        Output file path (default: ./<n>.vmc)

vmc import <path> [options]
  --rename <n>        Rename snapshot if name conflicts
  --force             Overwrite existing snapshot with same name

vmc config [key] [value]
  (no args: show all config)
  (key only: show value)
  (key + value: set value)
```

---

## Implementation Plan

### Phase 1: Discovery (Do This First)

**Goal**: Understand Claude Code's session file format and confirm the branching mechanism works.

This is a blocking investigation. Do not write any VMC code until this is complete.

#### Tasks:

```bash
# 1. Find Claude Code's session storage
# On Windows:
dir %USERPROFILE%\.claude\ /s /b
# On macOS/Linux:
find ~/.claude -type f | head -50

# 2. Examine directory structure under .claude/projects/
# What is the hierarchy? How are sessions organized by project?

# 3. Find a recent session file and examine it
# - What format? (JSONL confirmed, but inspect to be sure)
# - What fields are in each line?
# - Is there a session ID embedded in the file, or is it the filename?
# - How large are typical session files?

# 4. Test: Can we identify session IDs from filenames or file content?

# 5. Test: Run `claude --resume <session-id> --fork-session`
# - Does it work?
# - Does it output the new session ID? Where?
# - What new files appear in the session storage?
#
# 5b. Test: Run `claude --resume <session-id> --fork-session --session-id <new-uuid>`
# - Does the new session get the specified UUID?
# - This would let VMC know the new session ID upfront without parsing output.
#
# 5c. Test: Run `claude --resume <session-id> --fork-session --print "continue"`
# - Does it fork, print output, and exit without interactive session?
# - This would enable a --no-launch mode.

# 6. Test: Can we detect if a session is currently active?
# - Lock files? PID files? Open file handles?

# 7. Test: What happens if you --resume a session that was already compacted?
# - Is the compacted state what gets forked? (This would be expected and fine)
```

#### Deliverable:

Create `DISCOVERY.md` documenting:
- Exact directory structure
- Session file format (JSONL line schema if parseable)
- How session IDs map to files/directories
- How `--resume --fork-session` behaves (and whether `--session-id` works with it)
- How to detect active sessions
- Any platform-specific differences found
- Whether message count / token estimation is feasible from file inspection

**Exit criteria**: We can run `claude --resume <id> --fork-session` and it creates a usable new session. We know where session files live and can copy them. Ideally, we also confirm `--session-id` works with `--fork-session`.

### Phase 2: Core (MVP)

**Goal**: `vmc snapshot` and `vmc branch` work end-to-end.

1. Scaffold TypeScript project with Commander.js CLI
2. Implement cross-platform path resolution (SessionReader.getClaudeStoragePath())
3. Implement SessionReader — discover and list sessions
4. Implement MetadataStore — index.json management with atomic writes
5. Implement SnapshotManager — copy session files, create metadata
6. Implement BranchManager — copy snapshot JSONL to project dir with new UUID, update sessions-index.json, launch `claude --resume <new-id>`
7. Wire up `vmc snapshot`, `vmc branch`, `vmc list`, `vmc sessions` commands
8. Test on Windows (primary) and at least one other platform

### Phase 3: Visibility

**Goal**: Users can see and understand their snapshot tree.

1. Implement TreeBuilder with ASCII rendering
2. Add `vmc tree` command
3. Add `vmc info` command
4. Improve `vmc list` with filtering and sorting
5. Add `vmc config` for basic settings

### Phase 4: Portability

**Goal**: Snapshots can be shared.

1. Implement Exporter (tar.gz packaging)
2. Implement Importer with conflict handling and version validation
3. Add `vmc export` and `vmc import` commands

### Phase 5: Polish

**Goal**: Production-ready CLI.

1. Error handling and user-friendly error messages
2. Shell completions (bash, zsh, fish, PowerShell)
3. README with installation and usage docs
4. npm package setup for `npm install -g vmc`
5. CI/CD for cross-platform testing

---

## Key Risks and Mitigations

### Risk 1: Claude Code session storage format is undocumented
**Impact**: High — if we can't find session files or extract session IDs, snapshotting doesn't work.
**Mitigation**: Phase 1 is entirely dedicated to this. VMC treats session data as opaque — we copy files without parsing internals. We only need to: (a) locate session files, (b) extract session IDs, (c) copy files. We don't need to understand message content.

### Risk 2: `claude --resume <id> --fork-session` is unreliable for stored sessions
**Impact**: High — `--fork-session` couldn't reliably locate sessions from snapshot files stored outside the project directory.
**Resolution**: Abandoned `--fork-session` entirely. VMC now copies the snapshot JSONL directly into the Claude project directory with a pre-generated UUID, updates `sessions-index.json`, and uses `claude --resume <new-uuid>`. This is fully reliable because VMC controls file placement.

### Risk 3: Session format changes between Claude Code versions
**Impact**: Medium — could break snapshot restoration.
**Mitigation**: Record `claude_code_version` in snapshot metadata. Warn on version mismatch. Since branching uses `claude --resume` (Claude Code's own session loader), format changes are Claude Code's problem, not ours — as long as Claude Code remains backward-compatible with its own JSONL format.

### Risk 4: Session files reference external state
**Impact**: Low-Medium — if sessions reference temp files or caches, forking a snapshot might behave unexpectedly.
**Mitigation**: Document this limitation. VMC snapshots conversation state, not filesystem state. Recommend pairing VMC snapshots with git commits for full reproducibility.

### Risk 5: Active session locking
**Impact**: Low — snapshotting a session that's being actively written to could produce a corrupted copy.
**Mitigation**: Detect active sessions (via lock files, PID checks, or file modification recency). Warn or refuse to snapshot active sessions. Recommend snapshotting after exiting the session.

### Risk 6: Cross-platform path differences
**Impact**: Low — Windows vs Unix path handling.
**Mitigation**: Use `path.join()` and `os.homedir()` exclusively. Test on Windows (user's primary platform) first. Never use `/` as a path separator in code.

---

## Project Setup

```
vmc/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI entry point
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
│   │   └── config.ts
│   ├── core/
│   │   ├── session-reader.ts
│   │   ├── snapshot-manager.ts
│   │   ├── branch-manager.ts
│   │   ├── tree-builder.ts
│   │   ├── metadata-store.ts
│   │   └── exporter.ts
│   ├── types/
│   │   └── index.ts           # All TypeScript interfaces
│   └── utils/
│       ├── paths.ts           # Cross-platform path resolution
│       ├── id.ts              # Snapshot ID generation
│       ├── process.ts         # Shell out to claude CLI
│       └── display.ts         # Terminal formatting (chalk)
├── tests/
│   ├── fixtures/              # Mock session files for testing
│   ├── session-reader.test.ts
│   ├── snapshot-manager.test.ts
│   ├── branch-manager.test.ts
│   └── metadata-store.test.ts
└── DISCOVERY.md               # Phase 1 findings (created during discovery)
```

### Dependencies

```json
{
  "name": "vmc",
  "version": "0.1.0",
  "bin": {
    "vmc": "./dist/index.js"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "chalk": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0",
    "vitest": "^1.0.0"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest",
    "link": "npm run build && npm link"
  }
}
```

Minimal dependencies. Commander for CLI parsing, chalk for terminal colors. Everything else is Node.js stdlib.

### Build and Run

```bash
npm install
npm run build        # tsc compiles to dist/
npm link             # makes `vmc` available globally
vmc --help
```

---

## Development Instructions for Claude Code

### Starting Work

Begin with Phase 1 discovery. Run the investigation commands and create DISCOVERY.md before writing any VMC code.

### Key Constraints

- **Minimal writes to `~/.claude/`.** VMC reads from Claude storage for discovery. When branching, VMC writes the snapshot JSONL (with new UUID) and updates `sessions-index.json` in the target project directory. No other Claude files are modified.
- **Branching uses direct JSONL copy + `claude --resume <new-id>`.** The `--fork-session` approach was abandoned because it couldn't reliably find stored sessions. VMC places the file where Claude expects it, then resumes by the new UUID.
- **All paths must use `path.join()` and `os.homedir()`.** The user is on Windows. Test there first.
- **Session data is opaque.** Copy verbatim. Don't parse internal message format (except to count user/assistant messages for validation).
- **Atomic file writes for index.json.** Write to temp file, then `fs.rename()`.
- **Warn on active sessions.** Don't snapshot a session that's currently being written to.
- **Validate conversation content.** Refuse to branch from snapshots that have zero user/assistant messages (file-tracking-only sessions).

### Testing Strategy

- Unit tests with mock session files in `tests/fixtures/`
- Don't test against live Claude Code state in CI
- Integration tests can be run manually by the developer
- Test cross-platform path handling explicitly

---

## Non-Goals (For Now)

- **Context compression/optimization**: VMC snapshots full session state. Compaction optimization is a separate tool.
- **Automatic snapshot triggers**: No hooks into Claude Code's lifecycle yet. User explicitly snapshots. (Future: SessionStart/SessionEnd hooks could auto-snapshot.)
- **Merge**: No merging of diverged branches. Git does this for code; there's no meaningful merge for conversation state.
- **Diff**: No semantic diff between branches. The divergence point is known (the snapshot), but comparing conversation content is out of scope for v1.
- **KV cache management**: VMC operates at the session/message layer, not the model inference layer.
- **MCP server**: VMC is a standalone CLI, not an MCP tool the model calls. The model doesn't need to manage its own snapshots — the user does.
- **Modifying existing Claude Code sessions**: VMC only adds new session files when branching. It never modifies or deletes existing Claude-created session files.
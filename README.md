# VMC — Contextual Memory Virtualisation

Save, name, and branch from Claude Code sessions. Stop re-explaining your codebase.

## The Problem

You spend 30 minutes having Claude analyze your codebase. That context is now trapped in one session. You can't save it, branch from it, or reuse it. When the session fills up or you want to try a different approach, you start over.

VMC fixes this. Snapshot a session, branch from it unlimited times, each branch gets the full conversation history.

## Install

**Requirements:** Node.js 18+ and Claude Code CLI

```bash
# Windows (PowerShell as admin)
winget install OpenJS.NodeJS.LTS

# macOS
brew install node

# Linux (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

Then install VMC:

```bash
git clone https://github.com/CosmoNaught/vmc.git
cd vmc
npm install
npm run build
npm link
```

**Windows note:** If PowerShell blocks scripts, run once:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

If `vmc` isn't found after install, close and reopen your terminal so it picks up the new PATH.

Verify it works:

```bash
vmc --help
vmc sessions
```

## Quick Start

```bash
# Fastest way: launch the interactive dashboard
vmc

# Or use individual commands:

# 1. See all your Claude Code sessions
vmc sessions

# 2. Snapshot the most recent session
vmc snapshot "my-analysis" --latest -d "Full codebase analysis"

# 3. Branch from it (opens a new Claude session with full context)
vmc branch "my-analysis" --name "try-refactor"

# 4. Branch again — independent session, same starting point
vmc branch "my-analysis" --name "try-rewrite"

# 5. See the tree
vmc tree
```

## Dashboard

Run `vmc` with no arguments (or `vmc dashboard`) to launch the interactive TUI:

```bash
vmc
```

Three-column Ranger-style layout — projects, snapshots/sessions, and details:

```
┌─ Projects ────┬─ Snapshots / Sessions ─────┬─ Details ──────────────┐
│ ▸ d:\VMC      │ ● codebase-analyzed    82m  │ Name: codebase-analyzed│
│   d:\myproj   │   ├── implement-auth  (br)  │ Created:     2d ago    │
│   ~/other     │   └── auth-designed    95m  │ Source:  7e616107…     │
│               │ ── Sessions ──────────────  │ Messages:    82        │
│               │   7e616107…  42m    3h ago  │ Size:        2.4 MB    │
│               │   a1b2c3d4…  18m    1d ago  │ Tags:   architecture   │
│               │                             │ Branches:    3         │
├───────────────┴─────────────────────────────┴────────────────────────┤
│ [b] Branch  [s] Snapshot  [d] Delete  [e] Export  [Tab] Switch [q] Q │
└──────────────────────────────────────────────────────────────────────┘
```

**Key bindings:**

| Key | Action |
|-----|--------|
| `↑/↓` or `j/k` | Navigate within the focused pane |
| `←/→` | Collapse/expand tree nodes |
| `Tab` | Switch focus between Projects and Snapshots/Sessions |
| `b` | Branch from selected snapshot (prompts for name) |
| `s` | Snapshot selected session or latest (prompts for name) |
| `d` | Delete selected snapshot (asks confirmation) |
| `e` | Export selected snapshot to `.vmc` file |
| `i` | Import a `.vmc` file (prompts for path) |
| `Enter` | Branch from selected snapshot and launch Claude |
| `q` | Quit |

The left column lists all Claude Code projects. The middle column shows snapshots and active sessions for the selected project. The right column shows details for the selected item. Selecting a session and pressing `s` snapshots that specific session. All actions use the same core functions as the CLI commands.

## Commands

### `vmc dashboard`

Launch the interactive TUI dashboard. Same as running `vmc` with no arguments.

```bash
vmc dashboard
```

### `vmc sessions`

List all Claude Code sessions VMC can find.

```bash
vmc sessions                        # all sessions, newest first
vmc sessions -p myproject           # filter by project name
vmc sessions --sort size            # sort by message count
vmc sessions --all                  # include empty file-tracking sessions
vmc sessions --json                 # JSON output
```

Empty sessions (file-tracking only, 0 messages) are hidden by default. Use `--all` to show them.

Sessions that were snapshotted or branched via VMC are labeled in the **VMC** column (`snap: name` or `branch: name`).

This is your starting point. Find the session ID you want to snapshot.

### `vmc snapshot <name>`

Save a session's conversation state as a named snapshot.

```bash
# Snapshot a specific session (copy the ID from `vmc sessions`)
vmc snapshot "codebase-analyzed" --session 7e616107-a7ea-4844-af46-f5b3cc145d15

# Snapshot whatever session was most recently active
vmc snapshot "codebase-analyzed" --latest

# Add description and tags
vmc snapshot "auth-designed" --latest -d "Auth architecture decided" -t "auth,design"
```

What happens: VMC copies the session's JSONL file to `~/.vmc/snapshots/` and records metadata. The original session is untouched.

### `vmc branch <snapshot>`

Create a new Claude Code session forked from a snapshot. The new session has the full conversation history — Claude remembers everything.

```bash
# Branch and launch Claude immediately
vmc branch "codebase-analyzed" --name "implement-auth"

# Just create the session file, don't launch Claude
vmc branch "codebase-analyzed" --name "implement-api" --skip-launch

# Preview the command without doing anything
vmc branch "codebase-analyzed" --dry-run
```

Under the hood this copies the snapshot's JSONL to the Claude project directory with a new session ID, then runs `claude --resume <new-id>`.

### `vmc list`

Show all snapshots.

```bash
vmc list                            # all snapshots
vmc list --tag auth                 # filter by tag
vmc list --sort branches            # sort by branch count
vmc list --sort name                # sort alphabetically
vmc list --json                     # JSON output
```

### `vmc tree`

Show the snapshot/branch hierarchy.

```bash
vmc tree
```

```
codebase-analyzed (snapshot, 2d ago, 82 msgs)
├── implement-auth (branch, 2d ago)
├── implement-api (branch, 1d ago)
└── auth-designed (snapshot, 1d ago, 95 msgs)
    ├── auth-frontend (branch, 1d ago)
    └── auth-backend (branch, 23h ago)
```

```bash
vmc tree --depth 1                  # limit depth
vmc tree --json                     # JSON output
```

### `vmc info <name>`

Show everything about a snapshot.

```bash
vmc info "codebase-analyzed"
```

Shows: ID, creation date, source session, project path, message count, JSONL size, description, tags, parent lineage, and all branches.

### `vmc delete <name>`

Delete a snapshot and its stored files.

```bash
vmc delete "old-snapshot"           # asks for confirmation
vmc delete "old-snapshot" -f        # skip confirmation
```

### `vmc export <name>`

Package a snapshot as a portable `.vmc` file for sharing or backup.

```bash
vmc export "codebase-analyzed"                          # creates ./codebase-analyzed.vmc
vmc export "codebase-analyzed" -o ~/backups/analysis.vmc  # custom path
```

### `vmc import <path>`

Import a snapshot from a `.vmc` file.

```bash
vmc import ./codebase-analyzed.vmc                     # import as-is
vmc import ./codebase-analyzed.vmc --rename "imported"  # rename on import
vmc import ./codebase-analyzed.vmc --force              # overwrite if exists
```

### `vmc config`

View or set configuration.

```bash
vmc config                                    # show all settings
vmc config claude_cli_path                    # show one setting
vmc config claude_cli_path /usr/local/bin/claude  # set claude path
```

**Settings:**

| Key | Description | Default |
|-----|-------------|---------|
| `claude_cli_path` | Path to claude CLI executable | `claude` (uses PATH) |
| `default_project` | Default project filter for `vmc sessions` | none |

### `vmc completions`

Install shell tab-completion for all VMC commands, options, snapshot names, and session IDs.

```bash
vmc completions                     # output completion script
vmc completions --install           # install to your shell profile
vmc completions powershell          # force PowerShell format
vmc completions bash                # force bash format
```

Supports PowerShell (default on Windows) and bash. After installing, restart your terminal.

## Workflows

### Save expensive analysis, branch for each task

```bash
# Have Claude analyze your codebase (in Claude Code)
# ... long conversation about architecture ...

# Save it
vmc snapshot "full-analysis" --latest -d "Complete codebase analysis"

# Branch for each task — each gets the full context
vmc branch "full-analysis" --name "add-auth"
vmc branch "full-analysis" --name "add-api"
vmc branch "full-analysis" --name "refactor-db"
```

### Chain snapshots for deep work

```bash
# Snapshot after initial analysis
vmc snapshot "analyzed" --latest

# Branch, do auth design work in that session
vmc branch "analyzed" --name "auth-work"

# ... work in the auth session ...

# Snapshot the auth session too
vmc snapshot "auth-designed" --session <auth-session-id> -t "auth"

# Now branch from the auth snapshot for frontend vs backend
vmc branch "auth-designed" --name "auth-frontend"
vmc branch "auth-designed" --name "auth-backend"
```

### Try multiple approaches

```bash
vmc snapshot "before-refactor" --latest

vmc branch "before-refactor" --name "approach-a"
# ... try approach A ...

vmc branch "before-refactor" --name "approach-b"
# ... try approach B ...

# Compare results, pick the winner
```

### Share context with teammates

```bash
# You: export your analysis
vmc export "codebase-analyzed" -o ./team-context.vmc

# Teammate: import and branch
vmc import ./team-context.vmc
vmc branch "codebase-analyzed" --name "my-task"
```

## Storage

VMC stores everything in `~/.vmc/`:

```
~/.vmc/
├── index.json              # Master index of all snapshots and branches
├── config.json             # Settings
└── snapshots/
    └── snap_a1b2c3d4/
        ├── meta.json       # Snapshot metadata (portable)
        └── session/
            └── <id>.jsonl  # Copy of the Claude session file
```

VMC reads session data from `~/.claude/` for discovery. When branching, it copies the snapshot's JSONL into the Claude project directory with a new session ID and updates `sessions-index.json`, then resumes the new session via `claude --resume`.

## Troubleshooting

**`vmc sessions` shows nothing**
- Make sure you've used Claude Code at least once. VMC reads from `~/.claude/projects/`.

**`vmc sessions` is missing a project**
- Some projects may not have a `sessions-index.json` yet. VMC falls back to scanning `.jsonl` files directly, but the project directory must exist under `~/.claude/projects/`.

**`vmc branch` fails to launch**
- Check that `claude` is in your PATH: `claude --version`
- Or set the path explicitly: `vmc config claude_cli_path "C:\Users\you\.local\bin\claude.exe"`

**Snapshot warns "session appears active"**
- You're snapshotting a session that's currently in use. The snapshot may be incomplete. Best to exit the Claude session first, then snapshot.

**Windows: `vmc` not recognized**
- Close and reopen your terminal after installing Node.js
- If using PowerShell, run: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

## Debug

Set `VMC_DEBUG=1` for full stack traces on errors:

```bash
VMC_DEBUG=1 vmc sessions
```

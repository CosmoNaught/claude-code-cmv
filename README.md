# CMV — Contextual Memory Virtualisation

Save, name, and branch from Claude Code sessions. Stop re-explaining your codebase.

## The Problem

You spend 30 minutes having Claude analyze your codebase. That context is now trapped in one session. You can't save it, branch from it, or reuse it. When the session fills up or you want to try a different approach, you start over.

CMV fixes this. Snapshot a session, branch from it unlimited times, each branch gets the full conversation history.

## Install

**Requirements:** Node.js 18+ and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### Windows

Install Node.js (if not already installed):

```powershell
winget install OpenJS.NodeJS.LTS
```

If PowerShell blocks scripts, run this once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Install CMV:

```powershell
git clone https://github.com/CosmoNaught/cmv.git
cd cmv
npm install
npm run build
npm link
```

Verify:

```powershell
cmv --help
cmv sessions
```

> **`cmv` not found?** Close and reopen your terminal so it picks up the new PATH. If it still doesn't work, check that `%APPDATA%\npm` is on your PATH.

### Linux

Install Node.js 18+ using your package manager:

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

</details>

<details>
<summary><strong>Fedora / RHEL</strong></summary>

```bash
sudo dnf install -y nodejs
```

</details>

<details>
<summary><strong>Arch</strong></summary>

```bash
sudo pacman -S nodejs npm
```

</details>

<details>
<summary><strong>Any distro (nvm)</strong></summary>

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts
```

</details>

Install CMV:

```bash
git clone https://github.com/CosmoNaught/cmv.git
cd cmv
npm install
npm run build
npm link
```

Verify:

```bash
cmv --help
cmv sessions
```

> **Permission error on `npm link`?** Either use `sudo npm link`, or install Node via nvm (which doesn't need sudo for global packages).
>
> **`cmv` not found?** Make sure `/usr/local/bin` is on your PATH. If you used nvm, run `source ~/.bashrc` first.

### macOS

Install Node.js (if not already installed):

```bash
brew install node
```

Or use [nvm](https://github.com/nvm-sh/nvm) if you prefer to manage Node versions.

Install CMV:

```bash
git clone https://github.com/CosmoNaught/cmv.git
cd cmv
npm install
npm run build
npm link
```

Verify:

```bash
cmv --help
cmv sessions
```

## Quick Start

```bash
# Fastest way: launch the interactive dashboard
cmv

# Or use individual commands:

# 1. See all your Claude Code sessions
cmv sessions

# 2. Snapshot the most recent session
cmv snapshot "my-analysis" --latest -d "Full codebase analysis"

# 3. Branch from it (opens a new Claude session with full context)
cmv branch "my-analysis" --name "try-refactor"

# 4. Branch again — independent session, same starting point
cmv branch "my-analysis" --name "try-rewrite"

# 5. See the tree
cmv tree
```

## Dashboard

Run `cmv` with no arguments (or `cmv dashboard`) to launch the interactive TUI:

```bash
cmv
```

Three-column Ranger-style layout — projects, snapshots/sessions, and details:

```
┌─ Projects ────┬─ Snapshots / Sessions ─────┬─ Details ──────────────┐
│ ▸ d:\CMV      │ ● codebase-analyzed    82m  │ Name: codebase-analyzed│
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
| `d` | Delete selected snapshot or branch (asks confirmation) |
| `e` | Export selected snapshot to `.cmv` file |
| `i` | Import a `.cmv` file (prompts for path) |
| `Enter` | Branch from selected snapshot and launch Claude |
| `q` | Quit |

The left column lists all Claude Code projects. The middle column shows snapshots and active sessions for the selected project. The right column shows details for the selected item. Selecting a session and pressing `s` snapshots that specific session. Selecting a branch and pressing `d` deletes it along with its session file. All actions use the same core functions as the CLI commands.

## Commands

### `cmv dashboard`

Launch the interactive TUI dashboard. Same as running `cmv` with no arguments.

```bash
cmv dashboard
```

### `cmv sessions`

List all Claude Code sessions CMV can find.

```bash
cmv sessions                        # all sessions, newest first
cmv sessions -p myproject           # filter by project name
cmv sessions --sort size            # sort by message count
cmv sessions --all                  # include empty file-tracking sessions
cmv sessions --json                 # JSON output
```

Empty sessions (file-tracking only, 0 messages) are hidden by default. Use `--all` to show them.

Sessions that were snapshotted or branched via CMV are labeled in the **CMV** column (`snap: name` or `branch: name`).

This is your starting point. Find the session ID you want to snapshot.

### `cmv snapshot <name>`

Save a session's conversation state as a named snapshot.

```bash
# Snapshot a specific session (copy the ID from `cmv sessions`)
cmv snapshot "codebase-analyzed" --session 7e616107-a7ea-4844-af46-f5b3cc145d15

# Snapshot whatever session was most recently active
cmv snapshot "codebase-analyzed" --latest

# Add description and tags
cmv snapshot "auth-designed" --latest -d "Auth architecture decided" -t "auth,design"
```

What happens: CMV copies the session's JSONL file to `~/.cmv/snapshots/` and records metadata. The original session is untouched.

### `cmv branch <snapshot>`

Create a new Claude Code session forked from a snapshot. The new session has the full conversation history — Claude remembers everything.

```bash
# Branch and launch Claude immediately
cmv branch "codebase-analyzed" --name "implement-auth"

# Just create the session file, don't launch Claude
cmv branch "codebase-analyzed" --name "implement-api" --skip-launch

# Preview the command without doing anything
cmv branch "codebase-analyzed" --dry-run
```

Under the hood this copies the snapshot's JSONL to the Claude project directory with a new session ID, then runs `claude --resume <new-id>`.

### `cmv list`

Show all snapshots.

```bash
cmv list                            # all snapshots
cmv list --tag auth                 # filter by tag
cmv list --sort branches            # sort by branch count
cmv list --sort name                # sort alphabetically
cmv list --json                     # JSON output
```

### `cmv tree`

Show the snapshot/branch hierarchy.

```bash
cmv tree
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
cmv tree --depth 1                  # limit depth
cmv tree --json                     # JSON output
```

### `cmv info <name>`

Show everything about a snapshot.

```bash
cmv info "codebase-analyzed"
```

Shows: ID, creation date, source session, project path, message count, JSONL size, description, tags, parent lineage, and all branches.

### `cmv delete <name>`

Delete a snapshot and its stored files. To delete individual branches, use the `d` key in the TUI dashboard.

```bash
cmv delete "old-snapshot"           # asks for confirmation
cmv delete "old-snapshot" -f        # skip confirmation
```

### `cmv export <name>`

Package a snapshot as a portable `.cmv` file for sharing or backup.

```bash
cmv export "codebase-analyzed"                          # creates ./codebase-analyzed.cmv
cmv export "codebase-analyzed" -o ~/backups/analysis.cmv  # custom path
```

### `cmv import <path>`

Import a snapshot from a `.cmv` file.

```bash
cmv import ./codebase-analyzed.cmv                     # import as-is
cmv import ./codebase-analyzed.cmv --rename "imported"  # rename on import
cmv import ./codebase-analyzed.cmv --force              # overwrite if exists
```

### `cmv config`

View or set configuration.

```bash
cmv config                                    # show all settings
cmv config claude_cli_path                    # show one setting
cmv config claude_cli_path /usr/local/bin/claude  # set claude path
```

**Settings:**

| Key | Description | Default |
|-----|-------------|---------|
| `claude_cli_path` | Path to claude CLI executable | `claude` (uses PATH) |
| `default_project` | Default project filter for `cmv sessions` | none |

### `cmv completions`

Install shell tab-completion for all CMV commands, options, snapshot names, and session IDs.

```bash
cmv completions                     # output completion script
cmv completions --install           # install to your shell profile
cmv completions powershell          # force PowerShell format
cmv completions bash                # force bash format
```

Supports PowerShell (default on Windows) and bash. After installing, restart your terminal.

## Workflows

### Save expensive analysis, branch for each task

```bash
# Have Claude analyze your codebase (in Claude Code)
# ... long conversation about architecture ...

# Save it
cmv snapshot "full-analysis" --latest -d "Complete codebase analysis"

# Branch for each task — each gets the full context
cmv branch "full-analysis" --name "add-auth"
cmv branch "full-analysis" --name "add-api"
cmv branch "full-analysis" --name "refactor-db"
```

### Chain snapshots for deep work

```bash
# Snapshot after initial analysis
cmv snapshot "analyzed" --latest

# Branch, do auth design work in that session
cmv branch "analyzed" --name "auth-work"

# ... work in the auth session ...

# Snapshot the auth session too
cmv snapshot "auth-designed" --session <auth-session-id> -t "auth"

# Now branch from the auth snapshot for frontend vs backend
cmv branch "auth-designed" --name "auth-frontend"
cmv branch "auth-designed" --name "auth-backend"
```

### Try multiple approaches

```bash
cmv snapshot "before-refactor" --latest

cmv branch "before-refactor" --name "approach-a"
# ... try approach A ...

cmv branch "before-refactor" --name "approach-b"
# ... try approach B ...

# Compare results, pick the winner
```

### Share context with teammates

```bash
# You: export your analysis
cmv export "codebase-analyzed" -o ./team-context.cmv

# Teammate: import and branch
cmv import ./team-context.cmv
cmv branch "codebase-analyzed" --name "my-task"
```

## Storage

CMV stores everything in `~/.cmv/`:

```
~/.cmv/
├── index.json              # Master index of all snapshots and branches
├── config.json             # Settings
└── snapshots/
    └── snap_a1b2c3d4/
        ├── meta.json       # Snapshot metadata (portable)
        └── session/
            └── <id>.jsonl  # Copy of the Claude session file
```

CMV reads session data from `~/.claude/` for discovery. When branching, it copies the snapshot's JSONL into the Claude project directory with a new session ID and updates `sessions-index.json`, then resumes the new session via `claude --resume`.

## Troubleshooting

**`cmv sessions` shows nothing**
- Make sure you've used Claude Code at least once. CMV reads from `~/.claude/projects/`.

**`cmv sessions` is missing a project**
- Some projects may not have a `sessions-index.json` yet. CMV falls back to scanning `.jsonl` files directly, but the project directory must exist under `~/.claude/projects/`.

**`cmv branch` fails to launch**
- Check that `claude` is in your PATH: `claude --version`
- Or set the path explicitly: `cmv config claude_cli_path /usr/local/bin/claude` (Linux/macOS) or `cmv config claude_cli_path "C:\Users\you\.local\bin\claude.exe"` (Windows)

**Snapshot warns "session appears active"**
- You're snapshotting a session that's currently in use. The snapshot may be incomplete. Best to exit the Claude session first, then snapshot.

**Windows: `cmv` not recognized**
- Close and reopen your terminal after installing Node.js
- If using PowerShell, run: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

**Linux: `EACCES` permission error on `npm link`**
- Use `sudo npm link`, or switch to nvm which doesn't require root for global installs.

**Linux: `cmv` not found after install**
- If you used nvm, open a new terminal or run `source ~/.bashrc`.
- If you used a system package manager, check that `/usr/local/bin` is on your PATH: `echo $PATH`
- You can also run CMV directly: `node /path/to/cmv/dist/index.js`

**Linux: TUI dashboard looks garbled**
- Make sure your terminal supports 256 colors. Most modern terminals (GNOME Terminal, Konsole, Alacritty, kitty) work fine.
- If over SSH, ensure `TERM` is set correctly: `echo $TERM` should show something like `xterm-256color`.

## Debug

Set `CMV_DEBUG=1` for full stack traces on errors:

```bash
CMV_DEBUG=1 cmv sessions
```

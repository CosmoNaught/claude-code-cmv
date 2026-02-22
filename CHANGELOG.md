# Changelog

All notable changes to CMV are documented here. Follows [Semantic Versioning](https://semver.org/).

---

## [2.0.0] — 2026-02-22

### Added

- **TUI overhaul — two-column, four-pane layout.** Projects and details on the left, snapshots and sessions split into separate boxes on the right. Stable 50/50 height split.
- **Sessions open in new terminal windows.** `Enter` on a branch or session spawns `claude --resume` in a new OS window (Windows `start`, macOS Terminal.app, Linux auto-detects terminal emulator). The TUI stays running — no more exiting to open sessions.
- **Enter on snapshot branches and opens** in one step — prompts for a branch name, creates the branch (trimmed), and launches it in a new window.
- **Live session status detection.** Hybrid approach: polls OS process list + monitors JSONL file growth + reads last line type. Three states: active (green `●`, Claude waiting for input), busy (amber `●`, Claude working), idle (grey `○`, no process). Shown in tree pane branch dots and detail pane.
- **Project summary view** — details pane shows session/snapshot/branch counts, total messages, and activity timestamps when browsing the project list.
- **Auto-trim hooks** — `cmv hook install` registers PreCompact and PostToolUse hooks with Claude Code. PreCompact trims before compaction fires. PostToolUse checks file size on every tool call and trims when context exceeds ~600KB (1ms overhead otherwise). Auto-backup before each trim with rotation.
- **Auto-install hooks on `npm install`** — postinstall script registers hooks into Claude Code settings automatically. Failures are swallowed so install never breaks.
- **Batch branching** — press `m` on a snapshot in the TUI to create multiple branches at once. Each branch gets an orientation message injected so Claude knows its focus area.
- **Hook management CLI** — `cmv hook install`, `cmv hook uninstall`, `cmv hook status`, `cmv hook restore`.
- **Auto-backup system** — `src/core/auto-backup.ts` with save, list, restore, and rotate.
- **Orphaned tool_result stripping** — trimmer now collects tool_use IDs from skipped pre-compaction content and strips tool_result blocks that reference them. Fixes API errors on trimmed sessions where tool_results referenced tool_use blocks that lived before the compaction boundary.
- `r` key to refresh in the TUI.
- `getRunningSessionIds()` — queries OS process list for live `claude --resume` sessions.
- `spawnClaudeInNewWindow()` — cross-platform new terminal window spawning.

### Changed

- **Branch now trims by default.** Use `--no-trim` for raw context. This is a breaking change to CLI behavior.
- TUI branch action (`b` key) trims by default.
- TUI no longer exits when opening sessions — all actions happen in new windows while the dashboard stays open.
- DashboardResult simplified to `quit` only — branch/resume actions are handled internally.
- ActionBar is now context-aware based on which pane has focus.
- TreePane splits snapshots and sessions into separate bordered boxes with independent scroll.

### Removed

- **Session viewer** — the in-TUI JSONL watcher (`SessionViewer.tsx`) has been removed. Sessions now open directly in new terminal windows.
- `t` (trim) key removed from TUI — trimming happens automatically on branch creation.

---

## [1.2.0] — 2026-02-21

### Added

- Test suite (vitest): 30 tests covering trimmer, session-reader, and cache-analyzer.
  - Trimmer: file-history removal, queue-op removal, tool_result stubbing, image stripping, thinking block removal, tool_use input stubbing, pre-compaction skipping, usage stripping, threshold options, byte metrics, conversation preservation.
  - Session reader: cwd extraction from JSONL, version extraction.
  - Cache analyzer: token estimation, removal ratio cap, tool_use savings factor, stub overhead accounting.

---

## [1.1.1] — 2026-02-21

### Fixed

- macOS: parse cwd from JSONL session data instead of ambiguous dash-encoded directory names (thanks @KaustubhPatange).
- macOS: resolve full claude CLI path via `command -v` to fix spawn ENOENT, graceful fallback when stored cwd no longer exists (thanks @nrolland).

---

## [1.1.0] — 2026-02-21

### Added

- **Image block stripping** — base64 screenshots in tool results are now always stripped. Previously invisible to the trimmer (it only measured text blocks), images could be 50-200KB each and were silently preserved.
- **`tool_use` input stubbing** — Write/Edit/NotebookEdit tool calls had full file contents in their input, never touched by trim. Now large input fields are stubbed. Broad fallback catches any tool with oversized string inputs (Task prompts, Bash heredocs, etc.) while preserving identification fields (`file_path`, `command`, `pattern`).
- **Pre-compaction content skipping** — two-pass approach finds the last compaction boundary and skips all dead lines before it. These lines were never sent to the API but were being copied into trimmed output.
- **`queue-operation` entry removal** — internal scheduling metadata now skipped (same treatment as `file-history-snapshot`).
- **Configurable stub threshold** — `--threshold <chars>` flag on `cmv trim` and `cmv branch --trim`. Defaults to 500, minimum 50. Lower values = more aggressive trimming.
- **`cmv benchmark` command** — was written in v1.0.1 but never wired into the CLI. Now registered and functional.

### Changed

- Trimmer refactored from duplicated inline logic into `processContentArray` and `stubToolUseInput` helpers, eliminating copy-paste between the two JSONL content formats.
- Cache analyzer estimation now includes tool_use input savings (30% factor) alongside existing tool result and thinking block estimates.
- Trim metrics output shows new categories (images, tool inputs, pre-compaction lines, queue-ops) when present.

---

## [1.0.1] — 2026-02-19

### Added

- Cache impact analysis with benchmark data across 33 real sessions ([docs/CACHE_IMPACT_ANALYSIS.md](docs/CACHE_IMPACT_ANALYSIS.md)).
- `cmv benchmark` command with visual charts — context usage bars, composition breakdown, cost projections, break-even analysis.
- Benchmark supports multiple pricing models (Sonnet 4, Opus 4.6, Opus 4/4.1, Haiku 4.5).

### Fixed

- Thinking block field name bug — analyzer was reading `block.text` instead of `block.thinking`, causing ~5k tokens per session to be invisible to the token estimator.

---

## [1.0.0] — 2026-02-17

Initial release.

### Core

- **Snapshot** — capture session state to named checkpoints with metadata, tags, and descriptions.
- **Branch** — fork from any snapshot into a new independent session. Full conversation history preserved.
- **Trim** — strip mechanical overhead (tool results >500 chars, thinking block signatures, file-history snapshots, API usage metadata) while keeping all conversation content. Typical 50-70% reduction.
- **Tree** — view snapshot/branch lineage as a hierarchy.

### TUI

- Three-pane Ranger-style dashboard (`cmv` with no arguments).
- Context breakdown in detail pane — shows what's eating your tokens and how much is trimmable.
- Keyboard-driven: `b` branch, `t` trim, `s` snapshot, `d` delete, `e`/`i` export/import.

### CLI

- `cmv sessions` — list Claude Code sessions, filter by project, sort by size.
- `cmv snapshot` / `cmv branch` / `cmv trim` / `cmv list` / `cmv tree` / `cmv info` / `cmv delete`.
- `cmv export` / `cmv import` — portable `.cmv` archives for sharing context.
- `cmv config` — settings (Claude CLI path, default project).
- `cmv completions --install` — shell tab-completion.

### Platform

- Windows and Linux support.
- Session reader with compaction boundary awareness.
- Streaming JSONL processing for memory efficiency.

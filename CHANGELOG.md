# Changelog

All notable changes to CMV are documented here. Follows [Semantic Versioning](https://semver.org/).

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

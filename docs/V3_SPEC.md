# CMV v3.0 Spec — Agent-Driven Context Management

**Codename:** "Claude drives"
**Status:** Draft for review
**Date:** 2026-06-09

---

## One-liner

CMV v3.0 turns CMV from a CLI a human drives into a context-management surface
**Claude itself drives**: the agent snapshots, curates, trims, restores, and
branches its own context window mid-loop — verbatim and reversibly, not via
lossy summaries.

CMV v1/v2 is virtual memory where the user does the paging by hand.
v3.0 is the MMU: **Claude page-faults and swaps its own context.**

> Note: this deliberately reverses the v2 non-goal recorded in
> `docs/outline.md` ("The model doesn't need to manage its own snapshots — the
> user does"). That position predates agent teams, the compaction beta, and
> the 2026 loops/harness shift. v3.0 is the explicit pivot.

---

## Why now (June 2026)

- **The harness era.** The discourse has moved from "better prompts" to
  "better harnesses": long-running loops, agent teams, self-evaluating agents.
  Loops die of context exhaustion; every serious loop pattern (Ralph
  Wiggum-style Stop-hook loops, overnight runs) hits the 200k wall and gets
  lobotomized by auto-compact.
- **Anthropic has validated the pattern at the API level** — the memory tool
  and the compaction beta (`compact-2026-01-12`) are exactly "the model
  manages its own context" — but nothing productizes this for Claude Code
  sessions with *restorable, verbatim* state.
- **Agent teams shipped (experimental)** with a documented gap: teammates
  don't inherit the lead's conversation history, and there is an open feature
  request for shared team memory on Anthropic's own tracker
  (anthropics/claude-code#38536).

---

## Prior-art audit (verified 2026-06-09)

| Tool | Stars | Mechanism | What it does NOT do |
|---|---|---|---|
| **context-mode** (mksglu) | ~16.8k | Hooks + MCP sandbox: intercepts tool output *before* it enters context; ≤2KB summary snapshot in SQLite survives compaction | No verbatim session state; no restore-to-point or branching; hook-enforced routing, not agent-chosen operations |
| **claude-mem** (thedotmack) | very large | AI semantic compression of session observations → SQLite/vectors, injected next session | Lossy summaries only; no live context-window management; no agent-teams focus |
| **claude-memory-compiler** (coleam00) | mid | Hooks capture sessions → LLM compiles knowledge articles | Summaries/notes, not context state; next-session injection only |
| **claude-teams-brain** (Gr122lyBr) | 27 | Hooks inject ≤6KB role-based memory summaries into teammates | Summaries only; no transcript state transfer |
| **agentmemory** (rohitg00) | mid | Lifecycle hooks: capture → compress → inject | Same summary paradigm |
| **Claude Code native** | — | `/compact` + auto-compact (lossy, irreversible), `/rewind` checkpoints (within-session, not cross-session, not branchable), API context editing | Compaction can't be undone; no named snapshots; no forking; the *model* doesn't choose what survives |

**Novelty claim (precise):** No shipped tool lets the agent itself perform
**verbatim, restorable, branchable** operations on its **own full session
state** inside Claude Code. Every existing tool is either (a) lossy summary
injection, (b) input-side bloat prevention, or (c) harness-driven with no
agent agency. The combination — *agent-invoked + lossless + reversible +
branchable* — is unclaimed. The closest ideas exist as Anthropic API
patterns (memory tool, compaction beta), which is validation, not
competition, at the Claude Code layer.

**Honest risks to this claim:**
1. context-mode (16.8k stars, well-resourced) could add verbatim
   snapshot/branch. Mitigation: speed; their ELv2 license and
   prevention-first architecture point a different direction.
2. Anthropic could productize the compaction beta into Claude Code natively.
   Mitigation: that validates the category; CMV's verbatim+branch model
   remains differentiated vs. summarization, and "we shipped it first as a
   community tool" is itself the story.

---

## Why this matters day-to-day (the user-facing pitch)

1. **Auto-compact stops eating your session.** Today: 30 minutes of built-up
   understanding hits 95% context and gets squashed into a paragraph,
   mid-task, irreversibly. v3.0: Claude notices pressure at ~75%, snapshots
   (insurance), trims tool-result bloat (85% reduction, conversation verbatim),
   and keeps going. If anything is lost, restore is one command.
2. **Loops survive the night.** Long-running autonomous loops currently die
   of context exhaustion or compact themselves into amnesia. A loop that can
   shed its own dead weight runs for hours instead of turns. This is the
   single biggest unlock for the "loops/harness" crowd.
3. **Branch before risk.** Claude snapshots before a risky refactor or
   exploratory tangent; a dead end costs a restore, not a session.
4. **Teammates start warm.** A lead spawns agent-team workers from its own
   snapshot — every teammate begins with the lead's actual mental model,
   not a spawn-prompt summary.
5. **Pure win for Pro/Max subscribers.** Flat-fee users pay nothing for the
   post-trim cache miss; trimming is strictly more usable context (see
   `docs/CACHE_IMPACT_ANALYSIS.md`). API users break even in 3–10 turns on
   tool-heavy sessions.

---

## Feature spec

### F1 — Agent surface: CMV plugin (P0)

Package CMV as a Claude Code **plugin** exposing slash commands + a skill:

- `/cmv:status` — run context analysis on the *current* session
  (wraps `analyzeSession()`, `src/core/analyzer.ts`): tokens, % full,
  tool-result bloat breakdown, projected post-trim size.
- `/cmv:snapshot <name>` — snapshot the current session
  (wraps `createSnapshot()`, `src/core/snapshot-manager.ts:40-163`).
- `/cmv:trim` — snapshot → trim → continue (see F2 flow).
- `/cmv:restore <name>` / `/cmv:branch <name>` — fork from a snapshot
  (wraps `createBranch()`, `src/core/branch-manager.ts:38-189`).
- **Skill** (`SKILL.md`): teaches Claude *when* to use these — context
  pressure thresholds, pre-risk snapshots, what trimming preserves/loses,
  cache-cost tradeoffs. The skill is the "policy"; commands are the
  "mechanism."

The current session's ID/transcript path comes from the hook/command
environment (`session_id`, `transcript_path` — same stdin contract
`cmv auto-trim` already consumes, `src/commands/auto-trim.ts:78-145`).

New CLI verb: `cmv self <op>` — like existing commands but resolves "the
session I am running inside" instead of `--latest`. Mostly argument plumbing
around existing managers.

### F2 — The self-trim loop (P0, the headline)

Flow when Claude invokes `/cmv:trim` (or the skill decides at ~75% pressure):

1. `cmv self snapshot --auto-name` — insurance copy (existing machinery).
2. `cmv self trim` — produce trimmed JSONL via `trimJsonl()`
   (`src/core/trimmer.ts:171-350`).
3. **The resume hop (key design constraint):** the running CLI holds the
   conversation in memory; rewriting the JSONL does not shrink the live
   window. Two paths, ship (a), explore (b):
   - **(a) Branch-and-resume:** trim into a new session ID (existing
     `branch` path), then instruct the user/harness to continue via
     `claude --resume <newId>`. Deterministic, works today — the v2 README
     before/after screenshots already use this flow.
   - **(b) In-place + compact-trigger:** trim in place (existing atomic
     temp-file + rename from auto-trim), then trigger the harness's reload
     path. Fragile, version-dependent — research spike only.
4. Post-resume, Claude states what was trimmed (from `TrimMetrics`) and
   continues the task.

### F3 — Curated trim: "Claude decides what to keep" (P1, the novel bit)

Extend `trimJsonl()` with a **keep-list**:

- Claude writes `~/.cmv/keep/{sessionId}.json`: message UUIDs / ranges /
  tool-use IDs that must survive verbatim ("keep the auth architecture
  read", "the migration debugging is dead weight").
- `TrimOptions` gains `keepIds: string[]`; pass 3 of the trimmer
  (`src/core/trimmer.ts:250-336`) consults it before stubbing.
- The skill instructs Claude to curate *before* invoking trim.

This is the memory-tool pattern applied to whole-session state — the part
no one else has. Summaries tools let Claude write notes; this lets Claude
decide what stays in its actual context window.

### F4 — Team warm-start (P1)

- `cmv branch <snapshot> --count N` — N trimmed forks from one snapshot.
- **SessionStart hook** (`matcher` on teammate spawns): when an agent-team
  teammate starts, return the lead's designated snapshot digest as
  `additionalContext` — teammates can't have their JSONL pre-seeded (the
  harness creates it), so injection is the mechanism; full-fork is for
  manually-spawned workers via worktrees.
- Answers anthropics/claude-code#38536; agent teams are experimental, so
  this ships behind a `cmv config set teams.enabled true` flag.

### F5 — Auto-snapshot policy (P2)

- SessionStart/SessionEnd hooks: snapshot ring buffer (reuse
  `src/core/auto-backup.ts` rotation) — "time machine for sessions."
- PreCompact already hooks `cmv auto-trim`; add snapshot-before-trim there
  by default (it already backs up — promote backup to a real named snapshot).

---

## Implementation map

| Piece | Reuses | New work | Est. |
|---|---|---|---|
| Plugin scaffold (commands + skill) | — | plugin.json, 5 command .md files, SKILL.md | 1–2 days |
| `cmv self` verb | session-reader, analyzer, snapshot-manager | arg plumbing, stdin/env session resolution | 1–2 days |
| Self-trim loop (F2a) | trimmer, branch-manager, auto-backup | orchestration command + resume messaging | 2–3 days |
| Keep-list trim (F3) | trimmer pass 3 | `keepIds` option, keep-file protocol, skill guidance | 2–3 days |
| Team warm-start (F4) | branch-manager | `--count`, SessionStart additionalContext hook | 3–4 days |
| Docs + demo GIF + launch post | README assets pipeline | — | 2 days |

**Total: roughly 2–3 weeks part-time.** No new core engines — every heavy
piece (trim, snapshot, branch, analyze, atomic writes, backups) exists and
has 96% test coverage behind it.

---

## Open questions / risks

1. **Live-reload semantics (F2b):** does any supported path shrink the live
   window without a resume hop? Needs a spike against current Claude Code;
   ship F2a regardless.
2. **Cache invalidation UX:** post-trim cache miss is real for API users
   (break-even 3–10 turns, `docs/CACHE_IMPACT_ANALYSIS.md`). The skill must
   teach Claude *not* to trim conversational (low-bloat) sessions. `/cmv:status`
   should surface projected break-even before trimming.
3. **Skill-invocation reliability:** will Claude actually reach for the
   skill at pressure? Mitigation: PostToolUse hook already watches size —
   have it *suggest* (inject a notice) rather than only act, so agent
   judgment and automation cooperate (context-mode's data: hooks raise
   compliance ~60%→98%).
4. **Version coupling:** JSONL format and sessions-index.json are
   undocumented internals (existing risk, unchanged — but agent-facing
   failures are more visible than CLI failures; fail silent-and-safe like
   auto-trim does today).

---

## Launch plan (the actual goal)

- **Demo GIF:** split screen — context meter at 76%, Claude says "I'm
  snapshotting and trimming myself," meter drops to 12%, work continues.
  Caption: **"Claude Code just managed its own memory."**
- **Post 1 (X):** the GIF + "compaction is lossy and irreversible; this is
  verbatim and restorable. Like virtual memory, but the model is the MMU."
- **Post 2 (LinkedIn):** harness-era framing — loops die of context
  exhaustion; self-managed context is the missing harness primitive; paper
  link.
- **GitHub:** comment with the working demo on anthropics/claude-code#38536.
- Submit plugin to marketplaces (claudemarketplaces.com etc.) same day.

## Out of scope (v3.0)

- Semantic compression/summarization (stay differentiated: verbatim only).
- Branch merge/diff.
- Non-Claude-Code agents (Codex/Gemini portability) — later, the trimmer is
  format-coupled anyway.
- Full MCP server — slash commands + skill cover the surface with less to
  maintain; revisit if plugin telemetry shows demand.

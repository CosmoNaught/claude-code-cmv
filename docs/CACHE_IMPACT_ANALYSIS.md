# CMV Cache Impact Analysis

## Context

CMV's `trim` feature reduces context window usage by stripping mechanical overhead (tool results, thinking block signatures, file-history snapshots) from Claude Code session data. A natural question arose during community discussion: **does trimming invalidate prompt caching in a way that increases costs?**

This document presents empirical data from 33 real Claude Code sessions to answer that question. It also identifies what this analysis covers and what remains open for future work.

---

## TL;DR

- **Most Claude Code users pay a flat subscription** (Pro $20/mo, Max $100-200/mo). For them, per-token costs don't apply — **trimming is purely a context window optimization with no cost implications.**
- **For API-key users**, trimming causes a one-time cache miss costing $0.07-0.22 for typical sessions (up to $0.56 for sessions near the 200k context limit). This is recovered within 3-45 turns of continued conversation. **Over any non-trivial session, trimming is cost-neutral to cost-positive.**
- **Trimming in CMV is only available during snapshotting**, which creates a new branch for a different task. **This reduces the likelihood that stripped tool results would have been needed downstream.**
- **Open question**: whether stripping tool results affects response quality on the new branch. **This analysis covers cost only.** Quality impact measurement is planned. However, from qualitative results the author has yet to note meaningful degradation across snapshot trimmed tasks.
  
---

## Background

Claude Code sends the full conversation history as input tokens on every API call. Over a long session, this context accumulates mechanical overhead:

- **Tool results** — full file contents, grep output, command results (often 5-50k chars each)
- **Thinking block signatures** — cryptographic signatures on every thinking block
- **File-history snapshots** — periodic dumps of working directory state

CMV's `trim` feature removes this overhead when creating a snapshot/branch, reducing the token count sent to the API. Because Anthropic uses [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), trimming changes the prompt prefix and causes a cache miss on the first subsequent turn. Since cache writes cost 1.25x base price while cache reads cost 0.1x, this miss introduces a one-time cost penalty.

The question is whether subsequent per-turn savings (from caching a smaller prefix) recover that penalty.

---

## Methodology

### Data Collection
- Scanned all Claude Code sessions from `~/.claude/projects/`
- Excluded subagent sessions (internal Claude processes)
- Filtered out sessions with <10 messages or <5,000 tokens
- **33 sessions** qualified for analysis
- All sessions are from a single user (the author). Multi-user data would strengthen these findings — see [Reproduce These Results](#reproduce-these-results) for how to contribute.

### Token Estimation
- Preferred API-reported `usage.input_tokens` from JSONL when available
- Fell back to `content_chars / 4 + 20,000` (system overhead) heuristic
- Respected compaction boundaries (Claude Code's built-in summarization)

### Trim Simulation
Mirrors the actual trim rules in `trimmer.ts`:
1. `file-history-snapshot` entries → removed entirely
2. Thinking block signatures → removed entirely
3. `tool_result` blocks > 500 chars → stubbed to ~35 bytes each
4. Everything else → preserved

We estimate that 70% of tool result bytes come from results > 500 chars. This is an assumption, not measured from the data. It is conservative in the sense that tool results in Claude Code sessions tend to be dominated by file reads and command output, which are typically large. A future version of the benchmark could measure this directly by categorizing individual tool result sizes.

### Cost Model

**These per-token costs only apply to API-key users.** Claude Code Pro/Max subscribers pay a flat monthly fee regardless of token usage.

Using [official Anthropic pricing](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) (as of February 2026):

| Model | Base Input | Cache Write (1.25x) | Cache Read (0.1x) |
|-------|-----------|--------------------|--------------------|
| Opus 4.6 | $5.00/MTok | $6.25/MTok | $0.50/MTok |
| Opus 4/4.1 | $15.00/MTok | $18.75/MTok | $1.50/MTok |
| Haiku 4.5 | $1.00/MTok | $1.25/MTok | $0.10/MTok |

Analysis below uses **Opus 4.6 pricing** as the current default Claude Code model.

### Cache Hit Rate Assumption

We assume a **90% cache hit rate** in steady state. This is not empirically measured — it is an estimate based on the observation that conversation history is append-only between turns, so most of the prompt prefix remains unchanged. Note that system prompts, tool definitions, and other prefix content can change between turns (e.g. when Claude Code updates its tool list), which would reduce the effective hit rate. The 90% figure is a modelling assumption, not a claim about actual cache behavior.

**Sensitivity**: if the real cache hit rate is lower (e.g. 70%), the absolute cost of a cache miss from trimming is smaller (because baseline costs are already higher from organic misses), and the break-even period shifts only modestly. The directional finding — that trimming recovers its cost over a non-trivial session — holds across reasonable cache hit assumptions (60-95%). The specific break-even numbers (44, 60, 3 turns) should be read as indicative rather than precise — the claim is directional, not exact.

---

## Results

### Context Reduction

| Metric | Value |
|--------|-------|
| Sessions analyzed | 33 |
| Mean token reduction | 10.9% |
| Median token reduction | 8.2% |
| Sessions with >30% reduction | 2/33 |
| Max reduction observed | 70.1% |
| Mean pre-trim tokens | ~45k |

Most sessions cluster around 5-10% reduction. The higher end of the range (30-70%) appears in sessions that have not yet been compacted by Claude Code's built-in summarizer. Post-compaction sessions, which represent the majority in a normal workflow, show more modest reduction. The 70.1% maximum is an outlier.

### Cache Cost Impact (Opus 4.6, API-key users only)

| Metric | Value |
|--------|-------|
| Mean cache miss penalty | $0.07-0.22 |
| Mean savings per turn | $0.003-0.02 |
| Mean break-even | ~44 turns |
| Worst-case break-even | ~60 turns |
| Best-case break-even | 3 turns |

### Interpretation

**Turn 1 after trim**: All tokens are written fresh at 1.25x base price instead of served from cache at 0.1x. This is the one-time penalty.

**Turn 2+ after trim**: The new (smaller) prefix is cached. Each subsequent turn costs less than it would have without trimming, because cache reads are applied to fewer tokens.

**Break-even**: For sessions with ~10% reduction, this takes approximately 44 turns. For sessions with 30%+ reduction, break-even occurs within 3-5 turns. Even before break-even, the cumulative cost difference is small — on the order of cents.

For sessions with minimal reduction (<5%), trimming offers negligible cost benefit. The `cmv benchmark` command flags these directly.

---

## Charts

### Opus 4.6 Pricing
![CMV Cache Impact Analysis — Opus 4.6](assets/cmv_benchmark_opus.png)

### Reading the Charts

**Top-left — Cumulative Cost**: Total input cost over 60 turns. Yellow = no trim, green = with trim. The red dot marks the break-even point. Thin background lines show individual sessions; the thick line highlights the session with the highest bloat.

**Top-right — Context Composition**: Stacked bars showing content breakdown per session. Red (tool results) and magenta (thinking signatures) represent trimmable overhead. Green (conversation) is preserved.

**Bottom-left — Reduction Distribution**: Histogram of token reduction per session. The distribution is left-skewed — most sessions see modest reduction, with a long right tail of high-bloat sessions.

**Bottom-right — Break-even vs Reduction**: Each bubble is a session. X-axis = reduction percentage, Y-axis = turns to break-even. Most sessions cluster in the upper-left (modest reduction, longer break-even). Sessions in the lower-right represent the strongest cost-saving candidates.

---

## What This Analysis Does Not Cover

### Response Quality

Trimming removes tool result content that Claude may reference in subsequent turns. If a stripped file listing or command output is needed for downstream reasoning, Claude may hallucinate, ask for a re-read, or produce lower-quality responses.

The mitigating factor: **trimming in CMV only occurs during snapshotting, which creates a new branch.** The intended workflow is to complete a line of work, snapshot, trim, and branch to a different task. The new branch retains the full conversational context (decisions made, approaches discussed) without the raw data dumps. For divergent tasks, this is likely sufficient — but "likely" is not "measured."

The planned approach to close this gap:

- Take snapshots at various conversation depths
- Branch twice from each: one trimmed, one untrimmed
- Give both branches the same follow-up task
- Compare output quality (correctness, hallucination rate, need for file re-reads)
- Identify which categories of tool results carry downstream signal vs. which are safe to strip

Until that work is complete, the quality impact of trimming is an open question.

### Multi-User Variance

All 33 sessions are from a single user and machine. Different coding patterns, project types, tool usage, and session lengths will produce different bloat profiles. We encourage users to run `cmv benchmark --latest --json` and share anonymized results to build a broader dataset.

---

## When Trimming Is Not Recommended

- **Sessions with <5% reduction**: Minimal overhead to remove
- **Sessions that won't be continued**: No subsequent turns to recover the cache miss cost
- **Very short continuations (<20 turns expected)**: May not reach break-even for modestly bloated sessions
- **Branches that continue the same file-editing task**: If the new branch needs specific tool outputs from the previous context, don't trim

---

## Summary

For subscription users, trimming has no cost implications and serves purely as a context window optimization. For API-key users, trimming introduces a small one-time cache miss penalty that is recovered over continued use of the session. The net cost impact is neutral to positive for any session of non-trivial length.

The primary value of trimming is not cost savings but context window management: reclaiming space within the 200k token limit, delaying lossy auto-compaction, and enabling branching workflows. The effect of trimming on downstream response quality has not yet been measured and is the most important open question for future work.

---

## Reproduce These Results

```bash
# Install CMV
npm install -g cmv

# Run benchmark on your most recent session (defaults to Opus 4.6 pricing)
cmv benchmark --latest

# JSON output for programmatic analysis
cmv benchmark --latest --json

# Full statistical analysis with charts
pip install matplotlib numpy
python docs/assets/benchmark_analysis.py --model opus --output cmv_benchmark_opus
```

---

## Source

- Pricing data: [Anthropic Prompt Caching Documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- Analysis code: [`docs/assets/benchmark_analysis.py`](assets/benchmark_analysis.py)
- CMV: [github.com/CosmoNaught/cmv](https://github.com/CosmoNaught/cmv)

*Generated February 2026. All analysis run against real Claude Code sessions on the author's machine.*
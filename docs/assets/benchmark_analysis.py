#!/usr/bin/env python3
"""
CMV Cache Impact Benchmark — Statistical Analysis & Visualization.

Scans all Claude Code sessions, analyzes context bloat, estimates trim
savings, models prompt-cache cost impact, and generates publication-quality
charts suitable for sharing.

Usage:
    python scripts/benchmark_analysis.py                  # all sessions
    python scripts/benchmark_analysis.py --model opus     # opus pricing
    python scripts/benchmark_analysis.py --output report  # custom output prefix

Requirements:
    pip install matplotlib numpy
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")  # non-interactive backend
    import matplotlib.pyplot as plt
    import matplotlib.ticker as mticker
    import numpy as np
except ImportError:
    print("Missing dependencies. Install with:\n  pip install matplotlib numpy")
    sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────

CONTEXT_LIMIT = 200_000
SYSTEM_OVERHEAD = 20_000
STUB_THRESHOLD = 500

PRICING = {
    "sonnet":  {"name": "Sonnet 4",   "input": 3.00,  "cache_write": 3.75,  "cache_read": 0.30},
    "opus":    {"name": "Opus 4.6",   "input": 5.00,  "cache_write": 6.25,  "cache_read": 0.50},
    "opus-4":  {"name": "Opus 4/4.1", "input": 15.00, "cache_write": 18.75, "cache_read": 1.50},
    "haiku":   {"name": "Haiku 4.5",  "input": 1.00,  "cache_write": 1.25,  "cache_read": 0.10},
}

# ── Data structures ──────────────────────────────────────────────────

@dataclass
class SessionAnalysis:
    path: str
    session_id: str
    project: str
    total_bytes: int = 0
    estimated_tokens: int = 0
    message_count: int = 0
    # Breakdown (bytes)
    tool_result_bytes: int = 0
    tool_result_count: int = 0
    thinking_bytes: int = 0
    thinking_count: int = 0
    file_history_bytes: int = 0
    file_history_count: int = 0
    conversation_bytes: int = 0
    tool_use_bytes: int = 0
    tool_use_count: int = 0
    other_bytes: int = 0
    # Derived
    post_trim_tokens: int = 0
    reduction_pct: float = 0.0


@dataclass
class CacheCostProjection:
    turns: np.ndarray = field(default_factory=lambda: np.array([]))
    no_trim: np.ndarray = field(default_factory=lambda: np.array([]))
    with_trim: np.ndarray = field(default_factory=lambda: np.array([]))
    breakeven: int = 0


# ── Session JSONL analyzer ───────────────────────────────────────────

def analyze_session(jsonl_path: str) -> SessionAnalysis | None:
    """Parse a Claude Code JSONL session and categorize all content."""
    try:
        size = os.path.getsize(jsonl_path)
        if size < 100:
            return None
    except OSError:
        return None

    total_bytes = 0
    tool_result_bytes = 0
    tool_result_count = 0
    thinking_bytes = 0
    thinking_count = 0
    file_history_bytes = 0
    file_history_count = 0
    conversation_bytes = 0
    tool_use_bytes = 0
    tool_use_count = 0
    other_bytes = 0
    content_chars = 0
    msg_user = 0
    msg_assistant = 0
    last_api_input_tokens = None
    content_chars_at_last_api = 0

    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n\r")
                if not line.strip():
                    continue

                line_bytes = len(line.encode("utf-8"))

                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    total_bytes += line_bytes
                    other_bytes += line_bytes
                    continue

                # Compaction boundary — reset counters
                is_compaction = (
                    parsed.get("type") == "summary"
                    or (parsed.get("type") == "system"
                        and parsed.get("subtype") == "compact_boundary")
                )
                if is_compaction:
                    total_bytes = line_bytes
                    tool_result_bytes = 0
                    tool_result_count = 0
                    thinking_bytes = 0
                    thinking_count = 0
                    file_history_bytes = 0
                    file_history_count = 0
                    conversation_bytes = 0
                    tool_use_bytes = 0
                    tool_use_count = 0
                    other_bytes = 0
                    content_chars = 0
                    msg_user = 0
                    msg_assistant = 0
                    content_chars_at_last_api = 0

                    summary = parsed.get("summary") or (
                        parsed.get("content")
                        if isinstance(parsed.get("content"), str)
                        else None
                    )
                    if summary:
                        content_chars += len(summary)
                        conversation_bytes += line_bytes
                    continue

                total_bytes += line_bytes

                # File history — not sent to API
                if parsed.get("type") == "file-history-snapshot":
                    file_history_bytes += line_bytes
                    file_history_count += 1
                    continue

                if parsed.get("type") == "queue-operation":
                    other_bytes += line_bytes
                    continue

                role = parsed.get("role") or parsed.get("type")
                if role in ("user", "human"):
                    msg_user += 1
                if role == "assistant":
                    msg_assistant += 1

                    # Extract API-reported token count
                    msg = parsed.get("message") or {}
                    usage = msg.get("usage") if isinstance(msg, dict) else None
                    if usage is None:
                        usage = parsed.get("usage")
                    if isinstance(usage, dict) and usage.get("input_tokens") is not None:
                        api_input = (
                            (usage.get("input_tokens") or 0)
                            + (usage.get("cache_creation_input_tokens") or 0)
                            + (usage.get("cache_read_input_tokens") or 0)
                        )
                        if api_input > 0 and api_input != last_api_input_tokens:
                            last_api_input_tokens = api_input
                            content_chars_at_last_api = content_chars

                # Analyze content blocks
                msg_obj = parsed.get("message") or {}
                content = (
                    msg_obj.get("content") if isinstance(msg_obj, dict) else None
                ) or parsed.get("content")

                tr_b = 0
                sig_b = 0
                tu_b = 0

                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type")

                        if btype == "tool_result":
                            block_str = json.dumps(block)
                            tr_b += len(block_str.encode("utf-8"))
                            tool_result_count += 1
                            inner = block.get("content")
                            if isinstance(inner, str):
                                content_chars += len(inner)
                            elif isinstance(inner, list):
                                for ib in inner:
                                    if isinstance(ib, dict) and ib.get("type") == "text":
                                        content_chars += len(ib.get("text", ""))

                        elif btype == "thinking":
                            if block.get("signature"):
                                sig_b += len(
                                    json.dumps(block["signature"]).encode("utf-8")
                                )
                                thinking_count += 1
                            if isinstance(block.get("text"), str):
                                content_chars += len(block["text"])

                        elif btype == "tool_use":
                            tu_b += len(json.dumps(block).encode("utf-8"))
                            tool_use_count += 1
                            if block.get("input"):
                                content_chars += len(json.dumps(block["input"]))

                        elif btype == "text" and isinstance(block.get("text"), str):
                            content_chars += len(block["text"])

                elif isinstance(content, str):
                    content_chars += len(content)

                tool_result_bytes += tr_b
                thinking_bytes += sig_b
                tool_use_bytes += tu_b

                accounted = tr_b + sig_b + tu_b
                if role in ("user", "human", "assistant"):
                    conversation_bytes += max(0, line_bytes - accounted)
                else:
                    other_bytes += max(0, line_bytes - accounted)

    except Exception:
        return None

    if msg_user + msg_assistant < 10:
        return None

    # Token estimation (mirrors analyzer.ts)
    heuristic = content_chars // 4
    if last_api_input_tokens is not None:
        estimated_tokens = last_api_input_tokens + (
            content_chars - content_chars_at_last_api
        ) // 4
    else:
        estimated_tokens = heuristic + SYSTEM_OVERHEAD

    sa = SessionAnalysis(
        path=jsonl_path,
        session_id=Path(jsonl_path).stem,
        project=Path(jsonl_path).parent.name,
        total_bytes=total_bytes,
        estimated_tokens=estimated_tokens,
        message_count=msg_user + msg_assistant,
        tool_result_bytes=tool_result_bytes,
        tool_result_count=tool_result_count,
        thinking_bytes=thinking_bytes,
        thinking_count=thinking_count,
        file_history_bytes=file_history_bytes,
        file_history_count=file_history_count,
        conversation_bytes=conversation_bytes,
        tool_use_bytes=tool_use_bytes,
        tool_use_count=tool_use_count,
        other_bytes=other_bytes,
    )

    # Estimate post-trim
    if total_bytes > 0:
        removed = (
            file_history_bytes
            + thinking_bytes
            + tool_result_bytes * 0.7
            - tool_result_count * 35
        )
        ratio = max(0.0, min(0.95, removed / total_bytes))
        content_tok = max(0, estimated_tokens - SYSTEM_OVERHEAD)
        sa.post_trim_tokens = round(content_tok * (1 - ratio)) + SYSTEM_OVERHEAD
    else:
        sa.post_trim_tokens = estimated_tokens

    # Can't trim to more tokens than we started with
    sa.post_trim_tokens = min(sa.post_trim_tokens, estimated_tokens)

    if estimated_tokens > 0:
        sa.reduction_pct = max(0.0, round(
            (estimated_tokens - sa.post_trim_tokens) / estimated_tokens * 100, 1
        ))

    return sa


# ── Cost modeling ────────────────────────────────────────────────────

def cost_per_turn(tokens: float, hit_rate: float, pricing: dict) -> float:
    cached = tokens * hit_rate
    new = tokens * (1 - hit_rate)
    return (cached / 1e6) * pricing["cache_read"] + (new / 1e6) * pricing["cache_write"]


def cold_cost(tokens: float, pricing: dict) -> float:
    return (tokens / 1e6) * pricing["cache_write"]


def project_costs(
    pre_tokens: int,
    post_tokens: int,
    pricing: dict,
    hit_rate: float = 0.90,
    max_turns: int = 60,
) -> CacheCostProjection:
    turns = np.arange(1, max_turns + 1)
    pre_cost = cost_per_turn(pre_tokens, hit_rate, pricing)
    post_steady = cost_per_turn(post_tokens, hit_rate, pricing)
    post_first = cold_cost(post_tokens, pricing)

    no_trim = pre_cost * turns
    with_trim = post_first + post_steady * (turns - 1)

    # Breakeven: first turn where with_trim <= no_trim
    diff = no_trim - with_trim
    be_indices = np.where(diff >= 0)[0]
    breakeven = int(be_indices[0]) + 1 if len(be_indices) > 0 else max_turns

    return CacheCostProjection(
        turns=turns, no_trim=no_trim, with_trim=with_trim, breakeven=breakeven
    )


# ── Discovery ────────────────────────────────────────────────────────

def discover_sessions() -> list[str]:
    claude_dir = Path.home() / ".claude" / "projects"
    if not claude_dir.exists():
        print(f"Claude projects dir not found: {claude_dir}")
        sys.exit(1)
    # Exclude subagent sessions — they're internal Claude processes, not user sessions
    all_jsonl = claude_dir.rglob("*.jsonl")
    return sorted(
        [p for p in all_jsonl if "subagents" not in p.parts],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


# ── Chart generation ─────────────────────────────────────────────────

# Dark theme colors
BG = "#0d1117"
FG = "#c9d1d9"
GRID = "#21262d"
YELLOW = "#f0c050"
GREEN = "#3fb950"
RED = "#f85149"
BLUE = "#58a6ff"
MAGENTA = "#bc8cff"
ORANGE = "#f0883e"
CYAN = "#39d2c0"


def style_ax(ax, title=""):
    ax.set_facecolor(BG)
    ax.tick_params(colors=FG, labelsize=9)
    ax.xaxis.label.set_color(FG)
    ax.yaxis.label.set_color(FG)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    if title:
        ax.set_title(title, color=FG, fontsize=11, fontweight="bold", pad=10)


def generate_charts(
    sessions: list[SessionAnalysis],
    pricing: dict,
    model_name: str,
    hit_rate: float,
    output_prefix: str,
):
    # Filter to sessions with meaningful content (>5k tokens)
    valid = [s for s in sessions if s.estimated_tokens > 5000]
    if not valid:
        print("No sessions with enough content to analyze.")
        return

    valid.sort(key=lambda s: s.estimated_tokens, reverse=True)

    fig, axes = plt.subplots(2, 2, figsize=(16, 11))
    fig.patch.set_facecolor(BG)
    fig.suptitle(
        f"CMV Cache Impact Analysis — {model_name} pricing, {int(hit_rate*100)}% cache hit rate",
        color=FG, fontsize=14, fontweight="bold", y=0.97,
    )

    # ── Panel 1: Cumulative cost curves (top session) ─────────────
    ax1 = axes[0, 0]
    style_ax(ax1, "Cumulative Input Cost Over Turns")

    # Plot thin lines for all sessions, thick for top
    for s in valid[:10]:
        proj = project_costs(s.estimated_tokens, s.post_trim_tokens, pricing, hit_rate)
        ax1.plot(proj.turns, proj.no_trim, color=YELLOW, alpha=0.15, linewidth=0.8)
        ax1.plot(proj.turns, proj.with_trim, color=GREEN, alpha=0.15, linewidth=0.8)

    # Thick line for most bloated session
    top = max(valid, key=lambda s: s.reduction_pct)
    proj = project_costs(top.estimated_tokens, top.post_trim_tokens, pricing, hit_rate)

    ax1.plot(proj.turns, proj.no_trim, color=YELLOW, linewidth=2.5, label="Without Trim")
    ax1.plot(proj.turns, proj.with_trim, color=GREEN, linewidth=2.5, label="With Trim")

    # Breakeven point
    if proj.breakeven < len(proj.turns):
        be_cost = proj.no_trim[proj.breakeven - 1]
        ax1.axvline(proj.breakeven, color=RED, linestyle="--", alpha=0.7, linewidth=1)
        ax1.plot(proj.breakeven, be_cost, "o", color=RED, markersize=8, zorder=5)
        ax1.annotate(
            f"Break-even\n(turn {proj.breakeven})",
            xy=(proj.breakeven, be_cost),
            xytext=(proj.breakeven + 4, be_cost * 1.15),
            color=RED, fontsize=9, fontweight="bold",
            arrowprops=dict(arrowstyle="->", color=RED, lw=1.2),
        )

    # Shade savings region
    savings_mask = proj.with_trim <= proj.no_trim
    ax1.fill_between(
        proj.turns, proj.no_trim, proj.with_trim,
        where=savings_mask, alpha=0.15, color=GREEN, label="Savings",
    )
    # Shade penalty region
    ax1.fill_between(
        proj.turns, proj.no_trim, proj.with_trim,
        where=~savings_mask, alpha=0.15, color=RED, label="Cache miss penalty",
    )

    ax1.set_xlabel("Turns")
    ax1.set_ylabel("Cumulative Cost ($)")
    ax1.yaxis.set_major_formatter(mticker.FormatStrFormatter("$%.2f"))
    ax1.legend(facecolor=BG, edgecolor=GRID, labelcolor=FG, fontsize=8, loc="upper left")
    ax1.grid(True, color=GRID, alpha=0.5, linewidth=0.5)

    # ── Panel 2: Context composition (stacked bar) ────────────────
    ax2 = axes[0, 1]
    style_ax(ax2, "Context Composition by Session")

    # Sort by total tokens for visual clarity
    display = sorted(valid[:20], key=lambda s: s.estimated_tokens, reverse=True)
    labels = [f"{s.session_id[:6]}…" for s in display]
    x = np.arange(len(display))

    def pct_of(s, attr):
        return getattr(s, attr) / s.total_bytes * 100 if s.total_bytes > 0 else 0

    tr_pcts = [pct_of(s, "tool_result_bytes") for s in display]
    th_pcts = [pct_of(s, "thinking_bytes") for s in display]
    fh_pcts = [pct_of(s, "file_history_bytes") for s in display]
    cv_pcts = [pct_of(s, "conversation_bytes") for s in display]
    tu_pcts = [pct_of(s, "tool_use_bytes") for s in display]
    ot_pcts = [pct_of(s, "other_bytes") for s in display]

    bottoms = np.zeros(len(display))

    for data, color, label in [
        (tr_pcts, RED, "Tool results"),
        (th_pcts, MAGENTA, "Thinking/sigs"),
        (fh_pcts, BLUE, "File history"),
        (tu_pcts, ORANGE, "Tool use reqs"),
        (cv_pcts, GREEN, "Conversation"),
        (ot_pcts, GRID, "Other"),
    ]:
        ax2.bar(x, data, bottom=bottoms, color=color, label=label, width=0.7, edgecolor="none")
        bottoms += np.array(data)

    ax2.set_xticks(x)
    ax2.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    ax2.set_ylabel("% of JSONL Bytes")
    ax2.set_ylim(0, 105)
    ax2.legend(
        facecolor=BG, edgecolor=GRID, labelcolor=FG,
        fontsize=7, loc="upper right", ncol=2,
    )
    ax2.grid(True, axis="y", color=GRID, alpha=0.5, linewidth=0.5)

    # ── Panel 3: Reduction % distribution ─────────────────────────
    ax3 = axes[1, 0]
    style_ax(ax3, "Estimated Trim Reduction Distribution")

    reductions = [s.reduction_pct for s in valid]
    bins = np.arange(0, max(reductions) + 5, 5)
    ax3.hist(reductions, bins=bins, color=GREEN, alpha=0.8, edgecolor=BG, linewidth=0.5)
    mean_red = np.mean(reductions)
    median_red = np.median(reductions)
    ax3.axvline(mean_red, color=YELLOW, linestyle="--", linewidth=1.5, label=f"Mean: {mean_red:.1f}%")
    ax3.axvline(median_red, color=CYAN, linestyle="--", linewidth=1.5, label=f"Median: {median_red:.1f}%")
    ax3.set_xlabel("Token Reduction (%)")
    ax3.set_ylabel("Number of Sessions")
    ax3.legend(facecolor=BG, edgecolor=GRID, labelcolor=FG, fontsize=9)
    ax3.grid(True, axis="y", color=GRID, alpha=0.5, linewidth=0.5)

    # ── Panel 4: Breakeven turns vs reduction % ───────────────────
    ax4 = axes[1, 1]
    style_ax(ax4, "Break-even Turns vs Context Reduction")

    be_data = []
    for s in valid:
        proj = project_costs(s.estimated_tokens, s.post_trim_tokens, pricing, hit_rate)
        be_data.append((s.reduction_pct, proj.breakeven, s.estimated_tokens))

    reds = [d[0] for d in be_data]
    bes = [min(d[1], 60) for d in be_data]  # cap at 60 for display
    sizes = [max(20, d[2] / 3000) for d in be_data]  # bubble size ~ token count

    scatter = ax4.scatter(
        reds, bes, s=sizes, c=bes, cmap="RdYlGn_r",
        alpha=0.8, edgecolors=FG, linewidths=0.3, vmin=1, vmax=60,
    )
    ax4.set_xlabel("Token Reduction (%)")
    ax4.set_ylabel("Break-even (turns)")
    ax4.axhline(5, color=GREEN, linestyle=":", alpha=0.5, linewidth=1)
    ax4.text(max(reds) * 0.9, 5.5, "< 5 turns = easy win", color=GREEN, fontsize=8, ha="right")
    ax4.axhline(15, color=YELLOW, linestyle=":", alpha=0.5, linewidth=1)
    ax4.text(max(reds) * 0.9, 15.5, "< 15 turns = worth it", color=YELLOW, fontsize=8, ha="right")
    cbar = plt.colorbar(scatter, ax=ax4, pad=0.02)
    cbar.set_label("Break-even turns", color=FG, fontsize=8)
    cbar.ax.tick_params(colors=FG, labelsize=7)
    cbar.outline.set_edgecolor(GRID)
    ax4.grid(True, color=GRID, alpha=0.5, linewidth=0.5)

    # ── Summary stats annotation ──────────────────────────────────
    n = len(valid)
    avg_tokens = int(np.mean([s.estimated_tokens for s in valid]))
    avg_reduction = np.mean(reductions)
    avg_be = np.mean([min(d[1], 60) for d in be_data])

    summary_text = (
        f"Sessions analyzed: {n}  |  "
        f"Avg context: {avg_tokens//1000}k tokens  |  "
        f"Avg reduction: {avg_reduction:.1f}%  |  "
        f"Avg break-even: {avg_be:.0f} turns"
    )
    fig.text(
        0.5, 0.015, summary_text, color=FG, fontsize=10,
        ha="center", fontstyle="italic",
    )

    plt.tight_layout(rect=[0, 0.04, 1, 0.95])

    out_path = f"{output_prefix}.png"
    fig.savefig(out_path, dpi=180, facecolor=BG, bbox_inches="tight")
    print(f"\nChart saved: {out_path}")
    plt.close(fig)

    # ── Detailed per-session table ────────────────────────────────
    print(f"\n{'Session':>14}  {'Project':>20}  {'Tokens':>8}  {'Post-Trim':>10}  {'Reduction':>10}  {'Msgs':>5}  {'Tool Results':>13}")
    print("-" * 95)
    for s in valid[:30]:
        print(
            f"  {s.session_id[:12]}  {s.project[:20]:>20}  "
            f"{s.estimated_tokens:>7,}  {s.post_trim_tokens:>9,}  "
            f"{s.reduction_pct:>8.1f}%  {s.message_count:>5}  "
            f"{s.tool_result_count:>13}"
        )

    print(f"\n  Mean reduction:   {avg_reduction:.1f}%")
    print(f"  Median reduction: {median_red:.1f}%")
    print(f"  Mean break-even:  {avg_be:.0f} turns")
    print(f"  Sessions > 30% reduction: {sum(1 for r in reductions if r > 30)}/{n}")


# ── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="CMV Cache Impact Benchmark")
    parser.add_argument(
        "-m", "--model", choices=["sonnet", "opus", "opus-4", "haiku"],
        default="sonnet", help="Pricing model (default: sonnet)",
    )
    parser.add_argument(
        "-c", "--cache-rate", type=int, default=90,
        help="Cache hit rate 0-100 (default: 90)",
    )
    parser.add_argument(
        "-o", "--output", default="cmv_benchmark",
        help="Output file prefix (default: cmv_benchmark)",
    )
    parser.add_argument(
        "--min-tokens", type=int, default=5000,
        help="Minimum tokens to include session (default: 5000)",
    )
    args = parser.parse_args()

    pricing = PRICING[args.model]
    hit_rate = max(0, min(100, args.cache_rate)) / 100

    print(f"CMV Cache Impact Benchmark")
    print(f"Model: {pricing['name']}  |  Cache hit rate: {args.cache_rate}%")
    print(f"Discovering sessions...")

    jsonl_files = discover_sessions()
    print(f"Found {len(jsonl_files)} JSONL files. Analyzing...")

    sessions = []
    for i, fp in enumerate(jsonl_files):
        sa = analyze_session(str(fp))
        if sa and sa.estimated_tokens >= args.min_tokens:
            sessions.append(sa)
        if (i + 1) % 20 == 0:
            print(f"  ...processed {i + 1}/{len(jsonl_files)}")

    print(f"Analyzed {len(sessions)} sessions with >{args.min_tokens} tokens.")

    if not sessions:
        print("No qualifying sessions found.")
        sys.exit(0)

    generate_charts(sessions, pricing, pricing["name"], hit_rate, args.output)


if __name__ == "__main__":
    main()

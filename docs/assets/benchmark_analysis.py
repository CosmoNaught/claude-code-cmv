#!/usr/bin/env python3
"""
CMV Cache Impact Benchmark — Statistical Analysis & Visualization.

Two modes of operation:
  1. Standalone: Scans JSONL sessions and estimates trim impact (legacy mode).
  2. Input JSON: Reads ground-truth data from `cmv benchmark --all --json`
     and generates publication-quality charts from real trimmer results.

Usage:
    # From ground-truth data (preferred):
    python benchmark_analysis.py --input-json data/benchmark_results.json --theme light --individual -o data/cmv_benchmark

    # Standalone (legacy estimation):
    python benchmark_analysis.py --model opus -o cmv_benchmark

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

# Bloat tier thresholds (tool result bytes as % of total bytes)
TIER_TOOL_HEAVY = 40  # >40% = tool-heavy
TIER_MIXED = 15       # 15-40% = mixed

# ── Data structures ──────────────────────────────────────────────────

@dataclass
class SessionData:
    """Unified session data — either from JSON input or standalone analysis."""
    session_id: str
    project: str
    estimated_tokens: int = 0
    post_trim_tokens: int = 0
    reduction_pct: float = 0.0
    message_count: int = 0
    breakeven_turns: int = 0
    cache_miss_penalty: float = 0.0
    savings_per_turn: float = 0.0
    tool_result_byte_pct: int = 0
    # Breakdown for composition chart (bytes)
    tool_result_bytes: int = 0
    thinking_bytes: int = 0
    file_history_bytes: int = 0
    conversation_bytes: int = 0
    tool_use_bytes: int = 0
    other_bytes: int = 0
    total_bytes: int = 0
    tool_result_count: int = 0

    @property
    def tier(self) -> str:
        if self.tool_result_byte_pct > TIER_TOOL_HEAVY:
            return "tool_heavy"
        elif self.tool_result_byte_pct > TIER_MIXED:
            return "mixed"
        else:
            return "conversational"

    @property
    def tier_label(self) -> str:
        return {"tool_heavy": "Heavy tool use", "mixed": "Moderate tool use", "conversational": "Light tool use"}[self.tier]


@dataclass
class CacheCostProjection:
    turns: np.ndarray = field(default_factory=lambda: np.array([]))
    no_trim: np.ndarray = field(default_factory=lambda: np.array([]))
    with_trim: np.ndarray = field(default_factory=lambda: np.array([]))
    breakeven: int = 0


# ── Load from JSON (ground-truth mode) ──────────────────────────────

def load_from_json(json_path: str, pricing: dict, hit_rate: float) -> list[SessionData]:
    """Load pre-computed results from `cmv benchmark --all --json`."""
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    sessions = []
    for s in data["sessions"]:
        bd = s.get("breakdown", {})
        tr_bytes = bd.get("toolResults", {}).get("bytes", 0)
        th_bytes = bd.get("thinkingSignatures", {}).get("bytes", 0)
        fh_bytes = bd.get("fileHistory", {}).get("bytes", 0)
        cv_bytes = bd.get("conversation", {}).get("bytes", 0)
        tu_bytes = bd.get("toolUseRequests", {}).get("bytes", 0)
        ot_bytes = bd.get("other", {}).get("bytes", 0)
        total = s.get("totalBytes", tr_bytes + th_bytes + fh_bytes + cv_bytes + tu_bytes + ot_bytes)

        # Recompute cost for the requested pricing model (JSON may have been
        # generated with a different model)
        pre_tok = s["estimatedTokens"]
        post_tok = s["postTrimTokens"]
        proj = project_costs(pre_tok, post_tok, pricing, hit_rate, max_turns=60)

        sessions.append(SessionData(
            session_id=s["sessionId"],
            project=s.get("project", ""),
            estimated_tokens=pre_tok,
            post_trim_tokens=post_tok,
            reduction_pct=s["reductionPercent"],
            message_count=s.get("messageCount", 0),
            breakeven_turns=proj.breakeven,
            cache_miss_penalty=s.get("cacheMissPenalty", 0),
            savings_per_turn=s.get("savingsPerTurn", 0),
            tool_result_byte_pct=s.get("toolResultBytePct", 0),
            tool_result_bytes=tr_bytes,
            thinking_bytes=th_bytes,
            file_history_bytes=fh_bytes,
            conversation_bytes=cv_bytes,
            tool_use_bytes=tu_bytes,
            other_bytes=ot_bytes,
            total_bytes=total,
            tool_result_count=bd.get("toolResults", {}).get("count", 0),
        ))

    return sessions


# ── Session JSONL analyzer (standalone/legacy) ──────────────────────

def analyze_session(jsonl_path: str) -> SessionData | None:
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
                            if isinstance(block.get("thinking"), str):
                                content_chars += len(block["thinking"])

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

    heuristic = content_chars // 4
    if last_api_input_tokens is not None:
        estimated_tokens = last_api_input_tokens + (
            content_chars - content_chars_at_last_api
        ) // 4
    else:
        estimated_tokens = heuristic + SYSTEM_OVERHEAD

    # Estimate post-trim (legacy heuristic)
    if total_bytes > 0:
        removed = (
            file_history_bytes
            + thinking_bytes
            + tool_result_bytes * 0.7
            - tool_result_count * 35
            + tool_use_bytes * 0.3
        )
        ratio = max(0.0, min(0.95, removed / total_bytes))
        content_tok = max(0, estimated_tokens - SYSTEM_OVERHEAD)
        post_trim_tokens = round(content_tok * (1 - ratio)) + SYSTEM_OVERHEAD
    else:
        post_trim_tokens = estimated_tokens

    post_trim_tokens = min(post_trim_tokens, estimated_tokens)

    reduction_pct = 0.0
    if estimated_tokens > 0:
        reduction_pct = max(0.0, round(
            (estimated_tokens - post_trim_tokens) / estimated_tokens * 100, 1
        ))

    tr_pct = round(tool_result_bytes / total_bytes * 100) if total_bytes > 0 else 0

    return SessionData(
        session_id=Path(jsonl_path).stem,
        project=Path(jsonl_path).parent.name,
        estimated_tokens=estimated_tokens,
        post_trim_tokens=post_trim_tokens,
        reduction_pct=reduction_pct,
        message_count=msg_user + msg_assistant,
        tool_result_byte_pct=tr_pct,
        tool_result_bytes=tool_result_bytes,
        thinking_bytes=thinking_bytes,
        file_history_bytes=file_history_bytes,
        conversation_bytes=conversation_bytes,
        tool_use_bytes=tool_use_bytes,
        other_bytes=other_bytes,
        total_bytes=total_bytes,
        tool_result_count=tool_result_count,
    )


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

    diff = no_trim - with_trim
    be_indices = np.where(diff >= 0)[0]
    breakeven = int(be_indices[0]) + 1 if len(be_indices) > 0 else max_turns

    return CacheCostProjection(
        turns=turns, no_trim=no_trim, with_trim=with_trim, breakeven=breakeven
    )


# ── Discovery (standalone mode) ──────────────────────────────────────

def discover_sessions() -> list[str]:
    claude_dir = Path.home() / ".claude" / "projects"
    if not claude_dir.exists():
        print(f"Claude projects dir not found: {claude_dir}")
        sys.exit(1)
    all_jsonl = claude_dir.rglob("*.jsonl")
    return sorted(
        [p for p in all_jsonl if "subagents" not in p.parts],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


# ── Tier analysis ────────────────────────────────────────────────────

def classify_tiers(sessions: list[SessionData]) -> dict:
    """Segment sessions by bloat profile and compute per-tier stats."""
    tiers = {"tool_heavy": [], "mixed": [], "conversational": []}
    for s in sessions:
        tiers[s.tier].append(s)

    result = {}
    for tier_name, tier_sessions in tiers.items():
        if not tier_sessions:
            result[tier_name] = {
                "count": 0,
                "label": {"tool_heavy": "Heavy tool use (>40%)", "mixed": "Moderate tool use (15-40%)", "conversational": "Light tool use (<15%)"}[tier_name],
            }
            continue

        reds = [s.reduction_pct for s in tier_sessions]
        bes = [min(s.breakeven_turns, 100) for s in tier_sessions]
        toks = [s.estimated_tokens for s in tier_sessions]

        result[tier_name] = {
            "count": len(tier_sessions),
            "label": {"tool_heavy": "Heavy tool use (>40%)", "mixed": "Moderate tool use (15-40%)", "conversational": "Light tool use (<15%)"}[tier_name],
            "mean_reduction_pct": round(float(np.mean(reds)), 1),
            "median_reduction_pct": round(float(np.median(reds)), 1),
            "min_reduction_pct": round(float(min(reds)), 1),
            "max_reduction_pct": round(float(max(reds)), 1),
            "mean_breakeven": round(float(np.mean(bes)), 0),
            "median_breakeven": round(float(np.median(bes)), 0),
            "mean_tokens": int(np.mean(toks)),
        }

    return result


# ── Theme system ─────────────────────────────────────────────────────

def get_theme(name: str) -> dict:
    if name == "light":
        return {
            "BG": "#ffffff", "FG": "#1a1a2e", "GRID": "#d0d0d0",
            "YELLOW": "#c8960c", "GREEN": "#2d7d46", "RED": "#c0392b",
            "BLUE": "#2471a3", "MAGENTA": "#7d3c98", "ORANGE": "#d35400",
            "CYAN": "#148f77",
            "dpi": 300,
            "font_family": "serif",
            "legend_bg": "#f8f8f8",
            "legend_edge": "#cccccc",
            # Tier marker colors
            "TIER_HEAVY": "#c0392b",
            "TIER_MIXED": "#d4a017",
            "TIER_CONV": "#2471a3",
        }
    else:
        return {
            "BG": "#0d1117", "FG": "#c9d1d9", "GRID": "#21262d",
            "YELLOW": "#f0c050", "GREEN": "#3fb950", "RED": "#f85149",
            "BLUE": "#58a6ff", "MAGENTA": "#bc8cff", "ORANGE": "#f0883e",
            "CYAN": "#39d2c0",
            "dpi": 180,
            "font_family": "sans-serif",
            "legend_bg": "#0d1117",
            "legend_edge": "#21262d",
            "TIER_HEAVY": "#f85149",
            "TIER_MIXED": "#f0c050",
            "TIER_CONV": "#58a6ff",
        }


def apply_theme(theme: dict):
    plt.rcParams.update({
        "font.family": theme["font_family"],
        "font.size": 10,
        "axes.labelsize": 11,
        "axes.titlesize": 12,
        "xtick.labelsize": 9,
        "ytick.labelsize": 9,
        "legend.fontsize": 9,
        "figure.titlesize": 13,
    })
    if theme["font_family"] == "serif":
        plt.rcParams["font.serif"] = ["Times New Roman", "DejaVu Serif", "serif"]


def style_ax(ax, theme: dict, title=""):
    ax.set_facecolor(theme["BG"])
    ax.tick_params(colors=theme["FG"], labelsize=9)
    ax.xaxis.label.set_color(theme["FG"])
    ax.yaxis.label.set_color(theme["FG"])
    for spine in ax.spines.values():
        spine.set_color(theme["GRID"])
    if title:
        ax.set_title(title, color=theme["FG"], fontsize=12, fontweight="bold", pad=10)


# ── Individual panel plotting functions ──────────────────────────────

def plot_cost_curves(sessions: list[SessionData], pricing: dict, hit_rate: float,
                     ax, theme: dict):
    """Panel 1: Cumulative input cost over turns."""
    T = theme
    style_ax(ax, T, "Cumulative Input Cost Over Turns")

    # Background: faint lines for top 10 sessions by token count
    for s in sessions[:10]:
        proj = project_costs(s.estimated_tokens, s.post_trim_tokens, pricing, hit_rate)
        ax.plot(proj.turns, proj.no_trim, color=T["YELLOW"], alpha=0.12, linewidth=0.7)
        ax.plot(proj.turns, proj.with_trim, color=T["GREEN"], alpha=0.12, linewidth=0.7)

    # Highlight a representative session: pick one with breakeven in the 5-15 range
    # (meaningful penalty + visible savings), fall back to median reduction
    candidates = [s for s in sessions if 5 <= s.breakeven_turns <= 15 and s.reduction_pct > 20]
    if candidates:
        highlight = sorted(candidates, key=lambda s: s.reduction_pct, reverse=True)[0]
    else:
        by_red = sorted(sessions, key=lambda s: s.reduction_pct)
        highlight = by_red[len(by_red) // 2]

    proj = project_costs(highlight.estimated_tokens, highlight.post_trim_tokens, pricing, hit_rate)

    ax.plot(proj.turns, proj.no_trim, color=T["YELLOW"], linewidth=2.5, label="Without Trim")
    ax.plot(proj.turns, proj.with_trim, color=T["GREEN"], linewidth=2.5, label="With Trim")

    # Subtle green fill for savings region only (after breakeven)
    savings_mask = proj.with_trim <= proj.no_trim
    ax.fill_between(proj.turns, proj.no_trim, proj.with_trim,
                     where=savings_mask, alpha=0.12, color=T["GREEN"])

    # Small breakeven marker — dot + text, no arrow
    if proj.breakeven < len(proj.turns):
        be_cost = proj.with_trim[proj.breakeven - 1]
        ax.plot(proj.breakeven, be_cost, "o", color=T["FG"], markersize=6,
                markerfacecolor=T["BG"], markeredgewidth=1.5, zorder=5)
        ax.annotate(
            f"Break-even (turn {proj.breakeven})",
            xy=(proj.breakeven, be_cost),
            xytext=(proj.breakeven + 3, be_cost),
            color=T["FG"], fontsize=8, va="center",
        )

    red_pct = highlight.reduction_pct
    ax.text(0.97, 0.05, f"Highlighted: {red_pct:.0f}% reduction",
            transform=ax.transAxes, ha="right", va="bottom",
            fontsize=8, color=T["FG"], fontstyle="italic", alpha=0.7)

    ax.set_xlabel("Turns")
    ax.set_ylabel("Cumulative Cost ($)")
    ax.yaxis.set_major_formatter(mticker.FormatStrFormatter("$%.2f"))
    ax.legend(facecolor=T["legend_bg"], edgecolor=T["legend_edge"], labelcolor=T["FG"],
              fontsize=8, loc="upper left")
    ax.grid(True, color=T["GRID"], alpha=0.5, linewidth=0.5)


def plot_composition(sessions: list[SessionData], ax, theme: dict):
    """Panel 2: Context composition stacked bar chart."""
    T = theme
    style_ax(ax, T, "Context Composition by Session")

    display = sorted(sessions[:20], key=lambda s: s.estimated_tokens, reverse=True)
    labels = [f"{s.session_id[:6]}..." for s in display]
    x = np.arange(len(display))

    def pct_of(s, attr):
        return getattr(s, attr) / s.total_bytes * 100 if s.total_bytes > 0 else 0

    bottoms = np.zeros(len(display))
    for attr, color, label in [
        ("tool_result_bytes", T["RED"], "Tool results"),
        ("thinking_bytes", T["MAGENTA"], "Thinking/sigs"),
        ("file_history_bytes", T["BLUE"], "File history"),
        ("tool_use_bytes", T["ORANGE"], "Tool use reqs"),
        ("conversation_bytes", T["GREEN"], "Conversation"),
        ("other_bytes", T["GRID"], "Other"),
    ]:
        data = [pct_of(s, attr) for s in display]
        ax.bar(x, data, bottom=bottoms, color=color, label=label, width=0.7, edgecolor="none")
        bottoms += np.array(data)

    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    ax.set_ylabel("% of JSONL Bytes")
    ax.set_ylim(0, 105)
    ax.legend(facecolor=T["legend_bg"], edgecolor=T["legend_edge"], labelcolor=T["FG"],
              fontsize=7, loc="upper right", ncol=2)
    ax.grid(True, axis="y", color=T["GRID"], alpha=0.5, linewidth=0.5)


def plot_reduction_dist(sessions: list[SessionData], ax, theme: dict):
    """Panel 3: Trim reduction distribution histogram, colored by tier."""
    T = theme
    style_ax(ax, T, "Trim Reduction Distribution by Tool Usage")

    tier_data = {
        "tool_heavy": ([s.reduction_pct for s in sessions if s.tier == "tool_heavy"], T["TIER_HEAVY"], "Heavy tool use"),
        "mixed": ([s.reduction_pct for s in sessions if s.tier == "mixed"], T["TIER_MIXED"], "Moderate tool use"),
        "conversational": ([s.reduction_pct for s in sessions if s.tier == "conversational"], T["TIER_CONV"], "Light tool use"),
    }

    all_reds = [s.reduction_pct for s in sessions]
    if not all_reds:
        return
    bins = np.arange(0, max(all_reds) + 5, 5)

    # Stacked histogram by tier
    data_arrays = []
    colors = []
    labels = []
    for tier_name in ["tool_heavy", "mixed", "conversational"]:
        reds, color, label = tier_data[tier_name]
        if reds:
            data_arrays.append(reds)
            colors.append(color)
            labels.append(label)

    if data_arrays:
        ax.hist(data_arrays, bins=bins, color=colors, label=labels,
                stacked=True, alpha=0.85, edgecolor=T["BG"], linewidth=0.5)

    mean_red = np.mean(all_reds)
    median_red = np.median(all_reds)
    ax.axvline(mean_red, color=T["YELLOW"], linestyle="--", linewidth=1.5,
               label=f"Mean: {mean_red:.1f}%")
    ax.axvline(median_red, color=T["CYAN"], linestyle="--", linewidth=1.5,
               label=f"Median: {median_red:.1f}%")

    ax.set_xlabel("Token Reduction (%)")
    ax.set_ylabel("Number of Sessions")
    ax.legend(facecolor=T["legend_bg"], edgecolor=T["legend_edge"], labelcolor=T["FG"], fontsize=8)
    ax.grid(True, axis="y", color=T["GRID"], alpha=0.5, linewidth=0.5)


def plot_breakeven(sessions: list[SessionData], pricing: dict, hit_rate: float,
                   ax, theme: dict):
    """Panel 4: Break-even turns vs context reduction, colored by tier."""
    T = theme
    style_ax(ax, T, "Break-even Turns vs Context Reduction")

    tier_markers = {
        "tool_heavy": ("o", T["TIER_HEAVY"], "Heavy tool use"),
        "mixed": ("s", T["TIER_MIXED"], "Moderate tool use"),
        "conversational": ("D", T["TIER_CONV"], "Light tool use"),
    }

    for tier_name, (marker, color, label) in tier_markers.items():
        tier_sessions = [s for s in sessions if s.tier == tier_name]
        if not tier_sessions:
            continue

        reds = [s.reduction_pct for s in tier_sessions]
        bes = [min(s.breakeven_turns, 60) for s in tier_sessions]
        sizes = [max(25, s.estimated_tokens / 2500) for s in tier_sessions]

        ax.scatter(reds, bes, s=sizes, c=color, marker=marker, alpha=0.8,
                   edgecolors=T["FG"], linewidths=0.3, label=label, zorder=3)

    all_reds = [s.reduction_pct for s in sessions]
    if all_reds:
        ax.set_xlabel("Token Reduction (%)")
        ax.set_ylabel("Break-even (turns)")
        ax.axhline(5, color=T["GREEN"], linestyle=":", alpha=0.5, linewidth=1)
        ax.text(max(all_reds) * 0.9, 5.5, "< 5 turns = easy win",
                color=T["GREEN"], fontsize=8, ha="right")
        ax.axhline(15, color=T["YELLOW"], linestyle=":", alpha=0.5, linewidth=1)
        ax.text(max(all_reds) * 0.9, 15.5, "< 15 turns = worth it",
                color=T["YELLOW"], fontsize=8, ha="right")

    ax.legend(facecolor=T["legend_bg"], edgecolor=T["legend_edge"], labelcolor=T["FG"],
              fontsize=8, loc="upper right")
    ax.grid(True, color=T["GRID"], alpha=0.5, linewidth=0.5)


# ── Chart generation ─────────────────────────────────────────────────

def generate_individual_figures(sessions: list[SessionData], pricing: dict,
                                model_name: str, hit_rate: float,
                                output_prefix: str, theme: dict):
    """Generate four individual publication-quality figure PNGs."""
    panels = [
        ("cost_curves", plot_cost_curves, (sessions, pricing, hit_rate)),
        ("composition", plot_composition, (sessions,)),
        ("reduction_dist", plot_reduction_dist, (sessions,)),
        ("breakeven", plot_breakeven, (sessions, pricing, hit_rate)),
    ]

    for suffix, plot_fn, extra_args in panels:
        fig, ax = plt.subplots(1, 1, figsize=(6.3, 4.0))
        fig.patch.set_facecolor(theme["BG"])
        plot_fn(*extra_args, ax=ax, theme=theme)
        plt.tight_layout()
        out_path = f"{output_prefix}_fig_{suffix}.png"
        fig.savefig(out_path, dpi=theme["dpi"], facecolor=theme["BG"], bbox_inches="tight")
        print(f"  Saved: {out_path}")
        plt.close(fig)


def generate_combined_chart(sessions: list[SessionData], pricing: dict,
                            model_name: str, hit_rate: float,
                            output_prefix: str, theme: dict):
    """Generate the 4-panel combined dashboard chart."""
    T = theme
    fig, axes = plt.subplots(2, 2, figsize=(16, 11))
    fig.patch.set_facecolor(T["BG"])
    fig.suptitle(
        f"CMV Cache Impact Analysis \u2014 {model_name} pricing, {int(hit_rate*100)}% cache hit rate",
        color=T["FG"], fontsize=14, fontweight="bold", y=0.97,
    )

    plot_cost_curves(sessions, pricing, hit_rate, axes[0, 0], T)
    plot_composition(sessions, axes[0, 1], T)
    plot_reduction_dist(sessions, axes[1, 0], T)
    plot_breakeven(sessions, pricing, hit_rate, axes[1, 1], T)

    # Summary stats footer
    n = len(sessions)
    reductions = [s.reduction_pct for s in sessions]
    avg_tokens = int(np.mean([s.estimated_tokens for s in sessions]))
    avg_reduction = np.mean(reductions) if reductions else 0
    avg_be = np.mean([min(s.breakeven_turns, 60) for s in sessions]) if sessions else 0

    summary_text = (
        f"Sessions analyzed: {n}  |  "
        f"Avg context: {avg_tokens//1000}k tokens  |  "
        f"Avg reduction: {avg_reduction:.1f}%  |  "
        f"Avg break-even: {avg_be:.0f} turns"
    )
    fig.text(0.5, 0.015, summary_text, color=T["FG"], fontsize=10,
             ha="center", fontstyle="italic")

    plt.tight_layout(rect=[0, 0.04, 1, 0.95])

    out_path = f"{output_prefix}.png"
    fig.savefig(out_path, dpi=T["dpi"], facecolor=T["BG"], bbox_inches="tight")
    print(f"  Saved: {out_path}")
    plt.close(fig)


# ── Stats output ─────────────────────────────────────────────────────

def write_stats(sessions: list[SessionData], pricing: dict, hit_rate: float,
                model_name: str, output_prefix: str):
    """Write benchmark_stats.json with all stats needed for the paper."""
    reductions = [s.reduction_pct for s in sessions]
    bes = [min(s.breakeven_turns, 100) for s in sessions]
    penalties = [s.cache_miss_penalty for s in sessions]

    tiers = classify_tiers(sessions)

    stats = {
        "generated": __import__("datetime").datetime.now().isoformat(),
        "model": model_name,
        "cache_hit_rate": hit_rate,
        "session_count": len(sessions),
        "tiers": tiers,
        "overall": {
            "reduction": {
                "mean_pct": round(float(np.mean(reductions)), 1) if reductions else 0,
                "median_pct": round(float(np.median(reductions)), 1) if reductions else 0,
                "min_pct": round(float(min(reductions)), 1) if reductions else 0,
                "max_pct": round(float(max(reductions)), 1) if reductions else 0,
                "sessions_above_30pct": sum(1 for r in reductions if r > 30),
            },
            "tokens": {
                "mean_pre_trim": int(np.mean([s.estimated_tokens for s in sessions])) if sessions else 0,
                "mean_post_trim": int(np.mean([s.post_trim_tokens for s in sessions])) if sessions else 0,
            },
            "breakeven": {
                "mean_turns": round(float(np.mean(bes)), 0) if bes else 0,
                "median_turns": round(float(np.median(bes)), 0) if bes else 0,
                "min_turns": min(bes) if bes else 0,
                "max_turns": max(bes) if bes else 0,
            },
            "cost": {
                "mean_cache_miss_penalty": round(float(np.mean(penalties)), 4) if penalties else 0,
                "median_cache_miss_penalty": round(float(np.median(penalties)), 4) if penalties else 0,
                "min_cache_miss_penalty": round(float(min(penalties)), 4) if penalties else 0,
                "max_cache_miss_penalty": round(float(max(penalties)), 4) if penalties else 0,
            },
        },
    }

    out_path = f"{output_prefix}_stats.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)
    print(f"  Saved: {out_path}")

    return stats


def write_tables_tex(stats: dict, output_prefix: str):
    """Write a tables.tex file with LaTeX table code ready for inclusion."""
    tiers = stats["tiers"]
    overall = stats["overall"]
    n = stats["session_count"]

    lines = []
    lines.append("% Auto-generated by benchmark_analysis.py")
    lines.append(f"% {stats['generated']}")
    lines.append(f"% Model: {stats['model']}, Cache hit rate: {stats['cache_hit_rate']}")
    lines.append(f"% Sessions: {n}")
    lines.append("")

    # Table 2: Overall results
    lines.append("% ── Table 2: Overall trimming results ──")
    lines.append(r"\begin{table}[H]")
    lines.append(r"\centering")
    lines.append(f"\\caption{{Trimming results across {n} sessions (API-key users, $h = {stats['cache_hit_rate']}$).}}")
    lines.append(r"\label{tab:results}")
    lines.append(r"\small")
    lines.append(r"\begin{tabular}{lrrrr}")
    lines.append(r"\toprule")
    lines.append(r"\textbf{Metric} & \textbf{Min} & \textbf{Median} & \textbf{Mean} & \textbf{Max} \\")
    lines.append(r"\midrule")

    r = overall["reduction"]
    max_str = f"{r['max_pct']:.0f}" if r["max_pct"] < 100 else "50+"
    lines.append(f"Token reduction, CMV trim (\\%)          & {r['min_pct']:.0f}    & {r['median_pct']:.0f}   & {r['mean_pct']:.0f}   & {max_str} \\\\")
    lines.append(r"Token reduction, native autocompact (\%) & --   & --   & 98   & --  \\")

    c = overall["cost"]
    lines.append(f"Cache miss penalty (\\$)       & {c['min_cache_miss_penalty']:.2f} & {c['median_cache_miss_penalty']:.2f} & {c['mean_cache_miss_penalty']:.2f} & {c['max_cache_miss_penalty']:.2f} \\\\")

    b = overall["breakeven"]
    max_be = f"{b['max_turns']:.0f}" if b["max_turns"] < 100 else "100+"
    lines.append(f"Break-even (turns, Sonnet 4)  & {b['min_turns']}    & {b['median_turns']:.0f}   & {b['mean_turns']:.0f}   & {max_be} \\\\")

    lines.append(r"\bottomrule")
    lines.append(r"\end{tabular}")
    lines.append(r"\end{table}")
    lines.append("")

    # Table 3: Per-tier results
    lines.append("% ── Table 3: Per-tier results ──")
    lines.append(r"\begin{table}[H]")
    lines.append(r"\centering")
    lines.append(r"\caption{Trimming results segmented by session bloat profile (tool result bytes as \% of total JSONL bytes).}")
    lines.append(r"\label{tab:tiers}")
    lines.append(r"\small")
    lines.append(r"\begin{tabular}{lrrrrr}")
    lines.append(r"\toprule")
    lines.append(r"\textbf{Bloat Profile} & \textbf{Sessions} & \textbf{Mean Reduction} & \textbf{Median Reduction} & \textbf{Mean Break-even} & \textbf{Mean Context} \\")
    lines.append(r"\midrule")

    for tier_name in ["tool_heavy", "mixed", "conversational"]:
        t = tiers[tier_name]
        if t["count"] == 0:
            lines.append(f"{t['label']} & 0 & -- & -- & -- & -- \\\\")
        else:
            lines.append(
                f"{t['label']} & {t['count']} & {t['mean_reduction_pct']:.0f}\\% & "
                f"{t['median_reduction_pct']:.0f}\\% & {t['mean_breakeven']:.0f} turns & "
                f"{t['mean_tokens']//1000}k \\\\")

    lines.append(r"\midrule")
    # Overall row
    r = overall["reduction"]
    b = overall["breakeven"]
    t_all = overall["tokens"]
    lines.append(
        f"\\textbf{{All sessions}} & \\textbf{{{n}}} & \\textbf{{{r['mean_pct']:.0f}\\%}} & "
        f"\\textbf{{{r['median_pct']:.0f}\\%}} & \\textbf{{{b['mean_turns']:.0f} turns}} & "
        f"\\textbf{{{t_all['mean_pre_trim']//1000}k}} \\\\")

    lines.append(r"\bottomrule")
    lines.append(r"\end{tabular}")
    lines.append(r"\end{table}")

    out_path = f"{output_prefix}_tables.tex"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"  Saved: {out_path}")


# ── Console summary ──────────────────────────────────────────────────

def print_summary(sessions: list[SessionData], pricing: dict, hit_rate: float):
    """Print detailed per-session table to console."""
    reductions = [s.reduction_pct for s in sessions]
    mean_red = np.mean(reductions) if reductions else 0
    median_red = np.median(reductions) if reductions else 0
    bes = [min(s.breakeven_turns, 60) for s in sessions]
    avg_be = np.mean(bes) if bes else 0

    print(f"\n{'Session':>14}  {'Project':>20}  {'Tokens':>8}  {'Post-Trim':>10}  {'Reduction':>10}  {'Tier':>14}  {'B/E':>5}")
    print("-" * 95)
    for s in sorted(sessions, key=lambda x: x.reduction_pct, reverse=True)[:30]:
        print(
            f"  {s.session_id[:12]}  {s.project[:20]:>20}  "
            f"{s.estimated_tokens:>7,}  {s.post_trim_tokens:>9,}  "
            f"{s.reduction_pct:>8.1f}%  {s.tier_label:>14}  "
            f"{min(s.breakeven_turns, 100):>5}"
        )

    print(f"\n  Sessions:         {len(sessions)}")
    print(f"  Mean reduction:   {mean_red:.1f}%")
    print(f"  Median reduction: {median_red:.1f}%")
    print(f"  Mean break-even:  {avg_be:.0f} turns")
    print(f"  Sessions > 30% reduction: {sum(1 for r in reductions if r > 30)}/{len(sessions)}")


# ── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="CMV Cache Impact Benchmark")
    parser.add_argument(
        "--input-json", type=str, default=None,
        help="Path to JSON from `cmv benchmark --all --json` (ground-truth mode)",
    )
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
        "--theme", choices=["dark", "light"], default="dark",
        help="Color theme: dark (README) or light (publication)",
    )
    parser.add_argument(
        "--individual", action="store_true",
        help="Generate individual per-panel PNGs (in addition to combined)",
    )
    parser.add_argument(
        "--stats", action="store_true",
        help="Emit benchmark_stats.json and tables.tex alongside figures",
    )
    parser.add_argument(
        "--min-tokens", type=int, default=5000,
        help="Minimum tokens to include session (standalone mode, default: 5000)",
    )
    args = parser.parse_args()

    pricing = PRICING[args.model]
    hit_rate = max(0, min(100, args.cache_rate)) / 100
    model_name = pricing["name"]

    print(f"CMV Cache Impact Benchmark")
    print(f"Model: {model_name}  |  Cache hit rate: {args.cache_rate}%  |  Theme: {args.theme}")

    # ── Load data ──
    if args.input_json:
        print(f"Loading ground-truth data from {args.input_json}...")
        sessions = load_from_json(args.input_json, pricing, hit_rate)
        print(f"Loaded {len(sessions)} sessions.")
    else:
        print("Standalone mode (legacy estimation). Discovering sessions...")
        jsonl_files = discover_sessions()
        print(f"Found {len(jsonl_files)} JSONL files. Analyzing...")

        sessions = []
        for i, fp in enumerate(jsonl_files):
            sa = analyze_session(str(fp))
            if sa and sa.estimated_tokens >= args.min_tokens:
                # Compute breakeven for standalone mode
                proj = project_costs(sa.estimated_tokens, sa.post_trim_tokens, pricing, hit_rate)
                sa.breakeven_turns = proj.breakeven
                penalty_cost = cold_cost(sa.post_trim_tokens, pricing) - cost_per_turn(sa.estimated_tokens, hit_rate, pricing)
                savings_cost = cost_per_turn(sa.estimated_tokens, hit_rate, pricing) - cost_per_turn(sa.post_trim_tokens, hit_rate, pricing)
                sa.cache_miss_penalty = penalty_cost
                sa.savings_per_turn = savings_cost
                sessions.append(sa)
            if (i + 1) % 20 == 0:
                print(f"  ...processed {i + 1}/{len(jsonl_files)}")

        print(f"Analyzed {len(sessions)} sessions with >{args.min_tokens} tokens.")

    if not sessions:
        print("No qualifying sessions found.")
        sys.exit(0)

    # Sort by reduction for consistent display
    sessions.sort(key=lambda s: s.estimated_tokens, reverse=True)

    theme = get_theme(args.theme)
    apply_theme(theme)

    # ── Generate outputs ──
    print("\nGenerating charts...")
    generate_combined_chart(sessions, pricing, model_name, hit_rate, args.output, theme)

    if args.individual:
        generate_individual_figures(sessions, pricing, model_name, hit_rate, args.output, theme)

    if args.stats:
        print("\nGenerating stats...")
        stats_data = write_stats(sessions, pricing, hit_rate, model_name, args.output)
        write_tables_tex(stats_data, args.output)

    print_summary(sessions, pricing, hit_rate)


if __name__ == "__main__":
    main()

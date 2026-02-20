import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { SessionAnalysis } from '../types/index.js';

const CONTEXT_LIMIT = 200_000;

// System prompt + tool definitions + skills are always in context but never
// appear in the JSONL. This constant accounts for that base overhead.
// Typical: system prompt ~3k + tools ~16k + skills ~1k ≈ 20k tokens.
const SYSTEM_OVERHEAD_TOKENS = 20_000;

/**
 * Extract the character length of actual text content from a content block array.
 * This is what actually goes into the context window — not the JSON overhead.
 */
function contentTextLength(content: any): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      total += block.text.length;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      total += block.thinking.length;
    } else if (block.type === 'tool_use' && block.input) {
      total += JSON.stringify(block.input).length;
    } else if (block.type === 'tool_result') {
      total += contentTextLength(block.content);
    }
  }
  return total;
}

function freshBreakdown() {
  return {
    toolResults: { bytes: 0, count: 0, percent: 0 },
    thinkingSignatures: { bytes: 0, count: 0, percent: 0 },
    fileHistory: { bytes: 0, count: 0, percent: 0 },
    conversation: { bytes: 0, percent: 0 },
    toolUseRequests: { bytes: 0, count: 0, percent: 0 },
    other: { bytes: 0, percent: 0 },
  };
}

/**
 * Analyze a JSONL session file and return a content breakdown.
 * Read-only — never modifies the file.
 *
 * Detects compaction boundaries (type:"summary" lines). When Claude Code
 * auto-compacts, old messages stay in the JSONL but are no longer in the
 * active context. We only count content after the last compaction.
 *
 * Token estimation prefers actual API-reported token counts from the JSONL
 * (usage.input_tokens on assistant messages). Falls back to a chars/4 heuristic
 * when no usage data is available.
 */
export async function analyzeSession(jsonlPath: string): Promise<SessionAnalysis> {
  const stat = await fs.stat(jsonlPath);

  let breakdown = freshBreakdown();
  let messageCount = { user: 0, assistant: 0, toolResults: 0 };
  let contentChars = 0;
  let activeBytes = 0;
  // Track the last API-reported token count from assistant message usage data.
  // This is far more accurate than any character-based heuristic.
  // Only updates when a genuinely new API call is detected (input tokens changed),
  // not on every streaming chunk of the same call.
  let lastApiInputTokens: number | null = null;
  let contentCharsAtLastApiUpdate = 0;

  const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const lineBytes = Buffer.byteLength(line, 'utf-8');

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      activeBytes += lineBytes;
      breakdown.other.bytes += lineBytes;
      continue;
    }

    // Compaction boundary — everything before this was summarised and is
    // no longer in the active context. Reset breakdown/byte counters but
    // KEEP lastApiInputTokens — the JSONL after compaction often has very
    // little new content (just file-history + meta messages). The actual live
    // context includes the summary + preserved recent messages which aren't
    // re-written to the JSONL. The pre-compaction API data is a better
    // estimate than nothing; it naturally updates on the next API call.
    // Claude Code uses two formats:
    //   - type:"summary" (older format)
    //   - type:"system" with subtype:"compact_boundary" (current format)
    const isCompaction = parsed.type === 'summary' ||
      (parsed.type === 'system' && parsed.subtype === 'compact_boundary');
    if (isCompaction) {
      breakdown = freshBreakdown();
      messageCount = { user: 0, assistant: 0, toolResults: 0 };
      contentChars = 0;
      activeBytes = lineBytes;

      // The summary text replaces all prior messages in context
      const summaryText = parsed.summary ??
        (typeof parsed.content === 'string' ? parsed.content : null);
      if (typeof summaryText === 'string') {
        contentChars += summaryText.length;
        breakdown.conversation.bytes += lineBytes;
      }
      // Keep lastApiInputTokens (don't reset) — see comment above.
      // Reset contentCharsAtLastApiUpdate to match the reset contentChars
      // so the delta calculation stays correct.
      contentCharsAtLastApiUpdate = 0;
      continue;
    }

    activeBytes += lineBytes;

    // File history entries — not sent to API
    if (parsed.type === 'file-history-snapshot') {
      breakdown.fileHistory.bytes += lineBytes;
      breakdown.fileHistory.count++;
      continue;
    }

    // Queue operations — internal metadata, not conversation
    if (parsed.type === 'queue-operation') {
      breakdown.other.bytes += lineBytes;
      continue;
    }

    // Determine role: prefer parsed.role over parsed.type because
    // assistant responses have type:"message" but role:"assistant"
    const role = parsed.role || parsed.type;
    if (role === 'user' || role === 'human') messageCount.user++;
    if (role === 'assistant') {
      messageCount.assistant++;

      // Extract API-reported token count from usage data.
      // input_tokens = non-cached, cache_* = cached portions; sum = total context input.
      // Don't include output_tokens — JSONL lines are streaming chunks where
      // output_tokens is partial/unreliable. The actual output is estimated
      // from content chars that follow.
      // Only update baseline when a NEW API call is detected (input changed),
      // not on every streaming chunk of the same call.
      const usage = parsed.message?.usage ?? parsed.usage;
      if (usage?.input_tokens != null) {
        const apiInput =
          (usage.input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0);
        // Skip zero-value streaming init events and only update on genuinely
        // new API calls (input changed), not repeated chunks of the same call.
        if (apiInput > 0 && apiInput !== lastApiInputTokens) {
          lastApiInputTokens = apiInput;
          contentCharsAtLastApiUpdate = contentChars;
        }
      }
    }

    // Analyze content blocks
    const content = parsed.message?.content ?? parsed.content;
    let toolResultBytes = 0;
    let signatureBytes = 0;
    let toolUseBytes = 0;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const blockBytes = Buffer.byteLength(JSON.stringify(block), 'utf-8');
          toolResultBytes += blockBytes;
          breakdown.toolResults.count++;
          messageCount.toolResults++;

          // Count actual tool result text toward content tokens
          contentChars += contentTextLength(block.content);
        }
        if (block.type === 'thinking') {
          if (block.signature) {
            signatureBytes += Buffer.byteLength(JSON.stringify(block.signature), 'utf-8');
            breakdown.thinkingSignatures.count++;
          }
          // Thinking text counts toward content tokens
          if (typeof block.thinking === 'string') {
            contentChars += block.thinking.length;
          }
        }
        if (block.type === 'tool_use') {
          toolUseBytes += Buffer.byteLength(JSON.stringify(block), 'utf-8');
          breakdown.toolUseRequests.count++;
          // Tool use input counts toward content tokens
          if (block.input) {
            contentChars += JSON.stringify(block.input).length;
          }
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          contentChars += block.text.length;
        }
      }
    } else if (typeof content === 'string') {
      contentChars += content.length;
    }

    breakdown.toolResults.bytes += toolResultBytes;
    breakdown.thinkingSignatures.bytes += signatureBytes;
    breakdown.toolUseRequests.bytes += toolUseBytes;

    const accountedBytes = toolResultBytes + signatureBytes + toolUseBytes;

    if (role === 'user' || role === 'human' || role === 'assistant') {
      breakdown.conversation.bytes += Math.max(0, lineBytes - accountedBytes);
    } else {
      breakdown.other.bytes += Math.max(0, lineBytes - accountedBytes);
    }
  }

  rl.close();

  // Calculate percentages based on active-portion bytes (post-compaction)
  if (activeBytes > 0) {
    breakdown.toolResults.percent = Math.round((breakdown.toolResults.bytes / activeBytes) * 100);
    breakdown.thinkingSignatures.percent = Math.round((breakdown.thinkingSignatures.bytes / activeBytes) * 100);
    breakdown.fileHistory.percent = Math.round((breakdown.fileHistory.bytes / activeBytes) * 100);
    breakdown.conversation.percent = Math.round((breakdown.conversation.bytes / activeBytes) * 100);
    breakdown.toolUseRequests.percent = Math.round((breakdown.toolUseRequests.bytes / activeBytes) * 100);
    breakdown.other.percent = Math.round((breakdown.other.bytes / activeBytes) * 100);
  }

  // Prefer actual API-reported token count when available. lastApiInputTokens
  // is the total input for the most recent API call (includes system overhead).
  // Content added after that point is estimated via chars/4 heuristic.
  // When no API data exists, use heuristic + system overhead (system prompt,
  // tool definitions, skills are always in context but not in the JSONL).
  const heuristicTokens = Math.round(contentChars / 4);
  const estimatedTokens = lastApiInputTokens != null
    ? lastApiInputTokens + Math.round((contentChars - contentCharsAtLastApiUpdate) / 4)
    : heuristicTokens + SYSTEM_OVERHEAD_TOKENS;

  return {
    totalBytes: activeBytes,
    estimatedTokens,
    contextLimit: CONTEXT_LIMIT,
    contextUsedPercent: Math.round((estimatedTokens / CONTEXT_LIMIT) * 100),
    breakdown,
    messageCount,
  };
}

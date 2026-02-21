import * as readline from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { TrimMetrics } from '../types/index.js';

const DEFAULT_STUB_THRESHOLD = 500;

export interface TrimOptions {
  threshold?: number;
}

/** Tool names known to carry large file-content payloads. */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'MultiEdit',
]);

/** Input fields to always preserve (identification / small metadata). */
const PRESERVED_INPUT_FIELDS = new Set([
  'file_path',
  'notebook_path',
  'command',
  'description',
  'pattern',
  'path',
  'url',
  'skill',
  'args',
  'replace_all',
  'edit_mode',
  'cell_type',
  'cell_id',
]);

/**
 * Stub large content fields in a tool_use block's input.
 *
 * For known write tools: target content/old_string/new_string/new_source.
 * For all tools: if total input exceeds threshold, stub non-preserved string fields.
 */
function stubToolUseInput(
  block: any,
  threshold: number,
  metrics: TrimMetrics
): void {
  if (!block.input || typeof block.input !== 'object') return;

  const toolName: string = block.name || '';

  // Known write tools — targeted field stubbing
  if (WRITE_TOOLS.has(toolName)) {
    let stubbed = false;

    if (typeof block.input.content === 'string' && block.input.content.length > threshold) {
      block.input.content = `[Trimmed input: ~${block.input.content.length} chars]`;
      stubbed = true;
    }
    if (typeof block.input.old_string === 'string' && block.input.old_string.length > threshold) {
      block.input.old_string = `[Trimmed input: ~${block.input.old_string.length} chars]`;
      stubbed = true;
    }
    if (typeof block.input.new_string === 'string' && block.input.new_string.length > threshold) {
      block.input.new_string = `[Trimmed input: ~${block.input.new_string.length} chars]`;
      stubbed = true;
    }
    if (typeof block.input.new_source === 'string' && block.input.new_source.length > threshold) {
      block.input.new_source = `[Trimmed input: ~${block.input.new_source.length} chars]`;
      stubbed = true;
    }

    if (stubbed) {
      metrics.toolUseInputsStubbed++;
      return;
    }
  }

  // Broad fallback — stub any large string field on any tool
  const inputStr = JSON.stringify(block.input);
  if (inputStr.length <= threshold) return;

  let stubbed = false;
  for (const [key, value] of Object.entries(block.input)) {
    if (PRESERVED_INPUT_FIELDS.has(key)) continue;
    if (typeof value === 'string' && value.length > threshold) {
      block.input[key] = `[Trimmed input: ~${(value as string).length} chars]`;
      stubbed = true;
    }
  }

  if (stubbed) {
    metrics.toolUseInputsStubbed++;
  }
}

/**
 * Process a content block array: strip images, stub large tool results,
 * stub large tool_use inputs, remove thinking blocks.
 * Returns the (potentially filtered) array.
 */
function processContentArray(
  content: any[],
  threshold: number,
  metrics: TrimMetrics
): any[] {
  for (const block of content) {
    // Strip image blocks from tool results — base64 data is waste on a new branch
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const imageBlocks = block.content.filter((c: any) => c.type === 'image');
      if (imageBlocks.length > 0) {
        metrics.imagesStripped += imageBlocks.length;
        block.content = block.content.filter((c: any) => c.type !== 'image');
      }

      // Size check includes stripped image bytes for accurate threshold decision
      const textLen = block.content
        .reduce((sum: number, c: any) => {
          if (c.type === 'text') return sum + (c.text?.length || 0);
          return sum + JSON.stringify(c).length;
        }, 0);
      const imageLen = imageBlocks
        .reduce((sum: number, c: any) => sum + JSON.stringify(c).length, 0);

      if ((textLen + imageLen) > threshold) {
        metrics.toolResultsStubbed++;
        block.content = [{ type: 'text', text: `[Trimmed tool result: ~${textLen + imageLen} chars]` }];
      }
    }

    // Stub large tool result string content
    if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > threshold) {
      metrics.toolResultsStubbed++;
      const len = block.content.length;
      block.content = `[Trimmed tool result: ~${len} chars]`;
    }

    // Stub large tool_use inputs + count requests
    if (block.type === 'tool_use') {
      metrics.toolUseRequests++;
      stubToolUseInput(block, threshold, metrics);
    }
  }

  // Remove thinking blocks entirely (API requires signature field)
  const thinkingCount = content.filter((b: any) => b.type === 'thinking').length;
  if (thinkingCount > 0) {
    metrics.signaturesStripped += thinkingCount;
    content = content.filter((b: any) => b.type !== 'thinking');
  }

  return content;
}

/**
 * Trim a JSONL session file: strip bloat, keep conversation.
 *
 * Rules:
 *   1. Pre-compaction content → skip entirely (dead weight)
 *   2. file-history-snapshot entries → skip entirely
 *   3. queue-operation entries → skip entirely
 *   4. Image blocks in tool results → strip always
 *   5. tool_result content > threshold → stub with summary
 *   6. tool_use input for write ops (+ broad fallback) → stub large fields
 *   7. thinking blocks → remove entirely (signature is required by API)
 *   8. API usage metadata → strip
 *   9. Everything else → preserved verbatim
 */
export async function trimJsonl(
  sourcePath: string,
  destPath: string,
  options: TrimOptions = {}
): Promise<TrimMetrics> {
  const STUB_THRESHOLD = Math.max(options.threshold ?? DEFAULT_STUB_THRESHOLD, 50);

  const metrics: TrimMetrics = {
    originalBytes: 0,
    trimmedBytes: 0,
    toolResultsStubbed: 0,
    signaturesStripped: 0,
    fileHistoryRemoved: 0,
    imagesStripped: 0,
    toolUseInputsStubbed: 0,
    preCompactionLinesSkipped: 0,
    queueOperationsRemoved: 0,
    userMessages: 0,
    assistantResponses: 0,
    toolUseRequests: 0,
  };

  const stat = await fs.stat(sourcePath);
  metrics.originalBytes = stat.size;

  // ── Pass 1: Find the last compaction boundary line number ──
  // Cheap string check avoids JSON.parse on most lines.
  let lastCompactionLine = -1;
  {
    const scanStream = createReadStream(sourcePath, { encoding: 'utf-8' });
    const scanRl = readline.createInterface({ input: scanStream, crlfDelay: Infinity });
    let lineNum = 0;
    for await (const line of scanRl) {
      if (!line.trim()) { lineNum++; continue; }
      if (line.includes('"summary"') || line.includes('"compact_boundary"')) {
        try {
          const p = JSON.parse(line);
          if (p.type === 'summary' || (p.type === 'system' && p.subtype === 'compact_boundary')) {
            lastCompactionLine = lineNum;
          }
        } catch { /* not valid JSON */ }
      }
      lineNum++;
    }
    scanRl.close();
  }

  // ── Pass 2: Trim, skipping lines before last compaction boundary ──
  const fileStream = createReadStream(sourcePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const writer = createWriteStream(destPath, { encoding: 'utf-8' });
  let currentLine = 0;

  for await (const line of rl) {
    if (!line.trim()) { currentLine++; continue; }

    // Skip all lines before the last compaction boundary
    if (lastCompactionLine >= 0 && currentLine < lastCompactionLine) {
      metrics.preCompactionLinesSkipped++;
      currentLine++;
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      writer.write(line + '\n');
      currentLine++;
      continue;
    }

    // Skip file-history-snapshot entries
    if (parsed.type === 'file-history-snapshot') {
      metrics.fileHistoryRemoved++;
      currentLine++;
      continue;
    }

    // Skip queue-operation entries
    if (parsed.type === 'queue-operation') {
      metrics.queueOperationsRemoved++;
      currentLine++;
      continue;
    }

    // Count message types (prefer role — assistant responses have type:"message")
    const role = parsed.role || parsed.type;
    if (role === 'user' || role === 'human') {
      metrics.userMessages++;
    }
    if (role === 'assistant') {
      metrics.assistantResponses++;
    }

    // Process content arrays (images, tool results, tool_use inputs, thinking)
    if (Array.isArray(parsed.message?.content)) {
      parsed.message.content = processContentArray(parsed.message.content, STUB_THRESHOLD, metrics);
    }
    if (Array.isArray(parsed.content)) {
      parsed.content = processContentArray(parsed.content, STUB_THRESHOLD, metrics);
    }

    // Strip API usage data — it reflects the original pre-trim context size
    // and would cause the analyzer to report stale (too-high) token counts.
    if (parsed.message?.usage) delete parsed.message.usage;
    if (parsed.usage) delete parsed.usage;

    writer.write(JSON.stringify(parsed) + '\n');
    currentLine++;
  }

  rl.close();

  await new Promise<void>((resolve, reject) => {
    writer.end(() => resolve());
    writer.on('error', reject);
  });

  const destStat = await fs.stat(destPath);
  metrics.trimmedBytes = destStat.size;

  return metrics;
}

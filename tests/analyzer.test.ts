import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { analyzeSession } from '../src/core/analyzer.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write lines to a temp JSONL file and return its path. */
async function writeJsonl(name: string, lines: any[]): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('analyzer', () => {
  describe('basic message counting', () => {
    it('counts user and assistant messages correctly', async () => {
      const p = await writeJsonl('basic.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        { type: 'user', content: 'question' },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'answer' }] },
      ]);

      const result = await analyzeSession(p);

      expect(result.messageCount.user).toBe(2);
      expect(result.messageCount.assistant).toBe(2);
      expect(result.messageCount.toolResults).toBe(0);
    });
  });

  describe('content breakdown - tool results', () => {
    it('counts tool_result blocks in toolResults', async () => {
      const p = await writeJsonl('toolresults.jsonl', [
        { type: 'user', content: 'read this file' },
        { type: 'assistant', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file contents here' },
          { type: 'tool_result', tool_use_id: 't2', content: 'another file' },
        ] },
      ]);

      const result = await analyzeSession(p);

      expect(result.breakdown.toolResults.count).toBe(2);
      expect(result.breakdown.toolResults.bytes).toBeGreaterThan(0);
      expect(result.messageCount.toolResults).toBe(2);
    });
  });

  describe('thinking signatures', () => {
    it('counts thinking blocks with signature field', async () => {
      const p = await writeJsonl('thinking.jsonl', [
        { type: 'assistant', content: [
          { type: 'thinking', thinking: 'let me reason about this', signature: 'sig123abc' },
          { type: 'text', text: 'my response' },
        ] },
        { type: 'assistant', content: [
          { type: 'thinking', thinking: 'more reasoning', signature: 'sig456def' },
          { type: 'text', text: 'second response' },
        ] },
      ]);

      const result = await analyzeSession(p);

      expect(result.breakdown.thinkingSignatures.count).toBe(2);
      expect(result.breakdown.thinkingSignatures.bytes).toBeGreaterThan(0);
    });

    it('does not count thinking blocks without signature', async () => {
      const p = await writeJsonl('thinking-nosig.jsonl', [
        { type: 'assistant', content: [
          { type: 'thinking', thinking: 'reasoning without signature' },
          { type: 'text', text: 'response' },
        ] },
      ]);

      const result = await analyzeSession(p);

      expect(result.breakdown.thinkingSignatures.count).toBe(0);
      expect(result.breakdown.thinkingSignatures.bytes).toBe(0);
    });
  });

  describe('file history', () => {
    it('counts file-history-snapshot entries in fileHistory', async () => {
      const p = await writeJsonl('filehistory.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'file-history-snapshot', data: { files: ['a.ts', 'b.ts'] } },
        { type: 'file-history-snapshot', data: { files: ['c.ts'] } },
        { type: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ]);

      const result = await analyzeSession(p);

      expect(result.breakdown.fileHistory.count).toBe(2);
      expect(result.breakdown.fileHistory.bytes).toBeGreaterThan(0);
    });
  });

  describe('queue operations', () => {
    it('puts queue-operation entries into other', async () => {
      const p = await writeJsonl('queue.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'queue-operation', op: 'something' },
        { type: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ]);

      const result = await analyzeSession(p);

      expect(result.breakdown.other.bytes).toBeGreaterThan(0);
      expect(result.messageCount.user).toBe(1);
      expect(result.messageCount.assistant).toBe(1);
    });
  });

  describe('compaction boundary - type:summary', () => {
    it('resets all counters except lastApiInputTokens on summary', async () => {
      const p = await writeJsonl('compaction-summary.jsonl', [
        { type: 'user', content: 'old message' },
        { type: 'assistant', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'old tool result' },
        ] },
        { type: 'file-history-snapshot', data: { files: ['old.ts'] } },
        { type: 'summary', summary: 'This is a summary of the conversation so far.' },
        { type: 'user', content: 'new message' },
        { type: 'assistant', content: [{ type: 'text', text: 'new response' }] },
      ]);

      const result = await analyzeSession(p);

      // Old messages should not be counted
      expect(result.messageCount.user).toBe(1);
      expect(result.messageCount.assistant).toBe(1);
      expect(result.messageCount.toolResults).toBe(0);
      expect(result.breakdown.fileHistory.count).toBe(0);
      expect(result.breakdown.toolResults.count).toBe(0);
    });
  });

  describe('compaction boundary - type:system subtype:compact_boundary', () => {
    it('resets counters on compact_boundary', async () => {
      const p = await writeJsonl('compaction-boundary.jsonl', [
        { type: 'user', content: 'old' },
        { type: 'assistant', content: [{ type: 'text', text: 'old response' }] },
        { type: 'system', subtype: 'compact_boundary' },
        { type: 'user', content: 'new' },
      ]);

      const result = await analyzeSession(p);

      expect(result.messageCount.user).toBe(1);
      expect(result.messageCount.assistant).toBe(0);
    });
  });

  describe('multiple compaction boundaries', () => {
    it('uses the last compaction boundary', async () => {
      const p = await writeJsonl('multi-compaction.jsonl', [
        { type: 'user', content: 'ancient' },
        { type: 'summary', summary: 'first summary' },
        { type: 'user', content: 'old' },
        { type: 'assistant', content: [{ type: 'text', text: 'old resp' }] },
        { type: 'summary', summary: 'second summary' },
        { type: 'user', content: 'current' },
        { type: 'assistant', content: [{ type: 'text', text: 'current resp' }] },
      ]);

      const result = await analyzeSession(p);

      // Only messages after second compaction
      expect(result.messageCount.user).toBe(1);
      expect(result.messageCount.assistant).toBe(1);
    });
  });

  describe('API token extraction', () => {
    it('uses usage.input_tokens plus cache fields for token estimate', async () => {
      const p = await writeJsonl('api-tokens.jsonl', [
        { type: 'user', content: 'hello' },
        {
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'hi' }],
          message: {
            content: [{ type: 'text', text: 'hi' }],
            usage: {
              input_tokens: 5000,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 1000,
            },
          },
        },
      ]);

      const result = await analyzeSession(p);

      // API tokens = 5000 + 2000 + 1000 = 8000
      // Plus heuristic for any chars after the API update
      expect(result.estimatedTokens).toBeGreaterThanOrEqual(8000);
      expect(result.contextLimit).toBe(200000);
    });

    it('preserves lastApiInputTokens across compaction boundary', async () => {
      const p = await writeJsonl('api-across-compaction.jsonl', [
        { type: 'user', content: 'hello' },
        {
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'hi' }],
          message: {
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 10000 },
          },
        },
        { type: 'summary', summary: 'compacted' },
        { type: 'user', content: 'new msg' },
      ]);

      const result = await analyzeSession(p);

      // lastApiInputTokens (10000) is preserved across compaction
      // so estimatedTokens should be based on 10000, not heuristic
      expect(result.estimatedTokens).toBeGreaterThanOrEqual(10000);
    });
  });

  describe('heuristic fallback', () => {
    it('uses chars/4 + 20000 system overhead when no API data', async () => {
      const text = 'a'.repeat(400); // 400 chars -> 100 tokens heuristic
      const p = await writeJsonl('heuristic.jsonl', [
        { type: 'user', content: text },
      ]);

      const result = await analyzeSession(p);

      // 400 chars / 4 = 100 tokens + 20000 system overhead = 20100
      expect(result.estimatedTokens).toBe(20100);
    });
  });

  describe('tool_use requests', () => {
    it('counts tool_use blocks in toolUseRequests', async () => {
      const p = await writeJsonl('tooluse.jsonl', [
        { type: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Glob', input: { pattern: '*.ts' } },
          { type: 'text', text: 'reading files' },
        ] },
      ]);

      const result = await analyzeSession(p);

      expect(result.breakdown.toolUseRequests.count).toBe(2);
      expect(result.breakdown.toolUseRequests.bytes).toBeGreaterThan(0);
    });
  });

  describe('empty file', () => {
    it('returns zeros for an empty file', async () => {
      const p = path.join(tmpDir, 'empty.jsonl');
      await fs.writeFile(p, '');

      const result = await analyzeSession(p);

      expect(result.totalBytes).toBe(0);
      expect(result.estimatedTokens).toBe(20000); // just system overhead
      expect(result.contextLimit).toBe(200000);
      expect(result.contextUsedPercent).toBe(10); // 20000/200000 = 10%
      expect(result.messageCount.user).toBe(0);
      expect(result.messageCount.assistant).toBe(0);
      expect(result.messageCount.toolResults).toBe(0);
      expect(result.breakdown.toolResults.bytes).toBe(0);
      expect(result.breakdown.conversation.bytes).toBe(0);
    });
  });

  describe('unparseable lines', () => {
    it('adds unparseable lines to other.bytes', async () => {
      const p = path.join(tmpDir, 'bad.jsonl');
      await fs.writeFile(p, 'this is not json\n{"type":"user","content":"hello"}\n');

      const result = await analyzeSession(p);

      expect(result.breakdown.other.bytes).toBeGreaterThan(0);
      expect(result.messageCount.user).toBe(1);
    });
  });

  describe('percentage calculation', () => {
    it('calculates percent as bytes / activeBytes * 100, rounded', async () => {
      // Create a file with a known mix of content types
      const p = await writeJsonl('percents.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'assistant', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(200) },
        ] },
        { type: 'file-history-snapshot', data: { files: ['a.ts'] } },
      ]);

      const result = await analyzeSession(p);

      // Verify all percentages are non-negative integers
      expect(Number.isInteger(result.breakdown.toolResults.percent)).toBe(true);
      expect(Number.isInteger(result.breakdown.fileHistory.percent)).toBe(true);
      expect(Number.isInteger(result.breakdown.conversation.percent)).toBe(true);

      // Verify percentages are reasonable (roughly sum to ~100)
      const totalPercent =
        result.breakdown.toolResults.percent +
        result.breakdown.thinkingSignatures.percent +
        result.breakdown.fileHistory.percent +
        result.breakdown.conversation.percent +
        result.breakdown.toolUseRequests.percent +
        result.breakdown.other.percent;

      // Due to rounding, total might not be exactly 100, but should be close
      expect(totalPercent).toBeGreaterThanOrEqual(95);
      expect(totalPercent).toBeLessThanOrEqual(105);
    });
  });

  describe('contextUsedPercent', () => {
    it('calculates context used as estimatedTokens / contextLimit * 100', async () => {
      const p = await writeJsonl('ctxpercent.jsonl', [
        {
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'hi' }],
          message: {
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 100000 },
          },
        },
      ]);

      const result = await analyzeSession(p);

      // 100000 / 200000 * 100 = 50%
      expect(result.contextUsedPercent).toBe(50);
    });
  });
});

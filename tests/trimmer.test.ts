import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trimJsonl } from '../src/core/trimmer.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

/** Write lines to a temp JSONL file and return its path. */
async function writeJsonl(name: string, lines: any[]): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** Read a JSONL file back into parsed objects. */
async function readJsonl(p: string): Promise<any[]> {
  const raw = await fs.readFile(p, 'utf-8');
  return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('trimmer', () => {
  describe('file-history-snapshot removal', () => {
    it('removes file-history-snapshot entries', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'file-history-snapshot', data: { files: ['a.ts', 'b.ts'] } },
        { type: 'assistant', content: 'hi' },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.fileHistoryRemoved).toBe(1);
      expect(output).toHaveLength(2);
      expect(output.every((l: any) => l.type !== 'file-history-snapshot')).toBe(true);
    });
  });

  describe('queue-operation removal', () => {
    it('removes queue-operation entries', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'queue-operation', op: 'something' },
        { type: 'queue-operation', op: 'another' },
        { type: 'assistant', content: 'hi' },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.queueOperationsRemoved).toBe(2);
      expect(output).toHaveLength(2);
    });
  });

  describe('tool_result stubbing', () => {
    it('stubs string tool_result content over threshold', async () => {
      const bigContent = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolResultsStubbed).toBe(1);
      const block = output[0].content[0];
      expect(block.content).toContain('[Trimmed tool result');
    });

    it('preserves small tool_result content', async () => {
      const smallContent = 'x'.repeat(100);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: smallContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolResultsStubbed).toBe(0);
      expect(output[0].content[0].content).toBe(smallContent);
    });

    it('stubs array tool_result content over threshold', async () => {
      const bigText = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: bigText }] }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolResultsStubbed).toBe(1);
      expect(output[0].content[0].content[0].text).toContain('[Trimmed tool result');
    });
  });

  describe('image stripping', () => {
    it('strips image blocks from tool_result arrays', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_result', tool_use_id: 't1', content: [
            { type: 'image', source: { type: 'base64', data: 'AAAA'.repeat(500) } },
            { type: 'text', text: 'some text' },
          ]
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.imagesStripped).toBe(1);
      const resultContent = output[0].content[0].content;
      expect(resultContent.every((b: any) => b.type !== 'image')).toBe(true);
    });
  });

  describe('thinking block removal', () => {
    it('removes thinking blocks', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [
          { type: 'thinking', thinking: 'internal reasoning', signature: 'abc123' },
          { type: 'text', text: 'my response' },
        ] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.signaturesStripped).toBe(1);
      expect(output[0].content).toHaveLength(1);
      expect(output[0].content[0].type).toBe('text');
    });
  });

  describe('tool_use input stubbing', () => {
    it('stubs Write tool content field', async () => {
      const bigContent = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't1', name: 'Write',
          input: { file_path: '/a/b.ts', content: bigContent }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolUseInputsStubbed).toBe(1);
      const input = output[0].content[0].input;
      expect(input.file_path).toBe('/a/b.ts');
      expect(input.content).toContain('[Trimmed input');
    });

    it('stubs Edit tool old_string and new_string', async () => {
      const big = 'y'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't1', name: 'Edit',
          input: { file_path: '/a/b.ts', old_string: big, new_string: big }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolUseInputsStubbed).toBe(1);
      const input = output[0].content[0].input;
      expect(input.file_path).toBe('/a/b.ts');
      expect(input.old_string).toContain('[Trimmed input');
      expect(input.new_string).toContain('[Trimmed input');
    });

    it('preserves identification fields in broad fallback', async () => {
      // Use a non-preserved string field (extra) to force a stubbing pass so
      // the metric increments and we can assert preserved fields come through
      // untouched.
      const bigExtra = 'z'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't1', name: 'CustomTool',
          input: { description: 'do stuff', extra: bigExtra }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolUseInputsStubbed).toBe(1);
      const input = output[0].content[0].input;
      expect(input.description).toBe('do stuff');
      expect(input.extra).toContain('[Trimmed input');
    });

    it('preserves Task/Agent prompt field even when over threshold', async () => {
      // The Agent/Task tool input's `prompt` field carries the dispatched
      // subagent's instructions verbatim. Stubbing it would hand the subagent
      // "[Trimmed input: ~N chars]" instead of a real task.
      const bigPrompt = 'z'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't1', name: 'Task',
          input: { description: 'do stuff', prompt: bigPrompt }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      // No non-preserved string field is large enough to stub — metric stays 0.
      expect(metrics.toolUseInputsStubbed).toBe(0);
      const input = output[0].content[0].input;
      expect(input.description).toBe('do stuff');
      expect(input.prompt).toBe(bigPrompt);
    });

    it('does not stub small tool_use inputs', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't1', name: 'Read',
          input: { file_path: '/a/b.ts' }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.toolUseInputsStubbed).toBe(0);
      expect(output[0].content[0].input.file_path).toBe('/a/b.ts');
    });
  });

  describe('pre-compaction skipping', () => {
    it('skips lines before last compaction boundary', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'old message 1' },
        { type: 'assistant', content: 'old response' },
        { type: 'summary', summary: 'compaction happened here' },
        { type: 'user', content: 'new message' },
        { type: 'assistant', content: 'new response' },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.preCompactionLinesSkipped).toBe(2);
      expect(output[0].type).toBe('summary');
      expect(output).toHaveLength(3);
    });

    it('handles compact_boundary subtype', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'old' },
        { type: 'system', subtype: 'compact_boundary' },
        { type: 'user', content: 'new' },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.preCompactionLinesSkipped).toBe(1);
      expect(output[0].type).toBe('system');
      expect(output).toHaveLength(2);
    });

    it('uses LAST compaction boundary when multiple exist', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'ancient' },
        { type: 'summary', summary: 'first compaction' },
        { type: 'user', content: 'old' },
        { type: 'summary', summary: 'second compaction' },
        { type: 'user', content: 'current' },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.preCompactionLinesSkipped).toBe(3);
      expect(output[0].summary).toBe('second compaction');
      expect(output).toHaveLength(2);
    });
  });

  describe('usage stripping', () => {
    it('strips message.usage and top-level usage', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1000 } }, usage: { total: 5000 } },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(output[0].message.usage).toBeUndefined();
      expect(output[0].usage).toBeUndefined();
    });
  });

  describe('message counting', () => {
    it('counts user and assistant messages', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { type: 'user', content: 'q2' },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);

      expect(metrics.userMessages).toBe(2);
      expect(metrics.assistantResponses).toBe(2);
    });

    it('counts tool_use requests', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Glob', input: { pattern: '*.ts' } },
        ] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);

      expect(metrics.toolUseRequests).toBe(2);
    });
  });

  describe('threshold option', () => {
    it('respects custom threshold', async () => {
      const content = 'x'.repeat(300);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      // Default threshold (500) should not stub
      const m1 = await trimJsonl(src, dest, { keepLast: 0 });
      expect(m1.toolResultsStubbed).toBe(0);

      // Threshold 200 should stub
      const m2 = await trimJsonl(src, dest, { threshold: 200, keepLast: 0 });
      expect(m2.toolResultsStubbed).toBe(1);
    });

    it('enforces minimum threshold of 50', async () => {
      const content = 'x'.repeat(60);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      // threshold=10 should be clamped to 50, so 60 chars gets stubbed
      const metrics = await trimJsonl(src, dest, { threshold: 10, keepLast: 0 });
      expect(metrics.toolResultsStubbed).toBe(1);
    });
  });

  describe('byte metrics', () => {
    it('reports original and trimmed byte sizes', async () => {
      const bigContent = 'x'.repeat(1000);
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'hello' },
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });

      expect(metrics.originalBytes).toBeGreaterThan(0);
      expect(metrics.trimmedBytes).toBeGreaterThan(0);
      expect(metrics.trimmedBytes).toBeLessThan(metrics.originalBytes);
    });
  });

  describe('unparseable JSON pass-through', () => {
    it('preserves lines that are not valid JSON', async () => {
      const src = path.join(tmpDir, 'src.jsonl');
      // Write a mix of valid JSON and invalid lines directly
      const lines = [
        JSON.stringify({ type: 'user', content: 'hello' }),
        'this is not valid JSON {{{',
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'hi' }] }),
      ];
      await fs.writeFile(src, lines.join('\n') + '\n');
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest);
      const raw = await fs.readFile(dest, 'utf-8');
      const outputLines = raw.trim().split('\n').filter(Boolean);

      expect(outputLines).toHaveLength(3);
      // The invalid line should be preserved as-is
      expect(outputLines[1]).toBe('this is not valid JSON {{{');
    });
  });

  describe('orphaned tool_result filtering', () => {
    it('filters tool_result blocks referencing skipped tool_use IDs from parsed.content', async () => {
      const src = await writeJsonl('src.jsonl', [
        // Pre-compaction: assistant with tool_use blocks
        { type: 'assistant', content: [
          { type: 'tool_use', id: 'tu_orphan1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 'tu_orphan2', name: 'Glob', input: { pattern: '*.ts' } },
        ] },
        // Pre-compaction: tool_result for one of them
        { type: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_orphan1', content: 'result1' },
        ] },
        // Compaction boundary
        { type: 'summary', summary: 'compacted' },
        // Post-compaction: a line with orphaned tool_result referencing skipped IDs
        { type: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_orphan2', content: 'orphaned result' },
          { type: 'text', text: 'keep this' },
        ] },
        { type: 'assistant', content: [{ type: 'text', text: 'response' }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      // Should have summary + user + assistant = 3 lines
      expect(output).toHaveLength(3);
      // The user line's content should have the orphaned tool_result filtered out
      const userContent = output[1].content;
      expect(userContent).toHaveLength(1);
      expect(userContent[0].type).toBe('text');
      expect(userContent[0].text).toBe('keep this');
    });

    it('filters tool_result blocks referencing skipped tool_use IDs from parsed.message.content', async () => {
      const src = await writeJsonl('src.jsonl', [
        // Pre-compaction: assistant with tool_use in message.content
        { type: 'message', message: { content: [
          { type: 'tool_use', id: 'tu_msg_orphan', name: 'Bash', input: { command: 'ls' } },
        ] } },
        // Compaction boundary
        { type: 'summary', summary: 'compacted' },
        // Post-compaction: line with orphaned tool_result in message.content
        { type: 'message', message: { content: [
          { type: 'tool_result', tool_use_id: 'tu_msg_orphan', content: 'orphan msg' },
          { type: 'text', text: 'msg kept' },
        ] } },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(output).toHaveLength(2); // summary + message
      const msg = output[1];
      // message.content should have orphaned tool_result removed
      expect(msg.message.content).toHaveLength(1);
      expect(msg.message.content[0].text).toBe('msg kept');
    });

    it('keeps tool_result blocks that do not reference skipped IDs', async () => {
      const src = await writeJsonl('src.jsonl', [
        // Pre-compaction: assistant with tool_use
        { type: 'assistant', content: [
          { type: 'tool_use', id: 'tu_skip', name: 'Read', input: { file_path: '/a.ts' } },
        ] },
        // Compaction boundary
        { type: 'summary', summary: 'compacted' },
        // Post-compaction: assistant with a new tool_use
        { type: 'assistant', content: [
          { type: 'tool_use', id: 'tu_keep', name: 'Read', input: { file_path: '/b.ts' } },
        ] },
        // Post-compaction: tool_result referencing the kept tool_use
        { type: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_keep', content: 'valid result' },
        ] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      // summary + assistant + user = 3
      expect(output).toHaveLength(3);
      // The tool_result for tu_keep should be preserved
      const userContent = output[2].content;
      expect(userContent).toHaveLength(1);
      expect(userContent[0].tool_use_id).toBe('tu_keep');
      expect(userContent[0].content).toBe('valid result');
    });
  });

  describe('conversation preservation', () => {
    it('preserves all user and assistant text verbatim', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'explain auth module' },
        { type: 'assistant', content: [{ type: 'text', text: 'The auth module uses JWT with refresh tokens.' }] },
        { type: 'user', content: 'what about the API?' },
        { type: 'assistant', content: [{ type: 'text', text: 'The API uses Express with middleware.' }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(output[0].content).toBe('explain auth module');
      expect(output[1].content[0].text).toBe('The auth module uses JWT with refresh tokens.');
      expect(output[2].content).toBe('what about the API?');
      expect(output[3].content[0].text).toBe('The API uses Express with middleware.');
    });
  });

  describe('keepLast option', () => {
    it('leaves entries within the last N fully unmodified even when over threshold', async () => {
      const bigResult = 'x'.repeat(600);
      const bigWriteContent = 'y'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        // Older entries — should be stubbed
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigResult }] },
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't2', name: 'Write',
          input: { file_path: '/a/b.ts', content: bigWriteContent }
        }] },
        // Trailing entries — within keepLast=2 window, should be untouched
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't3', content: bigResult }] },
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't4', name: 'Write',
          input: { file_path: '/c/d.ts', content: bigWriteContent }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest, { keepLast: 2 });
      const output = await readJsonl(dest);

      // First two were outside keepLast window — content stubbed.
      expect(output[0].content[0].content).toContain('[Trimmed tool result');
      expect(output[1].content[0].input.content).toContain('[Trimmed input');
      // Last two were inside keepLast window — untouched.
      expect(output[2].content[0].content).toBe(bigResult);
      expect(output[3].content[0].input.content).toBe(bigWriteContent);
    });

    it('skips thinking removal and image stripping for entries in keepLast window', async () => {
      const src = await writeJsonl('src.jsonl', [
        // Older entry — content processing applies.
        { type: 'assistant', content: [
          { type: 'thinking', thinking: 'old reasoning', signature: 'sig-old' },
          { type: 'text', text: 'old response' },
        ] },
        // Trailing entry — within keepLast=1, should be untouched.
        { type: 'assistant', content: [
          { type: 'thinking', thinking: 'recent reasoning', signature: 'sig-new' },
          { type: 'tool_result', tool_use_id: 't1', content: [
            { type: 'image', source: { type: 'base64', data: 'AAAA'.repeat(400) } },
            { type: 'text', text: 'recent result' },
          ] },
        ] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 1 });
      const output = await readJsonl(dest);

      // Older entry: thinking stripped.
      expect(metrics.signaturesStripped).toBe(1);
      expect(output[0].content.some((b: any) => b.type === 'thinking')).toBe(false);

      // Recent entry: thinking block kept, image kept.
      const recent = output[1].content;
      expect(recent.some((b: any) => b.type === 'thinking')).toBe(true);
      const toolResult = recent.find((b: any) => b.type === 'tool_result');
      expect(toolResult.content.some((c: any) => c.type === 'image')).toBe(true);
      // Metric does not reflect the preserved image.
      expect(metrics.imagesStripped).toBe(0);
    });

    it('preserves usage metadata on entries within the keepLast window', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'old' }], usage: { input_tokens: 10 } } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'recent' }], usage: { input_tokens: 99 } } },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      await trimJsonl(src, dest, { keepLast: 1 });
      const output = await readJsonl(dest);

      // Older entry: usage stripped.
      expect(output[0].message.usage).toBeUndefined();
      // Recent entry: usage kept.
      expect(output[1].message.usage).toEqual({ input_tokens: 99 });
    });

    it('keepLast=0 disables the feature (fully stubs like before)', async () => {
      const bigContent = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 0 });
      const output = await readJsonl(dest);

      expect(metrics.toolResultsStubbed).toBe(1);
      expect(output[0].content[0].content).toContain('[Trimmed tool result');
    });

    it('keepLast larger than entry count leaves everything untouched', async () => {
      const bigContent = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't2', content: bigContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 100 });
      const output = await readJsonl(dest);

      expect(metrics.toolResultsStubbed).toBe(0);
      expect(output[0].content[0].content).toBe(bigContent);
      expect(output[1].content[0].content).toBe(bigContent);
    });

    it('structural skipping still applies to entries in the keepLast window', async () => {
      // file-history-snapshot and queue-operation entries should be removed
      // regardless of recency — they are dead weight.
      const bigContent = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'user', content: 'old' },
        { type: 'file-history-snapshot', data: { files: ['a.ts'] } },
        { type: 'queue-operation', op: 'flush' },
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 10 });
      const output = await readJsonl(dest);

      expect(metrics.fileHistoryRemoved).toBe(1);
      expect(metrics.queueOperationsRemoved).toBe(1);
      // Remaining entries kept, content preserved (inside keepLast window).
      expect(output).toHaveLength(2);
      expect(output[1].content[0].content).toBe(bigContent);
    });

    it('still strips orphaned tool_result blocks in the keepLast window', async () => {
      // A tool_result whose matching tool_use was skipped by pre-compaction
      // leaves the file structurally invalid for API replay. This must be
      // stripped regardless of recency, even when the orphan lands inside
      // the keepLast window.
      const src = await writeJsonl('src.jsonl', [
        // Pre-compaction: tool_use that will be skipped.
        { type: 'assistant', content: [
          { type: 'tool_use', id: 'tu_orphan', name: 'Read', input: { file_path: '/a.ts' } },
        ] },
        // Compaction boundary.
        { type: 'summary', summary: 'compacted' },
        // Post-compaction: a recent entry (inside keepLast window) with
        // an orphaned tool_result referencing the pre-compaction tool_use.
        { type: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_orphan', content: 'orphan result' },
          { type: 'text', text: 'real user text' },
        ] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      // keepLast=10 puts the post-compaction user entry inside the window.
      await trimJsonl(src, dest, { keepLast: 10 });
      const output = await readJsonl(dest);

      // summary + user = 2
      expect(output).toHaveLength(2);
      // The orphaned tool_result was stripped even though the entry was
      // inside the keepLast window.
      const userContent = output[1].content;
      expect(userContent).toHaveLength(1);
      expect(userContent[0].type).toBe('text');
      expect(userContent[0].text).toBe('real user text');
    });

    it('counts tool_use requests for entries in the keepLast window', async () => {
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b.ts' } },
        ] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest, { keepLast: 10 });

      expect(metrics.toolUseRequests).toBe(2);
    });

    it('default keepLast preserves recent entries in a typical small session', async () => {
      // Small synthetic session: with the default keepLast (20), everything
      // ends up in the window and nothing is stubbed. This documents the
      // default behaviour.
      const bigContent = 'x'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.toolResultsStubbed).toBe(0);
      expect(output[0].content[0].content).toBe(bigContent);
    });
  });
});

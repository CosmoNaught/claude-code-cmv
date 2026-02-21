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
  await fs.rm(tmpDir, { recursive: true, force: true });
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

      const metrics = await trimJsonl(src, dest);
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

      const metrics = await trimJsonl(src, dest);
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

      const metrics = await trimJsonl(src, dest);
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

      const metrics = await trimJsonl(src, dest);
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

      const metrics = await trimJsonl(src, dest);
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

      const metrics = await trimJsonl(src, dest);
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

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.toolUseInputsStubbed).toBe(1);
      const input = output[0].content[0].input;
      expect(input.file_path).toBe('/a/b.ts');
      expect(input.old_string).toContain('[Trimmed input');
      expect(input.new_string).toContain('[Trimmed input');
    });

    it('preserves identification fields in broad fallback', async () => {
      const bigPrompt = 'z'.repeat(600);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{
          type: 'tool_use', id: 't1', name: 'Task',
          input: { description: 'do stuff', prompt: bigPrompt }
        }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      const metrics = await trimJsonl(src, dest);
      const output = await readJsonl(dest);

      expect(metrics.toolUseInputsStubbed).toBe(1);
      const input = output[0].content[0].input;
      expect(input.description).toBe('do stuff');
      expect(input.prompt).toContain('[Trimmed input');
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

      await trimJsonl(src, dest);
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
      const m1 = await trimJsonl(src, dest);
      expect(m1.toolResultsStubbed).toBe(0);

      // Threshold 200 should stub
      const m2 = await trimJsonl(src, dest, { threshold: 200 });
      expect(m2.toolResultsStubbed).toBe(1);
    });

    it('enforces minimum threshold of 50', async () => {
      const content = 'x'.repeat(60);
      const src = await writeJsonl('src.jsonl', [
        { type: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      ]);
      const dest = path.join(tmpDir, 'dest.jsonl');

      // threshold=10 should be clamped to 50, so 60 chars gets stubbed
      const metrics = await trimJsonl(src, dest, { threshold: 10 });
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

      const metrics = await trimJsonl(src, dest);

      expect(metrics.originalBytes).toBeGreaterThan(0);
      expect(metrics.trimmedBytes).toBeGreaterThan(0);
      expect(metrics.trimmedBytes).toBeLessThan(metrics.originalBytes);
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
});

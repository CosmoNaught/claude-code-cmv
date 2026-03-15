// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionWatcher } from '../src/core/session-watcher.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
});

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

async function writeJsonl(filePath: string, lines: unknown[]): Promise<void> {
  await fs.writeFile(filePath, lines.map(o => JSON.stringify(o)).join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('SessionWatcher constructor', () => {
  it('sets default maxMessages to 200', async () => {
    const jsonlPath = path.join(tmpDir, 'empty.jsonl');
    await fs.writeFile(jsonlPath, '');
    const watcher = new SessionWatcher(jsonlPath);
    // maxMessages is private; exercise it by writing 201 messages and checking only 200 remain
    const lines: unknown[] = [];
    for (let i = 0; i < 201; i++) {
      lines.push({ type: 'human', message: { content: `msg ${i}` } });
    }
    await fs.writeFile(jsonlPath, lines.map(o => JSON.stringify(o)).join('\n') + '\n');
    await watcher.start();
    expect(watcher.getMessages().length).toBe(200);
    watcher.stop();
  });

  it('accepts a custom maxMessages option', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    const msgs: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ type: 'human', message: { content: `msg ${i}` } });
    }
    await writeJsonl(jsonlPath, msgs);
    const watcher = new SessionWatcher(jsonlPath, { maxMessages: 7 });
    await watcher.start();
    expect(watcher.getMessages().length).toBe(7);
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// start() / stop() / getMessages()
// ---------------------------------------------------------------------------

describe('start() reads existing content and emits messages', () => {
  it('emits messages event after reading existing file', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(jsonlPath, [
      { type: 'human', message: { content: 'Hello' } },
    ]);

    const watcher = new SessionWatcher(jsonlPath);
    const emitted: unknown[] = [];
    watcher.on('messages', (msgs) => emitted.push(msgs));

    await watcher.start();
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    watcher.stop();
  });

  it('does not emit messages event when file is empty', async () => {
    const jsonlPath = path.join(tmpDir, 'empty.jsonl');
    await fs.writeFile(jsonlPath, '');

    const watcher = new SessionWatcher(jsonlPath);
    const emitted: unknown[] = [];
    watcher.on('messages', (msgs) => emitted.push(msgs));

    await watcher.start();
    expect(emitted.length).toBe(0);
    watcher.stop();
  });

  it('does not throw when file does not exist (retry path)', async () => {
    const jsonlPath = path.join(tmpDir, 'nonexistent.jsonl');
    const watcher = new SessionWatcher(jsonlPath);
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.getMessages()).toEqual([]);
    watcher.stop();
  });
});

describe('stop() cleans up watcher and debounce timer', () => {
  it('can be called multiple times without throwing', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await fs.writeFile(jsonlPath, '');
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
  });

  it('clears pending debounce timer on stop', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(jsonlPath, [
      { type: 'human', message: { content: 'initial' } },
    ]);

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    // Trigger a change to create a pending debounce timer, then stop immediately
    await fs.appendFile(jsonlPath, line({ type: 'human', message: { content: 'appended' } }));
    watcher.stop(); // should cancel debounce without throwing

    // Give a brief window to ensure no post-stop emissions occur
    await new Promise(r => setTimeout(r, 200));
    expect(watcher.getMessages().length).toBe(1); // only the initial message
  });
});

describe('getMessages()', () => {
  it('returns empty array before start', () => {
    const watcher = new SessionWatcher(path.join(tmpDir, 'x.jsonl'));
    expect(watcher.getMessages()).toEqual([]);
  });

  it('returns parsed messages after start', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(jsonlPath, [
      { type: 'human', message: { content: 'hi' } },
    ]);
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    expect(watcher.getMessages().length).toBe(1);
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// readNew() — appended content picked up via fs.watch
// ---------------------------------------------------------------------------

describe('readNew() picks up appended content', () => {
  it('detects new messages appended to the file', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(jsonlPath, [
      { type: 'human', message: { content: 'First' } },
    ]);

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    expect(watcher.getMessages().length).toBe(1);

    await fs.appendFile(
      jsonlPath,
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second' }] } }),
    );

    await new Promise(r => setTimeout(r, 300));

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.text).toBe('Second');
    watcher.stop();
  });

  it('does not emit messages when appended data contains no parseable messages', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(jsonlPath, [
      { type: 'human', message: { content: 'First' } },
    ]);

    const watcher = new SessionWatcher(jsonlPath);
    let emitCount = 0;
    watcher.on('messages', () => emitCount++);
    await watcher.start();
    const initialEmitCount = emitCount;

    // Append only skipped types
    await fs.appendFile(jsonlPath, line({ type: 'usage', tokens: 100 }));
    await new Promise(r => setTimeout(r, 300));

    // No new emit should have happened
    expect(emitCount).toBe(initialEmitCount);
    watcher.stop();
  });

  it('accumulates multiple appended batches correctly', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(jsonlPath, [
      { type: 'human', message: { content: 'msg0' } },
    ]);

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    await fs.appendFile(jsonlPath, line({ type: 'human', message: { content: 'msg1' } }));
    await new Promise(r => setTimeout(r, 300));

    await fs.appendFile(jsonlPath, line({ type: 'human', message: { content: 'msg2' } }));
    await new Promise(r => setTimeout(r, 300));

    expect(watcher.getMessages().length).toBe(3);
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// trimMessages()
// ---------------------------------------------------------------------------

describe('trimMessages() respects maxMessages limit', () => {
  it('keeps the last N messages when over the limit', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    const lines: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push({ type: 'human', message: { content: `Message ${i}` } });
    }
    await writeJsonl(jsonlPath, lines);

    const watcher = new SessionWatcher(jsonlPath, { maxMessages: 5 });
    await watcher.start();

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(5);
    expect(msgs[0]!.text).toBe('Message 5');
    expect(msgs[4]!.text).toBe('Message 9');
    watcher.stop();
  });

  it('does not trim when at exactly maxMessages', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    const lines: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ type: 'human', message: { content: `msg ${i}` } });
    }
    await writeJsonl(jsonlPath, lines);

    const watcher = new SessionWatcher(jsonlPath, { maxMessages: 5 });
    await watcher.start();
    expect(watcher.getMessages().length).toBe(5);
    watcher.stop();
  });

  it('trims messages added via readNew when limit is exceeded', async () => {
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    const initial: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      initial.push({ type: 'human', message: { content: `old ${i}` } });
    }
    await writeJsonl(jsonlPath, initial);

    const watcher = new SessionWatcher(jsonlPath, { maxMessages: 4 });
    await watcher.start();
    expect(watcher.getMessages().length).toBe(3);

    // Append 2 more — now total would be 5, should trim to 4
    await fs.appendFile(jsonlPath, line({ type: 'human', message: { content: 'new 0' } }));
    await fs.appendFile(jsonlPath, line({ type: 'human', message: { content: 'new 1' } }));
    await new Promise(r => setTimeout(r, 300));

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(4);
    expect(msgs[msgs.length - 1]!.text).toBe('new 1');
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// parseJsonMessage — all branches
// ---------------------------------------------------------------------------

describe('parseJsonMessage — skipped types', () => {
  async function parseSingle(obj: unknown): Promise<ReturnType<SessionWatcher['getMessages']>> {
    const jsonlPath = path.join(tmpDir, `parse-${Date.now()}-${Math.random()}.jsonl`);
    await writeJsonl(jsonlPath, [obj]);
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    watcher.stop();
    return msgs;
  }

  it('skips file-history-snapshot', async () => {
    expect(await parseSingle({ type: 'file-history-snapshot', data: {} })).toEqual([]);
  });

  it('skips queue-operation', async () => {
    expect(await parseSingle({ type: 'queue-operation', op: 'push' })).toEqual([]);
  });

  it('skips usage', async () => {
    expect(await parseSingle({ type: 'usage', tokens: 42 })).toEqual([]);
  });

  it('returns null for unknown type', async () => {
    expect(await parseSingle({ type: 'completely-unknown' })).toEqual([]);
  });
});

describe('parseJsonMessage — user messages', () => {
  async function parseSingle(obj: unknown) {
    const jsonlPath = path.join(tmpDir, `parse-${Date.now()}-${Math.random()}.jsonl`);
    await writeJsonl(jsonlPath, [obj]);
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    watcher.stop();
    return msgs;
  }

  it('parses type=human with string content', async () => {
    const msgs = await parseSingle({ type: 'human', message: { content: 'Hello world' } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'user', text: 'Hello world' });
  });

  it('parses type=user with string content', async () => {
    const msgs = await parseSingle({ type: 'user', content: 'direct user content' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'user', text: 'direct user content' });
  });

  it('parses role=user with string content', async () => {
    const msgs = await parseSingle({ role: 'user', content: 'role-based user' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'user', text: 'role-based user' });
  });

  it('parses user message with array content (text blocks)', async () => {
    const msgs = await parseSingle({
      type: 'human',
      message: {
        content: [
          { type: 'text', text: 'Part one' },
          { type: 'text', text: 'Part two' },
        ],
      },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'user', text: 'Part one\nPart two' });
  });

  it('parses user message with nested message.content string', async () => {
    // type=human, content at message.content level
    const msgs = await parseSingle({ type: 'human', message: { content: 'nested string' } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('nested string');
  });

  it('returns null for user message with array content but no text blocks', async () => {
    const msgs = await parseSingle({
      type: 'user',
      content: [{ type: 'image', source: {} }],
    });
    expect(msgs).toHaveLength(0);
  });

  it('returns null for user message with no parseable content (no string, no array)', async () => {
    const msgs = await parseSingle({ type: 'user', content: null });
    expect(msgs).toHaveLength(0);
  });

  it('returns null for type=human with neither string nor array message.content', async () => {
    const msgs = await parseSingle({ type: 'human', message: { content: 42 } });
    expect(msgs).toHaveLength(0);
  });
});

describe('parseJsonMessage — assistant messages', () => {
  async function parseSingle(obj: unknown) {
    const jsonlPath = path.join(tmpDir, `parse-${Date.now()}-${Math.random()}.jsonl`);
    await writeJsonl(jsonlPath, [obj]);
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    watcher.stop();
    return msgs;
  }

  it('parses type=assistant with string content', async () => {
    const msgs = await parseSingle({ type: 'assistant', content: 'Simple response' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'assistant', text: 'Simple response' });
  });

  it('parses role=assistant with string content', async () => {
    const msgs = await parseSingle({ role: 'assistant', content: 'role-based assistant' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'assistant', text: 'role-based assistant' });
  });

  it('parses assistant with array content containing only text blocks', async () => {
    const msgs = await parseSingle({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Line one' },
          { type: 'text', text: 'Line two' },
        ],
      },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('Line one\nLine two');
  });

  it('parses assistant with array content including tool_use blocks', async () => {
    const msgs = await parseSingle({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('Let me check.\nTool: Read');
  });

  it('parses assistant with only tool_use blocks (no text)', async () => {
    const msgs = await parseSingle({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: {} },
        ],
      },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('Tool: Write');
  });

  it('returns null for assistant with empty array content', async () => {
    const msgs = await parseSingle({
      type: 'assistant',
      message: { content: [] },
    });
    expect(msgs).toHaveLength(0);
  });

  it('returns null for assistant with array content containing only unknown blocks', async () => {
    const msgs = await parseSingle({
      type: 'assistant',
      message: {
        content: [{ type: 'image', source: {} }],
      },
    });
    expect(msgs).toHaveLength(0);
  });

  it('returns null for assistant with no content field', async () => {
    const msgs = await parseSingle({ type: 'assistant' });
    expect(msgs).toHaveLength(0);
  });
});

describe('parseJsonMessage — tool_result messages', () => {
  async function parseSingle(obj: unknown) {
    const jsonlPath = path.join(tmpDir, `parse-${Date.now()}-${Math.random()}.jsonl`);
    await writeJsonl(jsonlPath, [obj]);
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    watcher.stop();
    return msgs;
  }

  it('parses tool_result with short string content', async () => {
    const msgs = await parseSingle({ type: 'tool_result', content: 'x'.repeat(500) });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'tool-result', text: '[result: 500 chars]' });
  });

  it('parses tool_result with long string content (>1000 chars)', async () => {
    const msgs = await parseSingle({ type: 'tool_result', content: 'x'.repeat(2500) });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'tool-result', text: '[result: 3k chars]' });
  });

  it('parses tool_result with exactly 1000 chars (boundary — not abbreviated)', async () => {
    const msgs = await parseSingle({ type: 'tool_result', content: 'x'.repeat(1000) });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('[result: 1000 chars]');
  });

  it('parses tool_result with exactly 1001 chars (boundary — abbreviated)', async () => {
    const msgs = await parseSingle({ type: 'tool_result', content: 'x'.repeat(1001) });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('[result: 1k chars]');
  });

  it('parses tool_result with array content (text blocks)', async () => {
    const msgs = await parseSingle({
      type: 'tool_result',
      content: [
        { type: 'text', text: 'a'.repeat(300) },
        { type: 'text', text: 'b'.repeat(200) },
      ],
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'tool-result', text: '[result: 500 chars]' });
  });

  it('parses tool_result with large array content (>1000 total chars)', async () => {
    const msgs = await parseSingle({
      type: 'tool_result',
      content: [
        { type: 'text', text: 'z'.repeat(2000) },
      ],
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('[result: 2k chars]');
  });

  it('parses tool_result array ignoring non-text blocks in total length', async () => {
    const msgs = await parseSingle({
      type: 'tool_result',
      content: [
        { type: 'text', text: 'a'.repeat(100) },
        { type: 'image', source: {} },
      ],
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'tool-result', text: '[result: 100 chars]' });
  });

  it('returns null for tool_result with no content field', async () => {
    const msgs = await parseSingle({ type: 'tool_result' });
    expect(msgs).toHaveLength(0);
  });

  it('returns null for tool_result with non-string non-array content', async () => {
    const msgs = await parseSingle({ type: 'tool_result', content: 42 });
    expect(msgs).toHaveLength(0);
  });
});

describe('parseJsonMessage — system and summary types', () => {
  async function parseSingle(obj: unknown) {
    const jsonlPath = path.join(tmpDir, `parse-${Date.now()}-${Math.random()}.jsonl`);
    await writeJsonl(jsonlPath, [obj]);
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    watcher.stop();
    return msgs;
  }

  it('parses type=system as system message', async () => {
    const msgs = await parseSingle({ type: 'system', content: 'some system data' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'system', text: '[system]' });
  });

  it('parses type=summary as system message', async () => {
    const msgs = await parseSingle({ type: 'summary', summary: 'conversation summary' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'system', text: '[system]' });
  });
});

// ---------------------------------------------------------------------------
// parseLine edge cases
// ---------------------------------------------------------------------------

describe('parseLine edge cases', () => {
  it('skips empty lines', async () => {
    const jsonlPath = path.join(tmpDir, 'blanks.jsonl');
    // Write a file with blank lines between valid lines
    const content = [
      '',
      JSON.stringify({ type: 'human', message: { content: 'hello' } }),
      '   ',
      JSON.stringify({ type: 'system' }),
      '',
    ].join('\n');
    await fs.writeFile(jsonlPath, content);

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.type).toBe('user');
    expect(msgs[1]!.type).toBe('system');
    watcher.stop();
  });

  it('skips lines with invalid JSON', async () => {
    const jsonlPath = path.join(tmpDir, 'invalid.jsonl');
    const content = [
      'not json at all',
      JSON.stringify({ type: 'human', message: { content: 'valid' } }),
      '{broken json',
    ].join('\n');
    await fs.writeFile(jsonlPath, content);

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe('valid');
    watcher.stop();
  });

  it('handles a mix of valid, invalid, and skipped lines', async () => {
    const jsonlPath = path.join(tmpDir, 'mixed.jsonl');
    const lines = [
      JSON.stringify({ type: 'file-history-snapshot' }),
      'bad json}',
      '',
      JSON.stringify({ type: 'human', message: { content: 'msg1' } }),
      JSON.stringify({ type: 'usage', tokens: 10 }),
      JSON.stringify({ type: 'assistant', content: 'reply' }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n'));

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.type).toBe('user');
    expect(msgs[1]!.type).toBe('assistant');
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// Retry path (file does not exist at start)
// ---------------------------------------------------------------------------

describe('retry path when file does not exist', () => {
  it('starts without throwing and has empty messages', async () => {
    const jsonlPath = path.join(tmpDir, 'will-not-exist.jsonl');
    const watcher = new SessionWatcher(jsonlPath);
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.getMessages()).toEqual([]);
    watcher.stop();
  });

  it('stops cleanly even when watcher was never established', async () => {
    const jsonlPath = path.join(tmpDir, 'also-missing.jsonl');
    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    expect(() => watcher.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Full integration: human / assistant / tool pipeline
// ---------------------------------------------------------------------------

describe('full pipeline integration', () => {
  it('reads a realistic Claude session JSONL', async () => {
    const jsonlPath = path.join(tmpDir, 'realistic.jsonl');
    const lines = [
      // system bootstrap
      { type: 'system', cwd: '/home/user/project' },
      // user turn
      { type: 'human', message: { role: 'user', content: 'Please read foo.ts' } },
      // assistant with tool_use
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, reading the file now.' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'foo.ts' } },
          ],
        },
      },
      // tool result
      { type: 'tool_result', content: 'export function foo() {}' },
      // assistant follow-up
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] } },
      // skipped
      { type: 'usage', input_tokens: 100, output_tokens: 50 },
    ];

    await writeJsonl(jsonlPath, lines);

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();
    const msgs = watcher.getMessages();

    expect(msgs.length).toBe(5);
    expect(msgs[0]).toEqual({ type: 'system', text: '[system]' });
    expect(msgs[1]).toEqual({ type: 'user', text: 'Please read foo.ts' });
    expect(msgs[2]!.type).toBe('assistant');
    expect(msgs[2]!.text).toContain('Sure, reading the file now.');
    expect(msgs[2]!.text).toContain('Tool: Read');
    expect(msgs[3]!.type).toBe('tool-result');
    expect(msgs[3]!.text).toMatch(/\[result: \d+ chars\]/);
    expect(msgs[4]).toEqual({ type: 'assistant', text: 'Done!' });

    watcher.stop();
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionWatcher } from '../src/core/session-watcher.js';

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe('session-watcher', () => {
  it('reads existing messages from a JSONL file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');

    const lines = [
      JSON.stringify({ type: 'human', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] } }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.type).toBe('user');
    expect(msgs[0]!.text).toBe('Hello');
    expect(msgs[1]!.type).toBe('assistant');
    expect(msgs[1]!.text).toBe('Hi there');

    watcher.stop();
  });

  it('skips non-conversation types', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');

    const lines = [
      JSON.stringify({ type: 'file-history-snapshot', data: {} }),
      JSON.stringify({ type: 'queue-operation', data: {} }),
      JSON.stringify({ type: 'usage', data: {} }),
      JSON.stringify({ type: 'human', message: { role: 'user', content: 'Test' } }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe('Test');

    watcher.stop();
  });

  it('parses tool_use in assistant messages', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');

    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
          ],
        },
      }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain('Let me read that file.');
    expect(msgs[0]!.text).toContain('Tool: Read');

    watcher.stop();
  });

  it('parses tool_result with char count', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');

    const lines = [
      JSON.stringify({ type: 'tool_result', content: 'x'.repeat(500) }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.type).toBe('tool-result');
    expect(msgs[0]!.text).toContain('500');

    watcher.stop();
  });

  it('detects new messages appended to the file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');

    await fs.writeFile(jsonlPath, JSON.stringify({ type: 'human', message: { role: 'user', content: 'First' } }) + '\n');

    const watcher = new SessionWatcher(jsonlPath);
    await watcher.start();

    expect(watcher.getMessages().length).toBe(1);

    // Append a new message
    await fs.appendFile(jsonlPath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] } }) + '\n');

    // Wait for fs.watch to fire + debounce
    await new Promise(r => setTimeout(r, 300));

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.text).toBe('Second');

    watcher.stop();
  });

  it('respects maxMessages limit', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-watcher-test-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');

    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ type: 'human', message: { role: 'user', content: `Message ${i}` } }));
    }
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    const watcher = new SessionWatcher(jsonlPath, { maxMessages: 5 });
    await watcher.start();

    const msgs = watcher.getMessages();
    expect(msgs.length).toBe(5);
    // Should keep the latest messages
    expect(msgs[0]!.text).toBe('Message 5');
    expect(msgs[4]!.text).toBe('Message 9');

    watcher.stop();
  });
});

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as readline from 'node:readline';

export interface WatchedMessage {
  type: 'user' | 'assistant' | 'tool-use' | 'tool-result' | 'system' | 'other';
  text: string;
}

export class SessionWatcher extends EventEmitter {
  private jsonlPath: string;
  private maxMessages: number;
  private messages: WatchedMessage[] = [];
  private bytesRead: number = 0;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(jsonlPath: string, options?: { maxMessages?: number }) {
    super();
    this.jsonlPath = jsonlPath;
    this.maxMessages = options?.maxMessages ?? 200;
  }

  async start(): Promise<void> {
    // Read existing content
    await this.readExisting();

    // Watch for changes
    try {
      this.watcher = fs.watch(this.jsonlPath, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.readNew(), 100);
      });
    } catch {
      // File might not exist yet, retry periodically
      const retryInterval = setInterval(async () => {
        try {
          await fsPromises.access(this.jsonlPath);
          clearInterval(retryInterval);
          this.watcher = fs.watch(this.jsonlPath, () => {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => this.readNew(), 100);
          });
        } catch {
          // Still waiting
        }
      }, 1000);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getMessages(): WatchedMessage[] {
    return this.messages;
  }

  private async readExisting(): Promise<void> {
    try {
      const stat = await fsPromises.stat(this.jsonlPath);
      if (stat.size === 0) return;

      const stream = fs.createReadStream(this.jsonlPath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const msg = this.parseLine(line);
        if (msg) this.messages.push(msg);
      }

      this.bytesRead = stat.size;
      this.trimMessages();
      this.emit('messages', this.messages);
    } catch {
      // File might not exist yet
    }
  }

  private async readNew(): Promise<void> {
    try {
      const stat = await fsPromises.stat(this.jsonlPath);
      if (stat.size <= this.bytesRead) return;

      const stream = fs.createReadStream(this.jsonlPath, {
        encoding: 'utf-8',
        start: this.bytesRead,
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let newMessages = false;
      for await (const line of rl) {
        const msg = this.parseLine(line);
        if (msg) {
          this.messages.push(msg);
          newMessages = true;
        }
      }

      this.bytesRead = stat.size;
      if (newMessages) {
        this.trimMessages();
        this.emit('messages', this.messages);
      }
    } catch {
      // Read error, will retry on next change
    }
  }

  private trimMessages(): void {
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  private parseLine(line: string): WatchedMessage | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed);
      return this.parseJsonMessage(parsed);
    } catch {
      return null;
    }
  }

  private parseJsonMessage(parsed: Record<string, unknown>): WatchedMessage | null {
    // Skip non-conversation types
    if (parsed.type === 'file-history-snapshot' ||
        parsed.type === 'queue-operation' ||
        parsed.type === 'usage') {
      return null;
    }

    // User message
    if (parsed.type === 'human' || parsed.type === 'user' || parsed.role === 'user') {
      const message = (parsed.message as Record<string, unknown>) || parsed;
      const content = message.content;
      if (typeof content === 'string') {
        return { type: 'user', text: content };
      }
      if (Array.isArray(content)) {
        const textParts = content
          .filter((b: Record<string, unknown>) => b.type === 'text')
          .map((b: Record<string, unknown>) => b.text as string);
        if (textParts.length > 0) {
          return { type: 'user', text: textParts.join('\n') };
        }
      }
      return null;
    }

    // Assistant message
    if (parsed.type === 'assistant' || parsed.role === 'assistant') {
      const message = (parsed.message as Record<string, unknown>) || parsed;
      const content = message.content;
      if (typeof content === 'string') {
        return { type: 'assistant', text: content };
      }
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text);
          } else if (b.type === 'tool_use') {
            parts.push(`Tool: ${b.name as string}`);
          }
        }
        if (parts.length > 0) {
          return { type: 'assistant', text: parts.join('\n') };
        }
      }
      return null;
    }

    // Tool result
    if (parsed.type === 'tool_result') {
      const content = parsed.content;
      if (typeof content === 'string') {
        const len = content.length;
        return { type: 'tool-result', text: `[result: ${len > 1000 ? Math.round(len / 1000) + 'k' : len} chars]` };
      }
      if (Array.isArray(content)) {
        const totalLen = (content as Array<Record<string, unknown>>)
          .filter(b => b.type === 'text')
          .reduce((sum, b) => sum + ((b.text as string) || '').length, 0);
        return { type: 'tool-result', text: `[result: ${totalLen > 1000 ? Math.round(totalLen / 1000) + 'k' : totalLen} chars]` };
      }
      return null;
    }

    // System / summary
    if (parsed.type === 'system' || parsed.type === 'summary') {
      return { type: 'system', text: '[system]' };
    }

    return null;
  }
}

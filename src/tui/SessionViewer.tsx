import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { SessionWatcher, type WatchedMessage } from '../core/session-watcher.js';

interface SessionViewerProps {
  sessionId: string;
  branchName: string;
  snapshotName: string;
  jsonlPath: string;
  width: number;
  height: number;
}

function truncateText(text: string, maxWidth: number, maxLines: number): string {
  const lines = text.split('\n');
  const truncatedLines = lines.slice(0, maxLines).map(line => {
    if (line.length > maxWidth - 4) {
      return line.substring(0, maxWidth - 7) + '...';
    }
    return line;
  });
  if (lines.length > maxLines) {
    truncatedLines.push(`  ... (${lines.length - maxLines} more lines)`);
  }
  return truncatedLines.join('\n');
}

function MessageRow({ msg, maxWidth }: { msg: WatchedMessage; maxWidth: number }) {
  const maxLines = 6;

  switch (msg.type) {
    case 'user':
      return (
        <Box flexDirection="column">
          <Text color="yellow" bold>You:</Text>
          <Text color="yellow">{truncateText(msg.text, maxWidth, maxLines)}</Text>
          <Text> </Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Text color="white" bold>Claude:</Text>
          <Text>{truncateText(msg.text, maxWidth, maxLines)}</Text>
          <Text> </Text>
        </Box>
      );
    case 'tool-use':
      return (
        <Box>
          <Text color="cyan" dimColor>  {msg.text}</Text>
        </Box>
      );
    case 'tool-result':
      return (
        <Box>
          <Text dimColor>  {msg.text}</Text>
        </Box>
      );
    case 'system':
      return (
        <Box>
          <Text dimColor italic>{msg.text}</Text>
        </Box>
      );
    default:
      return null;
  }
}

export function SessionViewer({ sessionId, branchName, snapshotName, jsonlPath, width, height }: SessionViewerProps) {
  const [messages, setMessages] = useState<WatchedMessage[]>([]);
  const watcherRef = useRef<SessionWatcher | null>(null);

  useEffect(() => {
    const watcher = new SessionWatcher(jsonlPath, { maxMessages: 200 });
    watcherRef.current = watcher;

    watcher.on('messages', (msgs: WatchedMessage[]) => {
      setMessages([...msgs]);
    });

    watcher.start();

    return () => {
      watcher.stop();
      watcherRef.current = null;
    };
  }, [jsonlPath]);

  const maxWidth = width - 6;
  const headerHeight = 3;
  const availableHeight = height - headerHeight - 2;

  // Show last N messages that fit in available height
  // Estimate ~3 lines per message on average
  const maxVisible = Math.max(5, Math.floor(availableHeight / 3));
  const visibleMessages = messages.slice(-maxVisible);

  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="cyan">
      <Box paddingX={1}>
        <Text bold color="cyan"> "{branchName}" </Text>
        <Text dimColor>(from: {snapshotName})</Text>
        <Text color="green"> Watching</Text>
      </Box>
      <Box flexDirection="column" paddingX={2} height={availableHeight} overflow="hidden">
        {messages.length === 0 ? (
          <Box flexDirection="column" justifyContent="center" alignItems="center" flexGrow={1}>
            <Text dimColor>Waiting for Claude...</Text>
            <Text dimColor>Start a session:</Text>
            <Text color="cyan">claude --resume {sessionId.substring(0, 12)}...</Text>
          </Box>
        ) : (
          visibleMessages.map((msg, i) => (
            <MessageRow key={i} msg={msg} maxWidth={maxWidth} />
          ))
        )}
      </Box>
    </Box>
  );
}

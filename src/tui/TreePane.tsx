import React from 'react';
import { Box, Text } from 'ink';
import type { FlatNode } from './hooks/useTreeNavigation.js';
import type { ClaudeSessionEntry } from '../types/index.js';
import { formatRelativeTime, truncate } from '../utils/display.js';

interface TreePaneProps {
  flatNodes: FlatNode[];
  selectedIndex: number;
  focused: boolean;
  height: number;
  width: number;
  projectName?: string;
  sessions?: (ClaudeSessionEntry & { _projectDir: string })[];
}

function getStatusIcon(node: { type: string; branch?: { forked_session_id: string } }, sessions?: (ClaudeSessionEntry & { _projectDir: string })[]): string {
  if (!sessions) return '';
  let session: ClaudeSessionEntry | undefined;

  if (node.type === 'branch' && node.branch) {
    session = sessions.find(s => s.sessionId === node.branch!.forked_session_id);
  }

  if (!session?.modified) return '';

  const modifiedMs = new Date(session.modified).getTime();
  const twoMinAgo = Date.now() - 2 * 60 * 1000;
  return modifiedMs > twoMinAgo ? '● ' : '○ ';
}

function SeparatorRow({ name, maxWidth }: { name: string; maxWidth: number }) {
  const pad = Math.max(0, maxWidth - name.length - 4);
  const line = '─'.repeat(Math.floor(pad / 2));
  return (
    <Box>
      <Text dimColor> {line} {name} {line}{pad % 2 === 1 ? '─' : ''}</Text>
    </Box>
  );
}

function SessionRow({ flatNode, selected, focused, maxWidth }: { flatNode: FlatNode; selected: boolean; focused: boolean; maxWidth: number }) {
  const session = flatNode.node.session!;
  const idShort = session.sessionId.substring(0, 10) + '…';
  const msgs = session.messageCount ? `${session.messageCount}m` : '';
  const modified = session.modified ? formatRelativeTime(session.modified) : '';
  const summary = truncate(session.summary || session.firstPrompt || '', Math.max(0, maxWidth - idShort.length - msgs.length - modified.length - 8));

  if (selected && focused) {
    const content = `  ${idShort}  ${msgs.padStart(4)}  ${modified.padStart(7)}`;
    return (
      <Box>
        <Text inverse>
          {content}{' '.repeat(Math.max(0, maxWidth - content.length))}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>  </Text>
      <Text color="green">{idShort}</Text>
      <Text dimColor>  {msgs.padStart(4)}  {modified.padStart(7)}</Text>
      {summary && <Text dimColor>  {summary}</Text>}
    </Box>
  );
}

function SnapshotRow({ flatNode, selected, focused, maxWidth, sessions }: { flatNode: FlatNode; selected: boolean; focused: boolean; maxWidth: number; sessions?: (ClaudeSessionEntry & { _projectDir: string })[] }) {
  const { node, depth, isLast, hasChildren, isCollapsed, parentPrefixes } = flatNode;

  // Build prefix with tree-line characters
  let prefix = '';
  for (let i = 0; i < parentPrefixes.length; i++) {
    prefix += parentPrefixes[i] ? '    ' : '│   ';
  }

  if (depth > 0) {
    prefix += isLast ? '└── ' : '├── ';
  }

  // Collapse indicator for root snapshots
  let indicator = '  ';
  if (depth === 0 && node.type === 'snapshot') {
    indicator = hasChildren ? (isCollapsed ? '▶ ' : '● ') : '● ';
  } else if (hasChildren) {
    indicator = isCollapsed ? '▶ ' : '▼ ';
  }

  // Format suffix based on type
  const statusIcon = getStatusIcon(node, sessions);
  let suffix = '';
  if (node.type === 'snapshot' && node.snapshot) {
    const msgs = node.snapshot.message_count;
    suffix = msgs ? ` ${msgs}m` : '';
  } else if (node.type === 'branch') {
    suffix = ` ${statusIcon}(br)`;
  }

  // Truncate name if needed
  const prefixLen = (depth === 0 ? indicator.length : 2 + prefix.length);
  const availableWidth = maxWidth - prefixLen - suffix.length;
  let displayName = node.name;
  if (displayName.length > availableWidth && availableWidth > 3) {
    displayName = displayName.slice(0, availableWidth - 1) + '…';
  }

  if (selected && focused) {
    const content = `${depth === 0 ? indicator : '  '}${prefix}${displayName}${suffix}`;
    return (
      <Box>
        <Text inverse>
          {content}{' '.repeat(Math.max(0, maxWidth - content.length))}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>{depth === 0 ? '' : '  '}</Text>
      {depth === 0 && <Text color="cyan">{indicator}</Text>}
      <Text dimColor>{prefix}</Text>
      {node.type === 'snapshot' ? (
        <Text color="cyan" bold>{displayName}</Text>
      ) : (
        <Text dimColor>{displayName}</Text>
      )}
      <Text dimColor>{suffix}</Text>
    </Box>
  );
}

export function TreePane({ flatNodes, selectedIndex, focused, height, width, projectName, sessions }: TreePaneProps) {
  const visibleCount = Math.max(1, height - 2);
  const halfWindow = Math.floor(visibleCount / 2);
  let startIndex = Math.max(0, selectedIndex - halfWindow);
  const endIndex = Math.min(flatNodes.length, startIndex + visibleCount);
  if (endIndex - startIndex < visibleCount) {
    startIndex = Math.max(0, endIndex - visibleCount);
  }

  const visibleNodes = flatNodes.slice(startIndex, endIndex);
  const maxWidth = width - 4;

  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor={focused ? 'cyan' : 'gray'}>
      <Box paddingX={1}>
        <Text bold> {projectName || 'Snapshots / Sessions'}</Text>
      </Box>
      {flatNodes.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>No snapshots or sessions</Text>
        </Box>
      ) : (
        visibleNodes.map((flatNode, i) => {
          const key = `${flatNode.node.type}:${flatNode.node.name}:${i}`;
          const isSelected = startIndex + i === selectedIndex;

          if (flatNode.node.type === 'separator') {
            return <SeparatorRow key={key} name={flatNode.node.name} maxWidth={maxWidth} />;
          }

          if (flatNode.node.type === 'session') {
            return <SessionRow key={key} flatNode={flatNode} selected={isSelected} focused={focused} maxWidth={maxWidth} />;
          }

          return <SnapshotRow key={key} flatNode={flatNode} selected={isSelected} focused={focused} maxWidth={maxWidth} sessions={sessions} />;
        })
      )}
    </Box>
  );
}

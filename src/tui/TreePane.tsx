import React from 'react';
import { Box, Text } from 'ink';
import type { FlatNode } from './hooks/useTreeNavigation.js';
import { formatRelativeTime, truncate } from '../utils/display.js';

interface TreePaneProps {
  flatNodes: FlatNode[];
  selectedIndex: number;
  focused: boolean;
  snapshotBoxHeight: number;
  sessionBoxHeight: number;
  width: number;
  projectName?: string;
  sessionStatuses?: Record<string, 'active' | 'busy' | 'idle'>;
}

type SessionStatus = 'active' | 'busy' | 'idle';

function getBranchStatus(node: { type: string; branch?: { forked_session_id: string } }, sessionStatuses?: Record<string, SessionStatus>): SessionStatus {
  if (node.type === 'branch' && node.branch && sessionStatuses) {
    return sessionStatuses[node.branch.forked_session_id] || 'idle';
  }
  return 'idle';
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

function SnapshotRow({ flatNode, selected, focused, maxWidth, sessionStatuses }: { flatNode: FlatNode; selected: boolean; focused: boolean; maxWidth: number; sessionStatuses?: Record<string, SessionStatus> }) {
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

  // Branch status
  const branchStatus = getBranchStatus(node, sessionStatuses);
  const branchDot = branchStatus === 'idle' ? '○' : '●';

  // Format suffix based on type
  let suffix = '';
  if (node.type === 'snapshot' && node.snapshot) {
    const msgs = node.snapshot.message_count;
    suffix = msgs ? ` ${msgs}m` : '';
  } else if (node.type === 'branch') {
    suffix = ` ${branchDot} (br)`;
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

  // Non-selected: render branch dot with status color
  const isBranch = node.type === 'branch';
  const dotColor = branchStatus === 'active' ? 'green' : branchStatus === 'busy' ? 'yellow' : undefined;

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
      {isBranch ? (
        <>
          <Text> </Text>
          <Text color={dotColor} dimColor={branchStatus === 'idle'}>{branchDot}</Text>
          <Text dimColor> (br)</Text>
        </>
      ) : (
        <Text dimColor>{suffix}</Text>
      )}
    </Box>
  );
}

function scrollWindow(items: FlatNode[], selectedOriginalIndex: number, visibleCount: number, flatNodes: FlatNode[]): { startIndex: number; endIndex: number } {
  // Find which item in this subset is selected
  const localIndex = items.findIndex(fn => flatNodes.indexOf(fn) === selectedOriginalIndex);
  if (localIndex < 0) {
    // Selection not in this pane, show from top
    return { startIndex: 0, endIndex: Math.min(items.length, visibleCount) };
  }
  const halfWindow = Math.floor(visibleCount / 2);
  let startIndex = Math.max(0, localIndex - halfWindow);
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  if (endIndex - startIndex < visibleCount) {
    startIndex = Math.max(0, endIndex - visibleCount);
  }
  return { startIndex, endIndex };
}

export function TreePane({ flatNodes, selectedIndex, focused, snapshotBoxHeight, sessionBoxHeight, width, sessionStatuses }: TreePaneProps) {
  const maxWidth = width - 4;

  // Split flatNodes into snapshot items and session items (skip separators)
  const sessionSepIdx = flatNodes.findIndex(fn => fn.node.type === 'separator' && fn.node.name === 'Sessions');
  const snapshotItems = flatNodes.filter((fn, i) => fn.node.type !== 'separator' && (sessionSepIdx < 0 || i < sessionSepIdx));
  const sessionItems = flatNodes.filter((fn, i) => fn.node.type !== 'separator' && sessionSepIdx >= 0 && i > sessionSepIdx);

  // Derive content heights from box heights (box = content + 2 border + 1 header)
  const snapshotContentHeight = snapshotBoxHeight - 3;
  const sessionContentHeight = sessionBoxHeight - 3;

  // Scroll windows (visible count = content height)
  const snapScroll = scrollWindow(snapshotItems, selectedIndex, snapshotContentHeight, flatNodes);
  const sessScroll = scrollWindow(sessionItems, selectedIndex, sessionContentHeight, flatNodes);

  const visibleSnapshots = snapshotItems.slice(snapScroll.startIndex, snapScroll.endIndex);
  const visibleSessions = sessionItems.slice(sessScroll.startIndex, sessScroll.endIndex);

  // Is selection in snapshots or sessions?
  const selInSnapshots = snapshotItems.some(fn => flatNodes.indexOf(fn) === selectedIndex);

  return (
    <Box flexDirection="column" width={width}>
      {/* Snapshots container */}
      <Box flexDirection="column" width={width} height={snapshotBoxHeight} borderStyle="single" borderColor={focused && selInSnapshots ? 'cyan' : 'gray'}>
        <Box paddingX={1}>
          <Text bold> Snapshots</Text>
          <Text dimColor> ({snapshotItems.length})</Text>
        </Box>
        {snapshotItems.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>No snapshots</Text>
          </Box>
        ) : (
          visibleSnapshots.map((flatNode, i) => {
            const originalIndex = flatNodes.indexOf(flatNode);
            const isSelected = originalIndex === selectedIndex;
            const key = `snap:${flatNode.node.type}:${flatNode.node.name}:${i}`;
            return <SnapshotRow key={key} flatNode={flatNode} selected={isSelected} focused={focused} maxWidth={maxWidth} sessionStatuses={sessionStatuses} />;
          })
        )}
      </Box>
      {/* Sessions container */}
      <Box flexDirection="column" width={width} height={sessionBoxHeight} borderStyle="single" borderColor={focused && !selInSnapshots ? 'cyan' : 'gray'}>
        <Box paddingX={1}>
          <Text bold> Sessions</Text>
          <Text dimColor> ({sessionItems.length})</Text>
        </Box>
        {sessionItems.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>No sessions</Text>
          </Box>
        ) : (
          visibleSessions.map((flatNode, i) => {
            const originalIndex = flatNodes.indexOf(flatNode);
            const isSelected = originalIndex === selectedIndex;
            const key = `sess:${flatNode.node.session?.sessionId}:${i}`;
            return <SessionRow key={key} flatNode={flatNode} selected={isSelected} focused={focused} maxWidth={maxWidth} />;
          })
        )}
      </Box>
    </Box>
  );
}

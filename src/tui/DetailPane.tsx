import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../types/index.js';
import { formatRelativeTime, truncate } from '../utils/display.js';
import { getSnapshotSize } from '../core/metadata-store.js';

interface DetailPaneProps {
  node: TreeNode | null;
  width: number;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={14}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

export function DetailPane({ node, width }: DetailPaneProps) {
  const [snapshotSize, setSnapshotSize] = useState<number | null>(null);

  useEffect(() => {
    if (node?.type !== 'snapshot' || !node.snapshot) {
      setSnapshotSize(null);
      return;
    }
    let cancelled = false;
    getSnapshotSize(node.snapshot).then(size => {
      if (!cancelled) setSnapshotSize(size);
    });
    return () => { cancelled = true; };
  }, [node]);

  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray">
      <Box paddingX={1}>
        <Text bold> Details</Text>
      </Box>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {!node && (
          <Text dimColor>Select a snapshot or session to see details.</Text>
        )}

        {node?.type === 'snapshot' && node.snapshot && (
          <>
            <DetailRow label="Name:" value={node.snapshot.name} />
            <DetailRow label="Created:" value={formatRelativeTime(node.snapshot.created_at)} />
            <DetailRow label="Source:" value={node.snapshot.source_session_id.substring(0, 12) + '…'} />
            <DetailRow label="Messages:" value={node.snapshot.message_count?.toString() ?? '—'} />
            <DetailRow label="Size:" value={snapshotSize !== null ? formatSize(snapshotSize) : '…'} />
            <DetailRow
              label="Tags:"
              value={node.snapshot.tags.length > 0 ? node.snapshot.tags.join(', ') : '—'}
            />
            <DetailRow
              label="Description:"
              value={node.snapshot.description || '—'}
            />
            <Text> </Text>
            <DetailRow label="Branches:" value={node.snapshot.branches.length.toString()} />
            <DetailRow label="Parent:" value={node.snapshot.parent_snapshot || '(root)'} />
          </>
        )}

        {node?.type === 'branch' && node.branch && (
          <>
            <DetailRow label="Name:" value={node.branch.name} />
            <DetailRow label="Type:" value="Branch" />
            <DetailRow label="Created:" value={formatRelativeTime(node.branch.created_at)} />
            <DetailRow label="Session:" value={node.branch.forked_session_id.substring(0, 12) + '…'} />
          </>
        )}

        {node?.type === 'session' && node.session && (
          <>
            <DetailRow label="Session ID:" value={node.session.sessionId} />
            <DetailRow label="Type:" value="Active Session" />
            {node.session.modified && (
              <DetailRow label="Modified:" value={formatRelativeTime(node.session.modified)} />
            )}
            {node.session.created && (
              <DetailRow label="Created:" value={formatRelativeTime(node.session.created)} />
            )}
            <DetailRow label="Messages:" value={node.session.messageCount?.toString() ?? '—'} />
            {node.session.projectPath && (
              <DetailRow label="Project:" value={truncate(node.session.projectPath, width - 18)} />
            )}
            {node.session.firstPrompt && (
              <>
                <Text> </Text>
                <DetailRow label="First prompt:" value={truncate(node.session.firstPrompt, width - 18)} />
              </>
            )}
            {node.session.summary && (
              <DetailRow label="Summary:" value={truncate(node.session.summary, width - 18)} />
            )}
            <Text> </Text>
            <Text dimColor>Press [s] to snapshot this session</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

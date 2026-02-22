import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import * as path from 'node:path';
import type { TreeNode, SessionAnalysis, ClaudeSessionEntry } from '../types/index.js';
import type { ProjectInfo } from './hooks/useProjects.js';
import { formatRelativeTime, truncate } from '../utils/display.js';
import { getSnapshotSize } from '../core/metadata-store.js';
import { analyzeSession } from '../core/analyzer.js';
import { getCmvSnapshotsDir } from '../utils/paths.js';

interface DetailPaneProps {
  node: TreeNode | null;
  width: number;
  height: number;
  sessions?: (ClaudeSessionEntry & { _projectDir: string })[];
  project?: ProjectInfo | null;
  focusPane?: 'projects' | 'tree';
  sessionStatuses?: Record<string, 'active' | 'busy' | 'idle'>;
}

interface ProjectStats {
  sessionCount: number;
  snapshotCount: number;
  branchCount: number;
  totalMessages: number;
  oldestActivity: string | null;
  newestActivity: string | null;
}

function countSnapshotsAndBranches(roots: TreeNode[]): { snapshots: number; branches: number } {
  let snapshots = 0;
  let branches = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'snapshot') {
      snapshots++;
      branches += node.snapshot?.branches.length ?? 0;
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return { snapshots, branches };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={15}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

function ContextAnalysis({ analysis, width }: { analysis: SessionAnalysis; width: number }) {
  const b = analysis.breakdown;
  const trimmableBytes = b.toolResults.bytes + b.thinkingSignatures.bytes + b.fileHistory.bytes;
  const trimmableTokens = Math.round(trimmableBytes / 4 / 1000);
  const tokensK = Math.round(analysis.estimatedTokens / 1000);
  const limitK = analysis.contextLimit / 1000;
  const overflows = tokensK > limitK;
  const overflowK = tokensK - limitK;
  const remainingK = Math.max(0, limitK - tokensK);

  // Build a simple bar
  const barWidth = Math.max(10, Math.min(20, width - 20));
  const filled = Math.round((Math.min(analysis.contextUsedPercent, 100) / 100) * barWidth);
  const bar = '█'.repeat(Math.min(filled, barWidth)) + '░'.repeat(Math.max(0, barWidth - filled));
  const barColor = overflows ? 'red' : analysis.contextUsedPercent > 80 ? 'red' : analysis.contextUsedPercent > 50 ? 'yellow' : 'green';

  return (
    <>
      <Text> </Text>
      <Text bold dimColor>Context</Text>
      <Box>
        <Box width={15}>
          <Text dimColor>Tokens:</Text>
        </Box>
        <Text>~{tokensK}k / {limitK}k </Text>
        <Text color={barColor}>{bar}</Text>
        <Text dimColor> {analysis.contextUsedPercent}%</Text>
      </Box>
      {overflows ? (
        <DetailRow label="Overflow:" value={`~${overflowK}k over limit (will auto-compact on resume)`} />
      ) : (
        <DetailRow label="Remaining:" value={`~${remainingK}k tokens`} />
      )}
      <Text> </Text>
      <Text bold dimColor>Breakdown</Text>
      <DetailRow label="Tool results:" value={`${b.toolResults.percent}% (${b.toolResults.count})`} />
      <DetailRow label="Signatures:" value={`${b.thinkingSignatures.percent}% (${b.thinkingSignatures.count})`} />
      <DetailRow label="File history:" value={`${b.fileHistory.percent}% (${b.fileHistory.count})`} />
      <DetailRow label="Conversation:" value={`${b.conversation.percent}%`} />
      <DetailRow label="Tool uses:" value={`${b.toolUseRequests.percent}% (${b.toolUseRequests.count})`} />
      {b.other.percent > 0 && (
        <DetailRow label="Other:" value={`${b.other.percent}%`} />
      )}
      <Text> </Text>
      <DetailRow label="Trimmable:" value={`~${formatSize(trimmableBytes)} (~${trimmableTokens}k tokens)`} />
    </>
  );
}

function ProjectSummary({ stats, project, width }: { stats: ProjectStats; project: ProjectInfo; width: number }) {
  return (
    <>
      <Text bold color="cyan">{truncate(project.path, width - 6)}</Text>
      <Text> </Text>
      <Text bold dimColor>Overview</Text>
      <DetailRow label="Sessions:" value={stats.sessionCount.toString()} />
      <DetailRow label="Snapshots:" value={stats.snapshotCount.toString()} />
      <DetailRow label="Branches:" value={stats.branchCount.toString()} />
      <DetailRow label="Messages:" value={stats.totalMessages.toString()} />
      {stats.newestActivity && (
        <DetailRow label="Last active:" value={formatRelativeTime(stats.newestActivity)} />
      )}
      {stats.oldestActivity && (
        <DetailRow label="First seen:" value={formatRelativeTime(stats.oldestActivity)} />
      )}
    </>
  );
}

export function DetailPane({ node, width, height, sessions, project, focusPane, sessionStatuses }: DetailPaneProps) {
  const [snapshotSize, setSnapshotSize] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null);

  // Look up a branch's session from the loaded sessions list
  const branchSession = node?.type === 'branch' && node.branch && sessions
    ? sessions.find(s => s.sessionId === node.branch!.forked_session_id)
    : null;

  const projectStats = useMemo((): ProjectStats | null => {
    if (!project) return null;
    const { snapshots: snapshotCount, branches: branchCount } = countSnapshotsAndBranches(project.snapshotRoots);

    let totalMessages = 0;
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const s of project.sessions) {
      totalMessages += s.messageCount ?? 0;
      if (s.created && (!oldest || s.created < oldest)) oldest = s.created;
      if (s.modified && (!newest || s.modified > newest)) newest = s.modified;
    }

    return {
      sessionCount: project.sessions.length,
      snapshotCount,
      branchCount,
      totalMessages,
      oldestActivity: oldest,
      newestActivity: newest,
    };
  }, [project]);

  const showProjectSummary = focusPane === 'projects' || !node || node.type === 'separator';

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

  useEffect(() => {
    setAnalysis(null);

    if (node?.type === 'snapshot' && node.snapshot) {
      let cancelled = false;
      const jsonlPath = path.join(
        getCmvSnapshotsDir(),
        node.snapshot.snapshot_dir,
        'session',
        `${node.snapshot.source_session_id}.jsonl`
      );
      analyzeSession(jsonlPath).then(result => {
        if (!cancelled) setAnalysis(result);
      }).catch(() => {});
      return () => { cancelled = true; };
    }

    if (node?.type === 'session' && node.session?.fullPath) {
      let cancelled = false;
      analyzeSession(node.session.fullPath).then(result => {
        if (!cancelled) setAnalysis(result);
      }).catch(() => {});
      return () => { cancelled = true; };
    }

    // Analyze branch session JSONL if we can find it
    if (node?.type === 'branch' && branchSession) {
      let cancelled = false;
      const jsonlPath = path.join(branchSession._projectDir, `${branchSession.sessionId}.jsonl`);
      analyzeSession(jsonlPath).then(result => {
        if (!cancelled) setAnalysis(result);
      }).catch(() => {});
      return () => { cancelled = true; };
    }
  }, [node, branchSession]);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor="gray" overflow="hidden">
      <Box paddingX={1}>
        <Text bold>Details</Text>
      </Box>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {showProjectSummary && projectStats && project && (
          <ProjectSummary stats={projectStats} project={project} width={width} />
        )}
        {showProjectSummary && !projectStats && (
          <Text dimColor>No project selected.</Text>
        )}

        {!showProjectSummary && node?.type === 'snapshot' && node.snapshot && (
          <>
            <DetailRow label="Name:" value={node.snapshot.name} />
            <DetailRow label="Type:" value={node.snapshot.parent_snapshot ? 'Child Snapshot' : 'Root Snapshot'} />
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
            {analysis && <ContextAnalysis analysis={analysis} width={width} />}
          </>
        )}

        {!showProjectSummary && node?.type === 'branch' && node.branch && (() => {
          const branchStatus = sessionStatuses?.[node.branch!.forked_session_id] || 'idle';
          const statusLabel = branchStatus === 'active' ? 'Active' : branchStatus === 'busy' ? 'Busy' : 'Idle';
          const statusColor = branchStatus === 'active' ? 'green' : branchStatus === 'busy' ? 'yellow' : undefined;
          return <>
            <DetailRow label="Name:" value={node.branch.name} />
            <Box>
              <Box width={15}><Text dimColor>Status:</Text></Box>
              <Text color={statusColor} dimColor={branchStatus === 'idle'}>{statusLabel}</Text>
            </Box>
            <DetailRow label="Created:" value={formatRelativeTime(node.branch.created_at)} />
            <DetailRow label="Session:" value={node.branch.forked_session_id.substring(0, 12) + '…'} />
            {branchSession && (
              <>
                {branchSession.modified && (
                  <DetailRow label="Modified:" value={formatRelativeTime(branchSession.modified)} />
                )}
                <DetailRow label="Messages:" value={branchSession.messageCount?.toString() ?? '—'} />
              </>
            )}
            {analysis && <ContextAnalysis analysis={analysis} width={width} />}
          </>;
        })()}

        {!showProjectSummary && node?.type === 'session' && node.session && (() => {
          const sid = node.session!.sessionId;
          const sessStatus = sessionStatuses?.[sid] || 'idle';
          const isSource = project?.snapshotRoots.some(function check(n: TreeNode): boolean {
            if (n.type === 'snapshot' && n.snapshot?.source_session_id === sid) return true;
            return n.children.some(check);
          }) ?? false;
          const isBranchSession = project?.snapshotRoots.some(function check(n: TreeNode): boolean {
            if (n.type === 'branch' && n.branch?.forked_session_id === sid) return true;
            return n.children.some(check);
          }) ?? false;
          const typeLabel = isSource ? 'Source Session' : isBranchSession ? 'Forked Session' : 'Session';
          const statusLabel = sessStatus === 'active' ? 'Active' : sessStatus === 'busy' ? 'Busy' : 'Idle';
          const statusColor = sessStatus === 'active' ? 'green' : sessStatus === 'busy' ? 'yellow' : undefined;
          return <>
            <DetailRow label="Session ID:" value={sid} />
            <DetailRow label="Type:" value={typeLabel} />
            <Box>
              <Box width={15}><Text dimColor>Status:</Text></Box>
              <Text color={statusColor} dimColor={sessStatus === 'idle'}>{statusLabel}</Text>
            </Box>
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
            {analysis && <ContextAnalysis analysis={analysis} width={width} />}
            <Text> </Text>
            <Text dimColor>Press [s] to snapshot this session</Text>
          </>;
        })()}
      </Box>
    </Box>
  );
}

import { readIndex } from './metadata-store.js';
import type { VmcSnapshot, VmcBranch } from '../types/index.js';
import chalk from 'chalk';
import { formatRelativeTime } from '../utils/display.js';

interface TreeNode {
  type: 'snapshot' | 'branch';
  name: string;
  snapshot?: VmcSnapshot;
  branch?: VmcBranch;
  children: TreeNode[];
}

/**
 * Build a tree structure from snapshots and their branches.
 */
export async function buildTree(): Promise<TreeNode[]> {
  const index = await readIndex();
  const snapshots = Object.values(index.snapshots);

  // Find root snapshots (no parent)
  const roots: TreeNode[] = [];
  const snapshotNodes = new Map<string, TreeNode>();

  // Create nodes for all snapshots
  for (const snap of snapshots) {
    const node: TreeNode = {
      type: 'snapshot',
      name: snap.name,
      snapshot: snap,
      children: [],
    };
    snapshotNodes.set(snap.name, node);
  }

  // Build hierarchy: attach children to parents, branches to snapshots
  for (const snap of snapshots) {
    const node = snapshotNodes.get(snap.name)!;

    // Add branches as children
    for (const branch of snap.branches) {
      node.children.push({
        type: 'branch',
        name: branch.name,
        branch,
        children: [],
      });
    }

    // Add child snapshots (snapshots whose parent is this one)
    for (const otherSnap of snapshots) {
      if (otherSnap.parent_snapshot === snap.name) {
        const childNode = snapshotNodes.get(otherSnap.name);
        if (childNode) {
          node.children.push(childNode);
        }
      }
    }

    // If no parent, it's a root
    if (!snap.parent_snapshot || !snapshotNodes.has(snap.parent_snapshot)) {
      roots.push(node);
    }
  }

  // Sort roots by created_at
  roots.sort((a, b) => {
    const aTime = a.snapshot?.created_at ? new Date(a.snapshot.created_at).getTime() : 0;
    const bTime = b.snapshot?.created_at ? new Date(b.snapshot.created_at).getTime() : 0;
    return aTime - bTime;
  });

  return roots;
}

/**
 * Render tree as ASCII string.
 */
export function renderTree(roots: TreeNode[], maxDepth?: number): string {
  if (roots.length === 0) {
    return 'No snapshots found.';
  }

  const lines: string[] = [];

  function render(node: TreeNode, prefix: string, isLast: boolean, depth: number): void {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const connector = depth === 0 ? '' : (isLast ? '└── ' : '├── ');
    const line = prefix + connector + formatNode(node);
    lines.push(line);

    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const childIsLast = i === node.children.length - 1;
      render(child, childPrefix, childIsLast, depth + 1);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    if (i > 0) lines.push('');
    render(roots[i]!, '', true, 0);
  }

  return lines.join('\n');
}

/**
 * Format a single tree node for display.
 */
function formatNode(node: TreeNode): string {
  if (node.type === 'snapshot') {
    const snap = node.snapshot!;
    const parts = [chalk.bold.cyan(snap.name)];
    parts.push(chalk.dim('(snapshot'));
    if (snap.created_at) {
      parts.push(chalk.dim(formatRelativeTime(snap.created_at)));
    }
    if (snap.message_count) {
      parts.push(chalk.dim(`${snap.message_count} msgs`));
    }
    parts.push(chalk.dim(')'));
    return parts.join(' ');
  } else {
    const branch = node.branch!;
    const parts = [chalk.green(branch.name)];
    parts.push(chalk.dim('(branch'));
    if (branch.created_at) {
      parts.push(chalk.dim(formatRelativeTime(branch.created_at)));
    }
    parts.push(chalk.dim(')'));
    return parts.join(' ');
  }
}

/**
 * Convert tree to JSON-serializable format.
 */
export function treeToJson(roots: TreeNode[]): object[] {
  return roots.map(function nodeToObj(node: TreeNode): object {
    const obj: Record<string, unknown> = {
      type: node.type,
      name: node.name,
    };

    if (node.type === 'snapshot' && node.snapshot) {
      obj.id = node.snapshot.id;
      obj.created_at = node.snapshot.created_at;
      obj.message_count = node.snapshot.message_count;
      obj.tags = node.snapshot.tags;
    } else if (node.type === 'branch' && node.branch) {
      obj.forked_session_id = node.branch.forked_session_id;
      obj.created_at = node.branch.created_at;
    }

    if (node.children.length > 0) {
      obj.children = node.children.map(nodeToObj);
    }

    return obj;
  });
}

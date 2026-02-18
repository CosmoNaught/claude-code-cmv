import { useState, useMemo, useCallback, useEffect } from 'react';
import { useInput } from 'ink';
import type { TreeNode } from '../../types/index.js';

export interface FlatNode {
  node: TreeNode;
  depth: number;
  isLast: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
  parentPrefixes: boolean[]; // true = parent was last child (no continuing line)
}

export interface TreeNavigationState {
  flatNodes: FlatNode[];
  selectedIndex: number;
  selectedNode: TreeNode | null;
  toggleCollapse: () => void;
}

function nodeKey(node: TreeNode): string {
  return `${node.type}:${node.name}`;
}

function isSelectable(node: TreeNode): boolean {
  return node.type !== 'separator';
}

export function useTreeNavigation(roots: TreeNode[], active: boolean): TreeNavigationState {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Flatten tree respecting collapsed state
  const flatNodes = useMemo(() => {
    const result: FlatNode[] = [];

    function walk(nodes: TreeNode[], depth: number, parentPrefixes: boolean[]) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const isLast = i === nodes.length - 1;
        const hasChildren = node.children.length > 0;
        const key = nodeKey(node);
        const nodeCollapsed = collapsed.has(key);

        result.push({
          node,
          depth,
          isLast,
          hasChildren,
          isCollapsed: nodeCollapsed,
          parentPrefixes: [...parentPrefixes],
        });

        if (hasChildren && !nodeCollapsed) {
          walk(node.children, depth + 1, [...parentPrefixes, isLast]);
        }
      }
    }

    walk(roots, 0, []);
    return result;
  }, [roots, collapsed]);

  // Find next/prev selectable index, skipping separators
  const findNextSelectable = useCallback((from: number, direction: 1 | -1): number => {
    let idx = from + direction;
    while (idx >= 0 && idx < flatNodes.length) {
      if (isSelectable(flatNodes[idx]!.node)) return idx;
      idx += direction;
    }
    return from; // stay put if nothing found
  }, [flatNodes]);

  // Clamp selectedIndex when flat list changes size
  const clampedIndex = useMemo(() => {
    let idx = Math.min(selectedIndex, Math.max(0, flatNodes.length - 1));
    // If clamped to a separator, find nearest selectable
    if (flatNodes.length > 0 && flatNodes[idx] && !isSelectable(flatNodes[idx]!.node)) {
      // Try forward first, then backward
      for (let i = idx; i < flatNodes.length; i++) {
        if (isSelectable(flatNodes[i]!.node)) { idx = i; break; }
      }
      if (!isSelectable(flatNodes[idx]!.node)) {
        for (let i = idx; i >= 0; i--) {
          if (isSelectable(flatNodes[i]!.node)) { idx = i; break; }
        }
      }
    }
    return idx;
  }, [selectedIndex, flatNodes]);

  useEffect(() => {
    if (clampedIndex !== selectedIndex) {
      setSelectedIndex(clampedIndex);
    }
  }, [clampedIndex, selectedIndex]);

  const toggleCollapse = useCallback(() => {
    const current = flatNodes[clampedIndex]?.node;
    if (!current || current.children.length === 0) return;
    const key = nodeKey(current);
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [flatNodes, clampedIndex]);

  useInput((input, key) => {
    if (!active) return;

    // Navigate down (skip separators)
    if (input === 'j' || key.downArrow) {
      setSelectedIndex(prev => findNextSelectable(prev, 1));
    }
    // Navigate up (skip separators)
    if (input === 'k' || key.upArrow) {
      setSelectedIndex(prev => findNextSelectable(prev, -1));
    }
    // Collapse
    if (key.leftArrow) {
      const current = flatNodes[clampedIndex]?.node;
      if (current && current.children.length > 0) {
        const k = nodeKey(current);
        setCollapsed(prev => new Set(prev).add(k));
      }
    }
    // Expand
    if (key.rightArrow) {
      const current = flatNodes[clampedIndex]?.node;
      if (current && current.children.length > 0) {
        const k = nodeKey(current);
        setCollapsed(prev => {
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
    }
  }, { isActive: active });

  return {
    flatNodes,
    selectedIndex: clampedIndex,
    selectedNode: flatNodes[clampedIndex]?.node ?? null,
    toggleCollapse,
  };
}

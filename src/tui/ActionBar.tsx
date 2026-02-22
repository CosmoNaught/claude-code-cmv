import React from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../types/index.js';

interface ActionBarProps {
  selectedNode: TreeNode | null;
  focusPane: 'projects' | 'tree';
}

function KeyHint({ keyChar, label }: { keyChar: string; label: string }) {
  return (
    <Box marginRight={2}>
      <Text color="yellow">[{keyChar}]</Text>
      <Text> {label}</Text>
    </Box>
  );
}

export function ActionBar({ selectedNode, focusPane }: ActionBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {focusPane === 'projects' ? (
        <>
          <KeyHint keyChar="Tab" label="Switch" />
          <KeyHint keyChar="r" label="Refresh" />
          <KeyHint keyChar="q" label="Quit" />
        </>
      ) : (
        <>
          {selectedNode?.type === 'snapshot' && (
            <>
              <KeyHint keyChar="Enter" label="Branch+Open" />
              <KeyHint keyChar="b" label="Branch" />
              <KeyHint keyChar="m" label="Multi-branch" />
              <KeyHint keyChar="s" label="Snapshot" />
              <KeyHint keyChar="d" label="Delete" />
              <KeyHint keyChar="e" label="Export" />
              <KeyHint keyChar="i" label="Import" />
              <KeyHint keyChar="r" label="Refresh" />
              <KeyHint keyChar="Tab" label="Switch" />
              <KeyHint keyChar="q" label="Quit" />
            </>
          )}
          {selectedNode?.type === 'session' && (
            <>
              <KeyHint keyChar="Enter" label="Open" />
              <KeyHint keyChar="s" label="Snapshot this" />
              <KeyHint keyChar="d" label="Delete" />
              <KeyHint keyChar="i" label="Import" />
              <KeyHint keyChar="r" label="Refresh" />
              <KeyHint keyChar="Tab" label="Switch" />
              <KeyHint keyChar="q" label="Quit" />
            </>
          )}
          {selectedNode?.type === 'branch' && (
            <>
              <KeyHint keyChar="Enter" label="Open" />
              <KeyHint keyChar="s" label="Snapshot" />
              <KeyHint keyChar="d" label="Delete" />
              <KeyHint keyChar="r" label="Refresh" />
              <KeyHint keyChar="Tab" label="Switch" />
              <KeyHint keyChar="q" label="Quit" />
            </>
          )}
          {!selectedNode && (
            <>
              <KeyHint keyChar="s" label="Snapshot" />
              <KeyHint keyChar="i" label="Import" />
              <KeyHint keyChar="r" label="Refresh" />
              <KeyHint keyChar="Tab" label="Switch" />
              <KeyHint keyChar="q" label="Quit" />
            </>
          )}
        </>
      )}
    </Box>
  );
}

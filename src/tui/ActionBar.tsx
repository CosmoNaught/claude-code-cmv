import React from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../types/index.js';

interface ActionBarProps {
  selectedNode: TreeNode | null;
}

function KeyHint({ keyChar, label }: { keyChar: string; label: string }) {
  return (
    <Box marginRight={2}>
      <Text color="yellow">[{keyChar}]</Text>
      <Text> {label}</Text>
    </Box>
  );
}

export function ActionBar({ selectedNode }: ActionBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {selectedNode?.type === 'snapshot' && (
        <>
          <KeyHint keyChar="b" label="Branch" />
          <KeyHint keyChar="s" label="Snapshot" />
          <KeyHint keyChar="d" label="Delete" />
          <KeyHint keyChar="e" label="Export" />
          <KeyHint keyChar="i" label="Import" />
          <KeyHint keyChar="Tab" label="Switch" />
          <KeyHint keyChar="q" label="Quit" />
        </>
      )}
      {selectedNode?.type === 'session' && (
        <>
          <KeyHint keyChar="Enter" label="Open" />
          <KeyHint keyChar="s" label="Snapshot this" />
          <KeyHint keyChar="i" label="Import" />
          <KeyHint keyChar="Tab" label="Switch" />
          <KeyHint keyChar="q" label="Quit" />
        </>
      )}
      {selectedNode?.type === 'branch' && (
        <>
          <KeyHint keyChar="Enter" label="Open" />
          <KeyHint keyChar="s" label="Snapshot" />
          <KeyHint keyChar="Tab" label="Switch" />
          <KeyHint keyChar="q" label="Quit" />
        </>
      )}
      {!selectedNode && (
        <>
          <KeyHint keyChar="s" label="Snapshot" />
          <KeyHint keyChar="i" label="Import" />
          <KeyHint keyChar="Tab" label="Switch" />
          <KeyHint keyChar="q" label="Quit" />
        </>
      )}
    </Box>
  );
}

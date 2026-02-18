import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

interface SnapshotPromptProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
  label?: string;  // custom label e.g. "Snapshot session 7e616107…"
}

export function SnapshotPrompt({ onSubmit, onCancel, label }: SnapshotPromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{label || 'Snapshot name'}: </Text>
      <TextInput
        placeholder="my-snapshot"
        onSubmit={(value) => {
          const trimmed = value.trim();
          if (trimmed) onSubmit(trimmed);
          else onCancel();
        }}
      />
      <Box marginLeft={2}>
        <Text dimColor>[Esc] Cancel</Text>
      </Box>
    </Box>
  );
}

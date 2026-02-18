import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

interface BranchPromptProps {
  snapshotName: string;
  onSubmit: (branchName: string) => void;
  onCancel: () => void;
}

export function BranchPrompt({ snapshotName, onSubmit, onCancel }: BranchPromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Branch name for '{snapshotName}': </Text>
      <TextInput
        placeholder="my-branch"
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

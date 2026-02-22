import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

interface MultiBranchPromptProps {
  snapshotName: string;
  onSubmit: (branchNames: string[]) => void;
  onCancel: () => void;
}

export function MultiBranchPrompt({ snapshotName, onSubmit, onCancel }: MultiBranchPromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Multi-branch '{snapshotName}': </Text>
      <TextInput
        placeholder="name1, name2, name3"
        onSubmit={(value) => {
          const names = value
            .split(',')
            .map(n => n.trim())
            .filter(n => n.length > 0);
          if (names.length > 0) onSubmit(names);
          else onCancel();
        }}
      />
      <Box marginLeft={2}>
        <Text dimColor>[Esc] Cancel</Text>
      </Box>
    </Box>
  );
}

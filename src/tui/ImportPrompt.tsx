import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

interface ImportPromptProps {
  onSubmit: (filePath: string) => void;
  onCancel: () => void;
}

export function ImportPrompt({ onSubmit, onCancel }: ImportPromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Import path (.vmc file): </Text>
      <TextInput
        placeholder="./snapshot.vmc"
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

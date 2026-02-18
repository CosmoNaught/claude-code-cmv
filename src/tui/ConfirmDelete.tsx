import React from 'react';
import { Box, Text, useInput } from 'ink';

interface ConfirmDeleteProps {
  name: string;
  branchCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDelete({ name, branchCount, onConfirm, onCancel }: ConfirmDeleteProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onConfirm();
    } else if (input === 'n' || input === 'N' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box borderStyle="single" borderColor="red" paddingX={1}>
      <Text color="red">
        Delete "{name}"?
        {branchCount > 0 && ` (has ${branchCount} branch${branchCount > 1 ? 'es' : ''})`}
        {' '}
      </Text>
      <Text>[y/N]</Text>
    </Box>
  );
}

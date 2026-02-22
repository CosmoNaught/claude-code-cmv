import React from 'react';
import { Box, Text } from 'ink';
import type { ProjectInfo } from './hooks/useProjects.js';

interface ProjectPaneProps {
  projects: ProjectInfo[];
  selectedIndex: number;
  focused: boolean;
  height: number;
  width: number;
}

function shortenPath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  // Show last segments that fit
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep);
  let result = parts[parts.length - 1] || '';
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts[i] + sep + result;
    if (candidate.length > maxLen - 2) {
      result = '…' + sep + result;
      break;
    }
    result = candidate;
  }
  return result.length > maxLen ? result.slice(0, maxLen - 1) + '…' : result;
}

export function ProjectPane({ projects, selectedIndex, focused, height, width }: ProjectPaneProps) {
  const visibleCount = Math.max(1, height - 3); // -2 borders, -1 header
  const halfWindow = Math.floor(visibleCount / 2);
  let startIndex = Math.max(0, selectedIndex - halfWindow);
  const endIndex = Math.min(projects.length, startIndex + visibleCount);
  if (endIndex - startIndex < visibleCount) {
    startIndex = Math.max(0, endIndex - visibleCount);
  }

  const visibleProjects = projects.slice(startIndex, endIndex);
  const maxWidth = width - 4;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor={focused ? 'cyan' : 'gray'}>
      <Box paddingX={1}>
        <Text bold> Projects</Text>
      </Box>
      {projects.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>No projects</Text>
        </Box>
      ) : (
        visibleProjects.map((project, i) => {
          const isSelected = startIndex + i === selectedIndex;
          const label = shortenPath(project.path, maxWidth - 4);

          if (isSelected && focused) {
            return (
              <Box key={project.path} paddingX={1}>
                <Text inverse>
                  {'▸ '}{label}{' '.repeat(Math.max(0, maxWidth - label.length - 2))}
                </Text>
              </Box>
            );
          }

          return (
            <Box key={project.path} paddingX={1}>
              <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected}>
                {'  '}{label}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

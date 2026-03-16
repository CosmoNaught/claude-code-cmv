import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/core/**/*.ts',
        'src/utils/**/*.ts',
        'src/commands/**/*.ts',
        'src/postinstall.ts',
      ],
      exclude: [
        'src/tui/**',
        'src/types/**',
        'src/index.ts',
      ],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95,
        lines: 95,
      },
    },
  },
});

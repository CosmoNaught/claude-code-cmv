# Contributing to CMV

Thank you for your interest in contributing to CMV (Contextual Memory Virtualisation).

## Development Setup

**Requirements:** Node.js 18+

```bash
git clone https://github.com/CosmoNaught/claude-code-cmv.git
cd claude-code-cmv
npm install
npm run build
```

## Project Structure

```
src/
├── core/       # Business logic (trimmer, analyzer, snapshot/branch managers)
├── commands/   # CLI command handlers (Commander.js)
├── utils/      # Shared utilities (paths, display, errors, IDs)
├── tui/        # Ink/React dashboard (excluded from test coverage)
├── types/      # TypeScript interfaces
├── index.ts    # CLI entry point
└── postinstall.ts  # Auto-hook installer
tests/
├── *.test.ts           # Core module tests
├── utils/*.test.ts     # Utility tests
└── commands/*.test.ts  # Command integration tests
```

## Testing

```bash
npm test              # Watch mode
npm run test:run      # Single run
npm run test:coverage # With coverage report
```

### Guidelines

- All new core logic must have corresponding tests.
- Use temp directories (`fs/promises` `mkdtemp`) for any file I/O in tests.
- Mock external dependencies via `vi.mock()`.
- TUI components (`src/tui/`) are excluded from coverage requirements — they are presentation-only and all business logic lives in `src/core/`.
- Target: 85%+ line coverage on `src/core/`, `src/utils/`, and `src/commands/`.

## Code Style

- TypeScript strict mode.
- ESM imports with `.js` extensions (Node16 module resolution).
- Apache-2.0 SPDX license header in every source file:
  ```ts
  // Copyright 2025-2026 CMV Contributors
  // SPDX-License-Identifier: Apache-2.0
  ```

## Pull Request Process

1. Fork the repository and create a feature branch.
2. Add tests for any new code.
3. Run `npm run test:coverage` and ensure coverage thresholds pass.
4. Run `npx tsc --noEmit` to verify no type errors.
5. Update documentation if adding or changing public API.
6. Submit a PR against `main`.

## Reporting Issues

Use [GitHub Issues](https://github.com/CosmoNaught/claude-code-cmv/issues) for bug reports and feature requests. Templates are provided.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).

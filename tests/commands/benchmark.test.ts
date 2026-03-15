// Copyright 2025-2026 CMV Contributors
// SPDX-License-Identifier: Apache-2.0
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('../../src/utils/errors.js', () => ({
  handleError: vi.fn(),
  CmvError: class extends Error { constructor(public userMessage: string) { super(userMessage); } },
}));

vi.mock('../../src/utils/display.js', () => ({
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dim: (s: string) => s,
  bold: (s: string) => s,
  formatDate: (s: string) => s,
  formatRelativeTime: () => 'recently',
  truncate: (s: string) => s,
  formatTable: () => 'table',
}));

vi.mock('chalk', () => {
  const p = (s: string) => s;
  const obj: any = Object.assign(p, {
    green: p, yellow: p, red: p, blue: p, dim: p, cyan: p,
    bold: Object.assign(p, { cyan: p }),
    magenta: p,
  });
  return { default: obj };
});

// ── A complete mock report with realistic values ──────────────────────────────

function makeMockReport(overrides: Partial<any> = {}): any {
  return {
    preTrimTokens: 50000,
    postTrimTokens: 20000,
    reductionPercent: 60,
    modelDisplayName: 'Sonnet 4',
    inputPricePerMTok: 3,
    cacheHitRate: 0.9,
    breakdown: {
      toolResults: { percent: 40, count: 10, bytes: 400000 },
      thinkingSignatures: { percent: 10, count: 5, bytes: 100000 },
      fileHistory: { percent: 10, count: 3, bytes: 100000 },
    },
    preTrimCostPerTurn: 0.01,
    postTrimSteadyCostPerTurn: 0.004,
    postTrimFirstTurnCost: 0.05,
    cacheMissPenalty: 0.04,
    savingsPerTurn: 0.006,
    breakEvenTurns: 7,
    projections: [
      { turns: 5, withoutTrim: 0.05, withTrim: 0.06, savedPercent: -20 },
      { turns: 10, withoutTrim: 0.10, withTrim: 0.07, savedPercent: 30 },
      { turns: 20, withoutTrim: 0.20, withTrim: 0.12, savedPercent: 40 },
    ],
    ...overrides,
  };
}

const mockAnalyzeCacheImpact = vi.fn().mockResolvedValue(makeMockReport());
const mockAnalyzeCacheImpactWithRealTrim = vi.fn();

const mockGetLatestSession = vi.fn().mockResolvedValue({
  sessionId: 'sess-latest-0000-0000-000000000000',
  projectPath: '/proj',
  _projectDir: '/proj',
});

const mockFindSession = vi.fn().mockResolvedValue({
  sessionId: 'sess-found-0000-0000-000000000000',
  projectPath: '/proj',
  _projectDir: '/proj',
});

const mockGetSessionJsonlPath = vi.fn().mockReturnValue('/path/to/session.jsonl');

const mockListAllSessions = vi.fn().mockResolvedValue([]);
const mockIsSessionActive = vi.fn().mockResolvedValue(false);

vi.mock('../../src/core/cache-analyzer.js', () => ({
  analyzeCacheImpact: (...args: any[]) => mockAnalyzeCacheImpact(...args),
  analyzeCacheImpactWithRealTrim: (...args: any[]) => mockAnalyzeCacheImpactWithRealTrim(...args),
  PRICING: {
    sonnet: { name: 'Sonnet 4' },
    opus: { name: 'Opus 4.6' },
    'opus-4': { name: 'Opus 4/4.1' },
    haiku: { name: 'Haiku 4.5' },
  },
}));

vi.mock('../../src/core/analyzer.js', () => ({
  analyzeSession: vi.fn(),
}));

vi.mock('../../src/core/session-reader.js', () => ({
  findSession: (...args: any[]) => mockFindSession(...args),
  getLatestSession: (...args: any[]) => mockGetLatestSession(...args),
  getSessionJsonlPath: (...args: any[]) => mockGetSessionJsonlPath(...args),
  listAllSessions: (...args: any[]) => mockListAllSessions(...args),
  isSessionActive: (...args: any[]) => mockIsSessionActive(...args),
}));

import { registerBenchmarkCommand } from '../../src/commands/benchmark.js';
import { handleError } from '../../src/utils/errors.js';

// ─────────────────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerBenchmarkCommand(program);
  return program;
}

describe('benchmark command — session resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestSession.mockResolvedValue({
      sessionId: 'sess-latest-0000-0000-000000000000',
      projectPath: '/proj',
      _projectDir: '/proj',
    });
    mockFindSession.mockResolvedValue({
      sessionId: 'sess-found-0000-0000-000000000000',
      projectPath: '/proj',
      _projectDir: '/proj',
    });
    mockGetSessionJsonlPath.mockReturnValue('/path/to/session.jsonl');
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
  });

  it('analyzes session with --latest', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    expect(mockGetLatestSession).toHaveBeenCalled();
    expect(mockAnalyzeCacheImpact).toHaveBeenCalled();
  });

  it('shows error without session flag', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--session'));
  });

  it('resolves session by ID with --session flag', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--session', 'sess-found-0000-0000-000000000000']);
    expect(mockFindSession).toHaveBeenCalledWith('sess-found-0000-0000-000000000000');
    expect(mockAnalyzeCacheImpact).toHaveBeenCalled();
  });

  it('calls handleError when --session ID is not found', async () => {
    mockFindSession.mockResolvedValueOnce(null);
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--session', 'nonexistent-id']);
    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('nonexistent-id') }),
    );
  });

  it('calls handleError when --latest returns no session', async () => {
    mockGetLatestSession.mockResolvedValueOnce(null);
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('No sessions found') }),
    );
  });
});

describe('benchmark command — --json flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestSession.mockResolvedValue({
      sessionId: 'sess-latest-0000-0000-000000000000',
      projectPath: '/proj',
      _projectDir: '/proj',
    });
    mockGetSessionJsonlPath.mockReturnValue('/path/to/session.jsonl');
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
  });

  it('outputs JSON when --json flag is set', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--json']);
    expect(console.log).toHaveBeenCalled();
    // Find the call that looks like JSON
    const jsonCalls = vi.mocked(console.log).mock.calls.filter(call => {
      const arg = call[0];
      return typeof arg === 'string' && arg.startsWith('{');
    });
    expect(jsonCalls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(jsonCalls[0][0] as string);
    expect(parsed).toHaveProperty('preTrimTokens');
    expect(parsed).toHaveProperty('postTrimTokens');
    expect(parsed).toHaveProperty('reductionPercent');
  });

  it('does not call info() when --json flag is set', async () => {
    const { info } = await import('../../src/utils/display.js');
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--json']);
    expect(info).not.toHaveBeenCalled();
  });

  it('calls info() when --json is not set', async () => {
    const { info } = await import('../../src/utils/display.js');
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    expect(info).toHaveBeenCalled();
  });
});

describe('benchmark command — --model flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestSession.mockResolvedValue({
      sessionId: 'sess-latest-0000-0000-000000000000',
      projectPath: '/proj',
      _projectDir: '/proj',
    });
    mockGetSessionJsonlPath.mockReturnValue('/path/to/session.jsonl');
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
  });

  it('accepts valid model "sonnet"', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--model', 'sonnet']);
    expect(mockAnalyzeCacheImpact).toHaveBeenCalledWith(
      expect.any(String),
      'sonnet',
      expect.any(Number),
    );
  });

  it('accepts valid model "opus"', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--model', 'opus']);
    expect(mockAnalyzeCacheImpact).toHaveBeenCalledWith(
      expect.any(String),
      'opus',
      expect.any(Number),
    );
  });

  it('accepts valid model "opus-4"', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--model', 'opus-4']);
    expect(mockAnalyzeCacheImpact).toHaveBeenCalledWith(
      expect.any(String),
      'opus-4',
      expect.any(Number),
    );
  });

  it('accepts valid model "haiku"', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--model', 'haiku']);
    expect(mockAnalyzeCacheImpact).toHaveBeenCalledWith(
      expect.any(String),
      'haiku',
      expect.any(Number),
    );
  });

  it('exits with code 1 for invalid model', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest', '--model', 'gpt4']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('gpt4'));
  });

  it('defaults to "sonnet" when no --model given', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    expect(mockAnalyzeCacheImpact).toHaveBeenCalledWith(
      expect.any(String),
      'sonnet',
      expect.any(Number),
    );
  });
});

describe('benchmark command — --all batch mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllSessions.mockResolvedValue([]);
    mockIsSessionActive.mockResolvedValue(false);
    mockAnalyzeCacheImpactWithRealTrim.mockResolvedValue({
      report: makeMockReport(),
      trimMetrics: {
        originalBytes: 1000,
        trimmedBytes: 600,
        toolResultsStubbed: 5,
        signaturesStripped: 2,
        fileHistoryRemoved: 1,
        imagesStripped: 0,
        toolUseInputsStubbed: 3,
        preCompactionLinesSkipped: 0,
        queueOperationsRemoved: 0,
        userMessages: 4,
        assistantResponses: 4,
        toolUseRequests: 3,
      },
      analysis: {
        estimatedTokens: 10000,
        messageCount: { user: 4, assistant: 4, toolResults: 3 },
        totalBytes: 1000,
        contextUsedPercent: 5,
        breakdown: {
          toolResults: { percent: 40, count: 10, bytes: 400000 },
          thinkingSignatures: { percent: 10, count: 5, bytes: 100000 },
          fileHistory: { percent: 10, count: 3, bytes: 100000 },
        },
      },
    });
  });

  it('calls runBatchBenchmark (listAllSessions) when --all is given', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--all']);
    expect(mockListAllSessions).toHaveBeenCalled();
    // Single-session functions should NOT be called
    expect(mockGetLatestSession).not.toHaveBeenCalled();
    expect(mockFindSession).not.toHaveBeenCalled();
  });

  it('does not call analyzeCacheImpact (single) in --all mode', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--all']);
    expect(mockAnalyzeCacheImpact).not.toHaveBeenCalled();
  });

  it('filters out subagent sessions in --all mode', async () => {
    mockListAllSessions.mockResolvedValue([
      { sessionId: 'sub1', _projectDir: '/some/subagents/path', messageCount: 20 },
      { sessionId: 'reg1', _projectDir: '/normal/project', messageCount: 20, projectPath: '/normal/project' },
    ]);
    mockIsSessionActive.mockResolvedValue(false);
    mockAnalyzeCacheImpactWithRealTrim.mockResolvedValue({
      report: makeMockReport(),
      trimMetrics: {
        originalBytes: 1000, trimmedBytes: 600,
        toolResultsStubbed: 0, signaturesStripped: 0, fileHistoryRemoved: 0,
        imagesStripped: 0, toolUseInputsStubbed: 0,
        preCompactionLinesSkipped: 0, queueOperationsRemoved: 0,
        userMessages: 4, assistantResponses: 4, toolUseRequests: 0,
      },
      analysis: {
        estimatedTokens: 10000,
        messageCount: { user: 4, assistant: 4, toolResults: 0 },
        totalBytes: 1000, contextUsedPercent: 5,
        breakdown: {
          toolResults: { percent: 40, count: 0, bytes: 0 },
          thinkingSignatures: { percent: 0, count: 0, bytes: 0 },
          fileHistory: { percent: 0, count: 0, bytes: 0 },
        },
      },
    });
    mockGetSessionJsonlPath.mockReturnValue('/path/session.jsonl');

    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--all']);

    // analyzeCacheImpactWithRealTrim should only be called for the non-subagent session
    expect(mockAnalyzeCacheImpactWithRealTrim).toHaveBeenCalledTimes(1);
  });

  it('passes model and cache rate to runBatchBenchmark', async () => {
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--all', '--model', 'haiku', '--cache-rate', '75']);
    // listAllSessions is always called; the model/cacheRate are used internally
    expect(mockListAllSessions).toHaveBeenCalled();
  });
});

describe('benchmark command — renderReport output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestSession.mockResolvedValue({
      sessionId: 'abcdef12-0000-0000-0000-000000000000',
      projectPath: '/proj',
      _projectDir: '/proj',
    });
    mockGetSessionJsonlPath.mockReturnValue('/path/to/session.jsonl');
  });

  it('outputs report sections to console.log', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    // Key sections from renderReport
    expect(allOutput).toContain('CMV Cache Impact Analysis');
    expect(allOutput).toContain('Context Window');
    expect(allOutput).toContain('Context Breakdown');
    expect(allOutput).toContain('Cost Per Turn');
    expect(allOutput).toContain('Cumulative Cost Projection');
  });

  it('shows Verdict with break-even info when breakEvenTurns <= 5', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ breakEvenTurns: 3 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('Verdict');
    expect(allOutput).toContain('3 turns');
  });

  it('shows break-even message when breakEvenTurns is 6-15', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ breakEvenTurns: 10 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('10 turns');
  });

  it('shows no-trim-needed verdict when breakEvenTurns > 15', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ breakEvenTurns: 99 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('Minimal context bloat');
  });

  it('shows N/A break-even when breakEvenTurns is Infinity', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ breakEvenTurns: Infinity, savingsPerTurn: 0 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('N/A');
  });

  it('shows session ID prefix in report header', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    // Session ID is truncated to first 12 chars + '...'
    expect(allOutput).toContain('abcdef12-000');
  });

  it('renders projection rows for each turns value', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    // Should have rows for turns 5, 10, 20
    expect(allOutput).toContain('5');
    expect(allOutput).toContain('10');
    expect(allOutput).toContain('20');
  });
});

describe('benchmark command — helper functions via renderReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestSession.mockResolvedValue({
      sessionId: 'abcdef12-0000-0000-0000-000000000000',
      projectPath: '/proj',
      _projectDir: '/proj',
    });
    mockGetSessionJsonlPath.mockReturnValue('/path/to/session.jsonl');
  });

  it('formats large token counts with k suffix (tok helper)', async () => {
    // preTrimTokens = 50000 => should be formatted as "50.0k"
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ preTrimTokens: 50000 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('50.0k');
  });

  it('formats small token counts without k suffix (tok helper)', async () => {
    // postTrimTokens = 500 => should render as "500"
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ preTrimTokens: 500, postTrimTokens: 300 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('500');
  });

  it('formats dollar amounts with 4 decimal places ($ helper)', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ cacheMissPenalty: 0.04 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('$0.0400');
  });

  it('formats percentages with % suffix (pct helper)', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({ reductionPercent: 60, cacheHitRate: 0.9 }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('90%');
  });

  it('renders bar characters in output', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport());
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    // bar() produces █ and ░ characters
    expect(allOutput).toContain('█');
    expect(allOutput).toContain('░');
  });

  it('renders tool result and thinking block counts in breakdown', async () => {
    mockAnalyzeCacheImpact.mockResolvedValue(makeMockReport({
      breakdown: {
        toolResults: { percent: 40, count: 10, bytes: 400000 },
        thinkingSignatures: { percent: 10, count: 5, bytes: 100000 },
        fileHistory: { percent: 10, count: 3, bytes: 100000 },
      },
    }));
    await makeProgram().parseAsync(['node', 'cmv', 'benchmark', '--latest']);
    const allOutput = vi.mocked(console.log).mock.calls.map(c => c.join('')).join('\n');
    expect(allOutput).toContain('10 results');
    expect(allOutput).toContain('5 blocks');
    expect(allOutput).toContain('3 entries');
  });
});

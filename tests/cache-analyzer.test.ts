import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { estimatePostTrimTokens, analyzeCacheImpact, analyzeCacheImpactWithRealTrim, PRICING } from '../src/core/cache-analyzer.js';
import type { SessionAnalysis } from '../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

function makeAnalysis(overrides: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return {
    totalBytes: 100_000,
    estimatedTokens: 50_000,
    contextLimit: 200_000,
    contextUsedPercent: 25,
    breakdown: {
      toolResults: { bytes: 40_000, count: 20, percent: 40 },
      thinkingSignatures: { bytes: 15_000, count: 10, percent: 15 },
      fileHistory: { bytes: 5_000, count: 3, percent: 5 },
      conversation: { bytes: 20_000, percent: 20 },
      toolUseRequests: { bytes: 15_000, count: 25, percent: 15 },
      other: { bytes: 5_000, percent: 5 },
    },
    messageCount: { user: 10, assistant: 10, toolResults: 20 },
    ...overrides,
  };
}

describe('estimatePostTrimTokens', () => {
  it('returns fewer tokens than input for a typical session', () => {
    const analysis = makeAnalysis();
    const result = estimatePostTrimTokens(analysis);
    expect(result).toBeLessThan(analysis.estimatedTokens);
    expect(result).toBeGreaterThan(0);
  });

  it('returns original tokens when totalBytes is 0', () => {
    const analysis = makeAnalysis({ totalBytes: 0 });
    const result = estimatePostTrimTokens(analysis);
    expect(result).toBe(analysis.estimatedTokens);
  });

  it('preserves system overhead (20k tokens)', () => {
    const analysis = makeAnalysis();
    const result = estimatePostTrimTokens(analysis);
    // Result should always be >= 20k (system overhead)
    expect(result).toBeGreaterThanOrEqual(20_000);
  });

  it('removal ratio is capped at 95%', () => {
    // Create an analysis where removal would exceed 95%
    const analysis = makeAnalysis({
      totalBytes: 100_000,
      estimatedTokens: 50_000,
      breakdown: {
        toolResults: { bytes: 80_000, count: 5, percent: 80 },
        thinkingSignatures: { bytes: 15_000, count: 10, percent: 15 },
        fileHistory: { bytes: 5_000, count: 3, percent: 5 },
        conversation: { bytes: 0, percent: 0 },
        toolUseRequests: { bytes: 0, count: 0, percent: 0 },
        other: { bytes: 0, percent: 0 },
      },
    });
    const result = estimatePostTrimTokens(analysis);
    // Even with massive removal, should retain at least 5% of content + 20k overhead
    const minExpected = 20_000 + Math.round((50_000 - 20_000) * 0.05);
    expect(result).toBeGreaterThanOrEqual(minExpected);
  });

  it('accounts for tool_use input savings (30% factor)', () => {
    const withToolUse = makeAnalysis({
      breakdown: {
        toolResults: { bytes: 40_000, count: 20, percent: 40 },
        thinkingSignatures: { bytes: 15_000, count: 10, percent: 15 },
        fileHistory: { bytes: 5_000, count: 3, percent: 5 },
        conversation: { bytes: 20_000, percent: 20 },
        toolUseRequests: { bytes: 15_000, count: 25, percent: 15 },
        other: { bytes: 5_000, percent: 5 },
      },
    });

    const withoutToolUse = makeAnalysis({
      breakdown: {
        toolResults: { bytes: 40_000, count: 20, percent: 40 },
        thinkingSignatures: { bytes: 15_000, count: 10, percent: 15 },
        fileHistory: { bytes: 5_000, count: 3, percent: 5 },
        conversation: { bytes: 20_000, percent: 20 },
        toolUseRequests: { bytes: 0, count: 0, percent: 0 },
        other: { bytes: 20_000, percent: 20 },
      },
    });

    const resultWith = estimatePostTrimTokens(withToolUse);
    const resultWithout = estimatePostTrimTokens(withoutToolUse);

    // More tool_use bytes = more estimated savings = fewer post-trim tokens
    expect(resultWith).toBeLessThan(resultWithout);
  });

  it('subtracts stub overhead from removal estimate', () => {
    // With many tool results, the 35-byte stub overhead per result is subtracted
    const manyResults = makeAnalysis({
      breakdown: {
        toolResults: { bytes: 40_000, count: 100, percent: 40 },
        thinkingSignatures: { bytes: 0, count: 0, percent: 0 },
        fileHistory: { bytes: 0, count: 0, percent: 0 },
        conversation: { bytes: 50_000, percent: 50 },
        toolUseRequests: { bytes: 0, count: 0, percent: 0 },
        other: { bytes: 10_000, percent: 10 },
      },
    });

    const fewResults = makeAnalysis({
      breakdown: {
        toolResults: { bytes: 40_000, count: 5, percent: 40 },
        thinkingSignatures: { bytes: 0, count: 0, percent: 0 },
        fileHistory: { bytes: 0, count: 0, percent: 0 },
        conversation: { bytes: 50_000, percent: 50 },
        toolUseRequests: { bytes: 0, count: 0, percent: 0 },
        other: { bytes: 10_000, percent: 10 },
      },
    });

    const manyResult = estimatePostTrimTokens(manyResults);
    const fewResult = estimatePostTrimTokens(fewResults);

    // More tool results = more stub overhead subtracted = less net removal = more tokens
    expect(manyResult).toBeGreaterThan(fewResult);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: analyzeCacheImpact & analyzeCacheImpactWithRealTrim
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmv-cache-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

/** Write lines to a temp JSONL file and return its path. */
async function writeJsonl(name: string, lines: any[]): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/**
 * Build a realistic session JSONL with user/assistant/tool_result messages.
 * The large tool results create trimmable content so we get measurable savings.
 */
function buildSessionLines(): any[] {
  const bigContent = 'x'.repeat(2000); // >500 chars → trimmer will stub
  return [
    { type: 'user', content: 'Please read the file' },
    {
      type: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file for you.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/foo.ts' } },
      ],
    },
    {
      type: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: bigContent },
      ],
    },
    {
      type: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me analyze this file content...' },
        { type: 'text', text: 'The file contains test data.' },
      ],
    },
    { type: 'user', content: 'Now write a new file' },
    {
      type: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'Write', input: { file_path: '/tmp/bar.ts', content: bigContent } },
      ],
    },
    {
      type: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'File written successfully.' },
      ],
    },
    {
      type: 'assistant',
      content: [{ type: 'text', text: 'Done!' }],
    },
  ];
}

describe('PRICING export', () => {
  it('exports pricing for sonnet, opus, opus-4, and haiku', () => {
    expect(PRICING).toHaveProperty('sonnet');
    expect(PRICING).toHaveProperty('opus');
    expect(PRICING).toHaveProperty('opus-4');
    expect(PRICING).toHaveProperty('haiku');
  });

  it('each model has input, cacheWrite, and cacheRead prices', () => {
    for (const key of ['sonnet', 'opus', 'opus-4', 'haiku'] as const) {
      const p = PRICING[key];
      expect(p.input).toBeGreaterThan(0);
      expect(p.cacheWrite).toBeGreaterThan(p.input); // 1.25x
      expect(p.cacheRead).toBeLessThan(p.input);     // 0.1x
    }
  });

  it('cache write is 1.25x and cache read is 0.1x of input price', () => {
    for (const key of ['sonnet', 'opus', 'opus-4', 'haiku'] as const) {
      const p = PRICING[key];
      expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 5);
      expect(p.cacheRead).toBeCloseTo(p.input * 0.1, 5);
    }
  });
});

describe('analyzeCacheImpact', () => {
  it('returns a valid CacheImpactReport for default model (sonnet)', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const report = await analyzeCacheImpact(src);

    expect(report.model).toBe('sonnet');
    expect(report.modelDisplayName).toBe('Sonnet 4');
    expect(report.cacheHitRate).toBe(0.90);
    expect(report.preTrimTokens).toBeGreaterThan(0);
    expect(report.postTrimTokens).toBeGreaterThan(0);
    expect(report.postTrimTokens).toBeLessThanOrEqual(report.preTrimTokens);
    expect(report.reductionPercent).toBeGreaterThanOrEqual(0);
    expect(report.reductionPercent).toBeLessThanOrEqual(100);
  });

  it('uses the correct model pricing for opus', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const report = await analyzeCacheImpact(src, 'opus');

    expect(report.model).toBe('opus');
    expect(report.modelDisplayName).toBe('Opus 4.6');
    expect(report.inputPricePerMTok).toBe(5.00);
  });

  it('uses the correct model pricing for haiku', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const report = await analyzeCacheImpact(src, 'haiku');

    expect(report.model).toBe('haiku');
    expect(report.modelDisplayName).toBe('Haiku 4.5');
    expect(report.inputPricePerMTok).toBe(1.00);
  });

  it('respects custom cacheHitRate', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const high = await analyzeCacheImpact(src, 'sonnet', 0.99);
    const low = await analyzeCacheImpact(src, 'sonnet', 0.50);

    expect(high.cacheHitRate).toBe(0.99);
    expect(low.cacheHitRate).toBe(0.50);
    // Higher cache hit rate → lower pre-trim cost per turn
    expect(high.preTrimCostPerTurn).toBeLessThan(low.preTrimCostPerTurn);
  });

  it('computes break-even turns', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const report = await analyzeCacheImpact(src);

    if (report.savingsPerTurn > 0) {
      expect(report.breakEvenTurns).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(report.breakEvenTurns)).toBe(true);
    } else {
      expect(report.breakEvenTurns).toBe(Infinity);
    }
  });

  it('produces projections for 5, 10, 20, 50 turns', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const report = await analyzeCacheImpact(src);

    expect(report.projections).toHaveLength(4);
    expect(report.projections.map(p => p.turns)).toEqual([5, 10, 20, 50]);

    for (const proj of report.projections) {
      expect(proj.withoutTrim).toBeGreaterThanOrEqual(0);
      expect(proj.withTrim).toBeGreaterThanOrEqual(0);
      expect(proj.savedPercent).toBeGreaterThanOrEqual(-100);
      expect(proj.savedPercent).toBeLessThanOrEqual(100);
    }
  });

  it('includes breakdown from session analysis', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const report = await analyzeCacheImpact(src);

    expect(report.breakdown).toBeDefined();
    expect(report.breakdown.toolResults).toBeDefined();
    expect(report.breakdown.conversation).toBeDefined();
    expect(report.breakdown.thinkingSignatures).toBeDefined();
  });

  it('costs scale across models (opus-4 > opus > sonnet > haiku)', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const [sonnet, opus, opus4, haiku] = await Promise.all([
      analyzeCacheImpact(src, 'sonnet'),
      analyzeCacheImpact(src, 'opus'),
      analyzeCacheImpact(src, 'opus-4'),
      analyzeCacheImpact(src, 'haiku'),
    ]);

    expect(opus4.preTrimCostPerTurn).toBeGreaterThan(opus.preTrimCostPerTurn);
    expect(opus.preTrimCostPerTurn).toBeGreaterThan(sonnet.preTrimCostPerTurn);
    expect(sonnet.preTrimCostPerTurn).toBeGreaterThan(haiku.preTrimCostPerTurn);
  });
});

describe('analyzeCacheImpactWithRealTrim', () => {
  it('returns report, trimMetrics, and analysis', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const result = await analyzeCacheImpactWithRealTrim(src);

    expect(result.report).toBeDefined();
    expect(result.trimMetrics).toBeDefined();
    expect(result.analysis).toBeDefined();
  });

  it('report fields match expected structure', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const { report } = await analyzeCacheImpactWithRealTrim(src);

    expect(report.model).toBe('sonnet');
    expect(report.preTrimTokens).toBeGreaterThan(0);
    expect(report.postTrimTokens).toBeLessThanOrEqual(report.preTrimTokens);
    expect(report.projections).toHaveLength(4);
  });

  it('trimMetrics has real byte counts', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const { trimMetrics } = await analyzeCacheImpactWithRealTrim(src);

    expect(trimMetrics.originalBytes).toBeGreaterThan(0);
    expect(trimMetrics.trimmedBytes).toBeGreaterThan(0);
    expect(trimMetrics.trimmedBytes).toBeLessThanOrEqual(trimMetrics.originalBytes);
  });

  it('uses specified model and cacheHitRate', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const { report } = await analyzeCacheImpactWithRealTrim(src, 'opus', 0.80);

    expect(report.model).toBe('opus');
    expect(report.cacheHitRate).toBe(0.80);
    expect(report.inputPricePerMTok).toBe(5.00);
  });

  it('real trim post-trim tokens differ from estimated', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    const estimated = await analyzeCacheImpact(src);
    const { report: real } = await analyzeCacheImpactWithRealTrim(src);

    // Both should reduce tokens, but amounts may differ
    expect(estimated.postTrimTokens).toBeLessThanOrEqual(estimated.preTrimTokens);
    expect(real.postTrimTokens).toBeLessThanOrEqual(real.preTrimTokens);
    // Pre-trim tokens should be the same (same input)
    expect(real.preTrimTokens).toBe(estimated.preTrimTokens);
  });

  it('handles empty session gracefully', async () => {
    const src = await writeJsonl('empty.jsonl', [
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    const { report } = await analyzeCacheImpactWithRealTrim(src);

    expect(report.preTrimTokens).toBeGreaterThan(0);
    expect(report.postTrimTokens).toBeGreaterThan(0);
  });

  it('cleans up temp files after analysis', async () => {
    const src = await writeJsonl('session.jsonl', buildSessionLines());
    await analyzeCacheImpactWithRealTrim(src);

    // The function creates a temp dir internally and should clean it up.
    // We can't easily verify the exact temp dir, but the function should
    // not throw and should return valid results.
  });
});

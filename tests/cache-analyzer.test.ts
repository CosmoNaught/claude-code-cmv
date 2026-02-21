import { describe, it, expect } from 'vitest';
import { estimatePostTrimTokens } from '../src/core/cache-analyzer.js';
import type { SessionAnalysis } from '../src/types/index.js';

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

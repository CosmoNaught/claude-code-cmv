import { analyzeSession } from './analyzer.js';
import type { SessionAnalysis } from '../types/index.js';

// Anthropic prompt caching pricing (per million tokens)
// https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
// Multipliers: cache write = 1.25x base, cache read = 0.1x base
const PRICING = {
  sonnet:   { name: 'Sonnet 4',    input: 3.00,  cacheWrite: 3.75,  cacheRead: 0.30 },
  opus:     { name: 'Opus 4.6',    input: 5.00,  cacheWrite: 6.25,  cacheRead: 0.50 },
  'opus-4': { name: 'Opus 4/4.1',  input: 15.00, cacheWrite: 18.75, cacheRead: 1.50 },
  haiku:    { name: 'Haiku 4.5',   input: 1.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
} as const;

type ModelKey = keyof typeof PRICING;

export interface CacheImpactReport {
  model: ModelKey;
  modelDisplayName: string;
  inputPricePerMTok: number;

  preTrimTokens: number;
  postTrimTokens: number;
  reductionPercent: number;

  cacheHitRate: number;

  // Per-turn costs in dollars (input tokens only)
  preTrimCostPerTurn: number;
  postTrimFirstTurnCost: number;
  postTrimSteadyCostPerTurn: number;

  cacheMissPenalty: number;
  savingsPerTurn: number;
  breakEvenTurns: number;

  projections: Array<{
    turns: number;
    withoutTrim: number;
    withTrim: number;
    savedPercent: number;
  }>;

  // Source data for display
  breakdown: SessionAnalysis['breakdown'];
}

/**
 * Estimate post-trim token count from the session analysis breakdown.
 *
 * Trim rules (mirrors trimmer.ts):
 *   1. Pre-compaction content → skipped entirely
 *   2. file-history-snapshot → removed entirely
 *   3. queue-operation → removed entirely
 *   4. Image blocks in tool results → stripped always
 *   5. tool_result > threshold → stubbed (~35 bytes each)
 *   6. tool_use input for write ops + broad fallback → stubbed
 *   7. thinking blocks → removed entirely
 *   8. API usage metadata → stripped
 *
 * We estimate that ~70% of tool result bytes come from results > 500 chars
 * (conservative — real sessions often see 85-95%).
 * We estimate ~30% of tool_use request bytes are from stubbable input fields
 * (Write/Edit payloads, Task prompts, etc.).
 */
export function estimatePostTrimTokens(analysis: SessionAnalysis): number {
  const { breakdown, estimatedTokens, totalBytes } = analysis;

  if (totalBytes === 0) return estimatedTokens;

  // Bytes removed by trim
  const removedBytes =
    breakdown.fileHistory.bytes +
    breakdown.thinkingSignatures.bytes +
    (breakdown.toolResults.bytes * 0.7) -
    (breakdown.toolResults.count * 35) + // stub overhead added back
    (breakdown.toolUseRequests.bytes * 0.3); // ~30% of tool_use bytes are stubbable inputs

  const removalRatio = Math.max(0, Math.min(0.95, removedBytes / totalBytes));

  // System overhead (20k tokens for system prompt + tools) is constant
  const SYSTEM_OVERHEAD = 20_000;
  const contentTokens = Math.max(0, estimatedTokens - SYSTEM_OVERHEAD);
  const trimmedContentTokens = Math.round(contentTokens * (1 - removalRatio));

  return trimmedContentTokens + SYSTEM_OVERHEAD;
}

/**
 * Cost of one turn with a warm cache (steady state).
 * Cached prefix → cache read rate, new tokens → cache write rate.
 */
function steadyStateCost(
  totalTokens: number,
  cacheHitRate: number,
  pricing: typeof PRICING[ModelKey],
): number {
  const cachedTokens = totalTokens * cacheHitRate;
  const newTokens = totalTokens * (1 - cacheHitRate);

  return (
    (cachedTokens / 1_000_000) * pricing.cacheRead +
    (newTokens / 1_000_000) * pricing.cacheWrite
  );
}

/**
 * Cost of one turn with a cold cache (full miss — everything written fresh).
 */
function coldCacheCost(
  totalTokens: number,
  pricing: typeof PRICING[ModelKey],
): number {
  return (totalTokens / 1_000_000) * pricing.cacheWrite;
}

/**
 * Run a full cache impact analysis on a session JSONL file.
 *
 * @param jsonlPath  Path to the session JSONL
 * @param model      Pricing model (default: sonnet)
 * @param cacheHitRate  Fraction of tokens served from cache in steady state (default: 0.90)
 */
export async function analyzeCacheImpact(
  jsonlPath: string,
  model: ModelKey = 'sonnet',
  cacheHitRate: number = 0.90,
): Promise<CacheImpactReport> {
  const analysis = await analyzeSession(jsonlPath);
  const pricing = PRICING[model];

  const preTrimTokens = analysis.estimatedTokens;
  const postTrimTokens = estimatePostTrimTokens(analysis);

  const preTrimCost = steadyStateCost(preTrimTokens, cacheHitRate, pricing);
  const postTrimFirstCost = coldCacheCost(postTrimTokens, pricing);
  const postTrimSteadyCost = steadyStateCost(postTrimTokens, cacheHitRate, pricing);

  const penalty = postTrimFirstCost - preTrimCost;
  const savings = preTrimCost - postTrimSteadyCost;
  const breakEven = savings > 0 ? Math.ceil(penalty / savings) + 1 : Infinity;

  // Projections
  const projectionTurns = [5, 10, 20, 50];
  const projections = projectionTurns.map(turns => {
    const withoutTrim = preTrimCost * turns;
    const withTrim = postTrimFirstCost + postTrimSteadyCost * (turns - 1);
    const savedPercent = withoutTrim > 0
      ? Math.round(((withoutTrim - withTrim) / withoutTrim) * 100)
      : 0;
    return { turns, withoutTrim, withTrim, savedPercent };
  });

  return {
    model,
    modelDisplayName: pricing.name,
    inputPricePerMTok: pricing.input,
    preTrimTokens,
    postTrimTokens,
    reductionPercent: preTrimTokens > 0
      ? Math.round(((preTrimTokens - postTrimTokens) / preTrimTokens) * 100)
      : 0,
    cacheHitRate,
    preTrimCostPerTurn: preTrimCost,
    postTrimFirstTurnCost: postTrimFirstCost,
    postTrimSteadyCostPerTurn: postTrimSteadyCost,
    cacheMissPenalty: penalty,
    savingsPerTurn: savings,
    breakEvenTurns: breakEven,
    projections,
    breakdown: analysis.breakdown,
  };
}

export { ModelKey, PRICING };

import { Command } from 'commander';
import chalk from 'chalk';
import { analyzeCacheImpact, type CacheImpactReport, type ModelKey } from '../core/cache-analyzer.js';
import { findSession, getLatestSession, getSessionJsonlPath } from '../core/session-reader.js';
import { handleError } from '../utils/errors.js';
import { info, dim } from '../utils/display.js';

function $(n: number): string {
  return `$${n.toFixed(4)}`;
}

function tok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pct(n: number): string {
  return `${n}%`;
}

function padR(s: string, w: number): string {
  return s.padEnd(w);
}

function padL(s: string, w: number): string {
  return s.padStart(w);
}

// ── Bar chart helpers ──────────────────────────────────────────────

const BAR_WIDTH = 30;
const BLOCK_FULL = '█';
const BLOCK_EMPTY = '░';

/** Render a horizontal bar: ████████░░░░░░░░░░ */
function bar(fraction: number, width: number = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return BLOCK_FULL.repeat(filled) + BLOCK_EMPTY.repeat(empty);
}

/** Render a comparison bar pair (before/after) with labels */
function comparisonBars(
  label1: string,
  val1: number,
  label2: string,
  val2: number,
  maxVal: number,
  fmt: (n: number) => string,
  color1: (s: string) => string,
  color2: (s: string) => string,
): string[] {
  const labelWidth = Math.max(label1.length, label2.length);
  const f1 = maxVal > 0 ? val1 / maxVal : 0;
  const f2 = maxVal > 0 ? val2 / maxVal : 0;
  return [
    `  ${padR(label1, labelWidth)}  ${color1(bar(f1))}  ${fmt(val1)}`,
    `  ${padR(label2, labelWidth)}  ${color2(bar(f2))}  ${fmt(val2)}`,
  ];
}

function renderReport(r: CacheImpactReport, sessionId: string): void {
  const divider = chalk.dim('━'.repeat(56));

  console.log();
  console.log(chalk.bold('  CMV Cache Impact Analysis'));
  console.log(`  ${divider}`);
  console.log(`  Session:    ${dim(sessionId.slice(0, 12) + '...')}`);
  console.log(`  Model:      ${r.modelDisplayName} (${$(r.inputPricePerMTok)}/MTok input)`);
  console.log(`  Cache rate: ${pct(Math.round(r.cacheHitRate * 100))} (assumed steady-state hit rate)`);
  console.log();

  // ── Context usage bars ──
  console.log(chalk.bold('  Context Window'));
  const preUsage = r.preTrimTokens / 200_000;
  const postUsage = r.postTrimTokens / 200_000;
  console.log(`  Before  ${chalk.yellow(bar(preUsage))}  ${chalk.yellow(tok(r.preTrimTokens))} ${dim(`(${pct(Math.round(preUsage * 100))})`)}`);
  console.log(`  After   ${chalk.green(bar(postUsage))}  ${chalk.green(tok(r.postTrimTokens))} ${dim(`(${pct(Math.round(postUsage * 100))})`)}`);
  console.log(`  ${dim('          ' + '╰' + '─'.repeat(BAR_WIDTH - 1) + '╯ 200k limit')}`);
  console.log(`  Reduction: ${chalk.green(pct(r.reductionPercent))}`);
  console.log();

  // ── What gets trimmed ──
  const bd = r.breakdown;
  const totalTrimmable = bd.toolResults.percent + bd.thinkingSignatures.percent + bd.fileHistory.percent;
  const kept = 100 - totalTrimmable;
  console.log(chalk.bold('  Context Breakdown'));

  // Stacked composition bar
  const compW = 40;
  const trBlocks = Math.round((bd.toolResults.percent / 100) * compW);
  const thBlocks = Math.round((bd.thinkingSignatures.percent / 100) * compW);
  const fhBlocks = Math.round((bd.fileHistory.percent / 100) * compW);
  const kvBlocks = Math.max(0, compW - trBlocks - thBlocks - fhBlocks);
  const compositionBar =
    chalk.red(BLOCK_FULL.repeat(trBlocks)) +
    chalk.magenta(BLOCK_FULL.repeat(thBlocks)) +
    chalk.blue(BLOCK_FULL.repeat(fhBlocks)) +
    chalk.green(BLOCK_FULL.repeat(kvBlocks));
  console.log(`  ${compositionBar}`);
  console.log(`  ${chalk.red('■')} Tool results        ${padL(pct(bd.toolResults.percent), 4)}  ${dim(`(${bd.toolResults.count} results)`)}`);
  console.log(`  ${chalk.magenta('■')} Thinking blocks   ${padL(pct(bd.thinkingSignatures.percent), 4)}  ${dim(`(${bd.thinkingSignatures.count} blocks)`)}`);
  console.log(`  ${chalk.blue('■')} File-history        ${padL(pct(bd.fileHistory.percent), 4)}  ${dim(`(${bd.fileHistory.count} entries)`)}`);
  console.log(`  ${chalk.green('■')} Kept (conversation) ${padL(pct(kept), 4)}`);
  console.log();

  // ── Cost per turn bars ──
  // Scale steady-state bars against each other (not against the cache miss spike)
  console.log(chalk.bold('  Cost Per Turn (input tokens)'));
  const steadyMax = r.preTrimCostPerTurn;
  const steadyLines = comparisonBars(
    'No trim', r.preTrimCostPerTurn,
    'Trimmed', r.postTrimSteadyCostPerTurn,
    steadyMax, $,
    chalk.yellow, chalk.green,
  );
  for (const l of steadyLines) console.log(l);
  // First turn at separate scale — always a full bar to show the spike
  const missMultiple = r.preTrimCostPerTurn > 0
    ? `${(r.postTrimFirstTurnCost / r.preTrimCostPerTurn).toFixed(1)}x`
    : '';
  console.log(`  ${padR('1st turn', 7)}  ${chalk.red(bar(1.0))}  ${chalk.red($(r.postTrimFirstTurnCost))} ${dim(`(cache miss — ${missMultiple} of normal)`)}`);
  console.log();
  console.log(`  Cache miss penalty:  ${$(r.cacheMissPenalty)}`);
  console.log(`  Savings per turn:    ${chalk.green($(r.savingsPerTurn))}`);

  if (r.breakEvenTurns === Infinity) {
    console.log(`  Break-even:          ${chalk.red('N/A (no savings)')}`);
  } else {
    console.log(`  Break-even:          ${chalk.green(String(r.breakEvenTurns) + ' turns')}`);
  }
  console.log();

  // ── Cumulative cost projection with bars ──
  console.log(chalk.bold('  Cumulative Cost Projection'));
  const maxProj = Math.max(...r.projections.map(p => Math.max(p.withoutTrim, p.withTrim)));
  console.log(chalk.dim(`  ${padR('Turns', 7)} ${padR('No Trim', 10)} ${padR('With Trim', 10)} ${padR('Saved', 7)}  Visual`));
  console.log(chalk.dim('  ' + '─'.repeat(62)));

  for (const p of r.projections) {
    const savColor = p.savedPercent > 0 ? chalk.green : chalk.red;
    const projBarW = 16;
    const noTrimBar = chalk.yellow(bar(p.withoutTrim / maxProj, projBarW));
    const trimBar = (p.savedPercent > 0 ? chalk.green : chalk.red)(bar(p.withTrim / maxProj, projBarW));
    console.log(
      `  ${padR(String(p.turns), 7)} ${padR($(p.withoutTrim), 10)} ${padR($(p.withTrim), 10)} ${savColor(padR(pct(p.savedPercent), 7))}  ${noTrimBar} ${dim('vs')} ${trimBar}`,
    );
  }

  console.log();

  // ── Verdict ──
  if (r.breakEvenTurns <= 5 && r.breakEvenTurns !== Infinity) {
    const proj20 = r.projections.find(p => p.turns === 20);
    const longTermSavings = proj20 ? pct(proj20.savedPercent) : pct(r.reductionPercent);
    console.log(
      chalk.green(`  ✓ Verdict: Trim pays for itself in ${r.breakEvenTurns} turns.`) +
      ` Net ${longTermSavings} savings on input costs over 20 turns.`,
    );
  } else if (r.breakEvenTurns <= 15) {
    console.log(
      chalk.yellow(`  ~ Verdict: Trim breaks even after ${r.breakEvenTurns} turns.`) +
      ' Worth it for longer sessions.',
    );
  } else {
    console.log(
      chalk.red('  ✗ Verdict: Minimal context bloat — trim not needed for this session.'),
    );
  }

  console.log();
  console.log(dim('  Assumptions: prompt caching enabled, ' +
    `${pct(Math.round(r.cacheHitRate * 100))} steady-state cache hit rate,`));
  console.log(dim('  input tokens only (excludes output tokens and system overhead).'));
  console.log();
}

function renderJson(r: CacheImpactReport): void {
  console.log(JSON.stringify(r, null, 2));
}

export function registerBenchmarkCommand(program: Command): void {
  program
    .command('benchmark')
    .description('Analyze cache impact of trimming a session')
    .option('-s, --session <id>', 'Session ID to analyze')
    .option('--latest', 'Analyze the most recently modified session')
    .option('-m, --model <model>', 'Pricing model: sonnet, opus, opus-4, haiku', 'sonnet')
    .option('-c, --cache-rate <percent>', 'Cache hit rate 0-100 (default: 90)', '90')
    .option('--json', 'Output raw JSON')
    .action(async (opts: {
      session?: string;
      latest?: boolean;
      model?: string;
      cacheRate?: string;
      json?: boolean;
    }) => {
      try {
        if (!opts.session && !opts.latest) {
          console.error('Must provide --session <id> or --latest');
          process.exit(1);
        }

        const model = (opts.model || 'sonnet') as ModelKey;
        if (!['sonnet', 'opus', 'opus-4', 'haiku'].includes(model)) {
          console.error(`Invalid model "${model}". Use: sonnet, opus, opus-4, haiku`);
          process.exit(1);
        }

        const cacheRate = Math.max(0, Math.min(100, parseInt(opts.cacheRate || '90', 10))) / 100;

        // Resolve session
        let session;
        if (opts.latest) {
          session = await getLatestSession();
          if (!session) {
            throw new Error('No sessions found.');
          }
        } else {
          session = await findSession(opts.session!);
          if (!session) {
            throw new Error(`Session "${opts.session}" not found.`);
          }
        }

        const jsonlPath = getSessionJsonlPath(session);

        if (!opts.json) {
          info('Analyzing session...');
        }

        const report = await analyzeCacheImpact(jsonlPath, model, cacheRate);

        if (opts.json) {
          renderJson(report);
        } else {
          renderReport(report, session.sessionId);
        }
      } catch (err) {
        handleError(err);
      }
    });
}

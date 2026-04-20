/**
 * MCTS health probe for the focus power.
 *
 * Plays N self-play games. At every decision the target power faces, calls
 * probeMctsSearch to record MCTS tree statistics. Aggregates across all calls
 * to answer: is search hitting its cap? does the tree go deep? does search
 * actually disagree with the policy prior?
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/probe-mcts-health.ts \
 *     [--power tenzen] [--games 5] [--time 300] [--iter 100000] [--seed 1]
 */

import {
  createInitialState, applyAction, autoAdvance, GameLog,
} from '@ruin/engine';

function isTerminal(state: GameState): boolean {
  return state.winners !== null || state.phase === 'completed';
}
import { probeMctsSearch, modelForPowerLoaded, type TreeProbeStats } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1]! : def;
  };
  return {
    power: get('--power', 'tenzen') as Power,
    games: parseInt(get('--games', '5'), 10),
    timeMs: parseInt(get('--time', '300'), 10),
    iters: parseInt(get('--iter', '100000'), 10),
    seed: parseInt(get('--seed', '1'), 10),
    opponentTimeMs: parseInt(get('--opp-time', '80'), 10),
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i]!;
}

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return 'NaN';
  return n.toFixed(digits);
}

function pct(num: number, total: number): string {
  return total === 0 ? '—' : `${((num / total) * 100).toFixed(0)}%`;
}

async function main() {
  const opts = parseArgs();
  loadLearnedModelIfPresent();

  const hasPerPower = modelForPowerLoaded(opts.power);
  console.log(`\n=== MCTS health probe ===`);
  console.log(`power:               ${opts.power}`);
  console.log(`per-power model:     ${hasPerPower ? 'loaded (AZ-style select on)' : 'shared model (classic select)'}`);
  console.log(`time budget:         ${opts.timeMs}ms / ${opts.iters} iters (target)`);
  console.log(`opponent time:       ${opts.opponentTimeMs}ms (games only, not part of stats)`);
  console.log(`games:               ${opts.games}, base seed ${opts.seed}`);

  const samples: TreeProbeStats[] = [];

  for (let g = 0; g < opts.games; g++) {
    const seed = opts.seed + g;
    let state: GameState = createInitialState({
      gameId: `probe-${seed}`,
      activePowers: POWERS,
      playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
      seed,
    });
    ({ state } = autoAdvance({ state, log: new GameLog() }));

    let safety = 0;
    while (!isTerminal(state) && safety < 2000) {
      safety++;
      const pending = state.pendingAction;
      if (!pending) {
        ({ state } = autoAdvance({ state, log: new GameLog() }));
        continue;
      }
      const actor = pending.waitingFor;
      const isTarget = actor === opts.power;
      const budget = isTarget
        ? { timeMs: opts.timeMs, iterations: opts.iters }
        : { timeMs: opts.opponentTimeMs, iterations: opts.iters };
      const stats = probeMctsSearch(state, actor, budget);
      if (isTarget) samples.push(stats);
      ({ state } = applyAction(state, stats.action));
      ({ state } = autoAdvance({ state, log: new GameLog() }));
    }

    process.stdout.write(`  game ${g + 1}/${opts.games}: ${samples.length} ${opts.power} decisions sampled\r`);
  }
  console.log('');

  if (samples.length === 0) {
    console.log('(no samples collected — target power never acted)');
    return;
  }

  const nontrivial = samples.filter(s => s.rootLegalActions > 1);

  console.log(`\nsamples: ${samples.length} total, ${nontrivial.length} nontrivial (>1 legal action)`);

  // ── Search saturation ────────────────────────────────────────────────────
  const iters = nontrivial.map(s => s.iterations);
  const times = nontrivial.map(s => s.timeMs);
  const timeCapped = nontrivial.filter(s => s.hitTimeCap).length;
  const iterCapped = nontrivial.filter(s => s.hitIterCap).length;
  console.log('\n── Search saturation ─────────────────────────');
  console.log(`iters  : mean ${fmt(mean(iters), 0)}  p50 ${percentile(iters, 0.5)}  p90 ${percentile(iters, 0.9)}  max ${Math.max(...iters)}`);
  console.log(`time   : mean ${fmt(mean(times), 0)}ms  p50 ${percentile(times, 0.5)}ms  p90 ${percentile(times, 0.9)}ms  max ${Math.max(...times)}ms`);
  console.log(`capped : time ${timeCapped}/${nontrivial.length} (${pct(timeCapped, nontrivial.length)}), iter ${iterCapped}/${nontrivial.length} (${pct(iterCapped, nontrivial.length)})`);

  // ── Tree depth ───────────────────────────────────────────────────────────
  const maxDepths = nontrivial.map(s => s.maxDepth);
  const avgDepths = nontrivial.map(s => s.avgLeafDepth);
  console.log('\n── Tree depth ────────────────────────────────');
  console.log(`max depth  : mean ${fmt(mean(maxDepths))}  p50 ${percentile(maxDepths, 0.5)}  max ${Math.max(...maxDepths)}`);
  console.log(`avg depth  : mean ${fmt(mean(avgDepths))}  p50 ${fmt(percentile(avgDepths, 0.5))}`);
  const depth1 = nontrivial.filter(s => s.maxDepth <= 1).length;
  const depth2 = nontrivial.filter(s => s.maxDepth === 2).length;
  const depthGe3 = nontrivial.filter(s => s.maxDepth >= 3).length;
  console.log(`distribution: depth≤1 ${pct(depth1, nontrivial.length)}  depth=2 ${pct(depth2, nontrivial.length)}  depth≥3 ${pct(depthGe3, nontrivial.length)}`);

  // ── Root coverage ────────────────────────────────────────────────────────
  const legal = nontrivial.map(s => s.rootLegalActions);
  const expanded = nontrivial.map(s => s.rootChildrenExpanded);
  const untried = nontrivial.map(s => s.rootUntriedRemaining);
  const coverage = nontrivial.map(s => s.rootChildrenExpanded / s.rootLegalActions);
  const starved = nontrivial.filter(s => s.rootUntriedRemaining > 0).length;
  console.log('\n── Root coverage ─────────────────────────────');
  console.log(`legal actions : mean ${fmt(mean(legal))}  max ${Math.max(...legal)}`);
  console.log(`expanded      : mean ${fmt(mean(expanded))}  p50 ${percentile(expanded, 0.5)}`);
  console.log(`untried left  : mean ${fmt(mean(untried))}  p50 ${percentile(untried, 0.5)}  max ${Math.max(...untried)}`);
  console.log(`coverage      : mean ${(mean(coverage) * 100).toFixed(0)}%  (starved: ${starved}/${nontrivial.length} = ${pct(starved, nontrivial.length)} had untried root actions)`);

  // ── Policy vs search agreement ───────────────────────────────────────────
  const withPriors = nontrivial.filter(s => Number.isFinite(s.priorEntropy));
  if (withPriors.length > 0) {
    const agreed = withPriors.filter(s => s.priorVisitAgree).length;
    const kls = withPriors.map(s => s.klVisitToPrior).filter(Number.isFinite);
    const visH = withPriors.map(s => s.visitEntropy);
    const priH = withPriors.map(s => s.priorEntropy);
    console.log('\n── Policy vs search ──────────────────────────');
    console.log(`samples with priors     : ${withPriors.length}/${nontrivial.length}`);
    console.log(`top-1 agreement          : ${pct(agreed, withPriors.length)}  (high = search echoes policy, low = search overrides)`);
    console.log(`KL( visits || prior )    : mean ${fmt(mean(kls), 3)}  p50 ${fmt(percentile(kls, 0.5), 3)}  p90 ${fmt(percentile(kls, 0.9), 3)} bits`);
    console.log(`visit  entropy           : mean ${fmt(mean(visH), 2)} bits (visit distribution spread)`);
    console.log(`prior  entropy           : mean ${fmt(mean(priH), 2)} bits (policy spread)`);
  } else {
    console.log('\n── Policy vs search ──────────────────────────');
    console.log('(no policy head loaded — MCTS was running on pure UCB1)');
  }

  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });

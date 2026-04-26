/**
 * MCTS root-search behavior bucketed by game round.
 *
 * Plays N games. At every decision the target power faces, runs MCTS with
 * the configured budget and records (round, visit-entropy, top-visit
 * fraction, max depth, root coverage). Aggregates per round to expose
 * "early game search vs mid game search" differences.
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/probe-by-round.ts \
 *     [--power tenzen] [--games 5] [--iter 3000]
 */

import { createInitialState, applyAction, autoAdvance, GameLog } from '@ruin/engine';
import { probeMctsSearch, type TreeProbeStats } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

function isTerminal(state: GameState): boolean {
  return state.winners !== null || state.phase === 'completed';
}

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
    iters: parseInt(get('--iter', '3000'), 10),
    iterOpp: parseInt(get('--iter-opp', '1000'), 10),
    seed: parseInt(get('--seed', '1'), 10),
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'NaN';
}

interface Sample extends TreeProbeStats {
  round: number;
}

async function main() {
  const opts = parseArgs();
  loadLearnedModelIfPresent();

  console.log(`\n=== MCTS by-round probe ===`);
  console.log(`power: ${opts.power}  games: ${opts.games}  iters: ${opts.iters} (opp ${opts.iterOpp})`);

  const samples: Sample[] = [];

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
    while (!isTerminal(state) && safety < 3000) {
      safety++;
      const pending = state.pendingAction;
      if (!pending) {
        ({ state } = autoAdvance({ state, log: new GameLog() }));
        continue;
      }
      const actor = pending.waitingFor;
      const isTarget = actor === opts.power;
      const budget = { iterations: isTarget ? opts.iters : opts.iterOpp, timeMs: 999999 };
      const stats = probeMctsSearch(state, actor, budget);
      if (isTarget) samples.push({ ...stats, round: state.round });
      ({ state } = applyAction(state, stats.action));
      ({ state } = autoAdvance({ state, log: new GameLog() }));
    }
    process.stdout.write(`  game ${g + 1}/${opts.games}: ${samples.length} samples\r`);
  }
  console.log('');

  if (samples.length === 0) {
    console.log('(no samples)');
    return;
  }

  // Bucket by round
  const byRound = new Map<number, Sample[]>();
  for (const s of samples) {
    if (!byRound.has(s.round)) byRound.set(s.round, []);
    byRound.get(s.round)!.push(s);
  }

  const sortedRounds = [...byRound.keys()].sort((a, b) => a - b);

  console.log(`\nsamples: ${samples.length} total across ${sortedRounds.length} rounds\n`);

  // Header
  console.log('round  n   legal   exp%   topVisit%  visitEntropy  priorEntropy  maxDepth  avgLeafDepth');
  console.log('─────  ──  ─────   ────   ─────────  ────────────  ────────────  ────────  ────────────');

  for (const r of sortedRounds) {
    const rs = byRound.get(r)!.filter(s => s.rootLegalActions > 1);
    if (rs.length === 0) continue;
    const legal = mean(rs.map(s => s.rootLegalActions));
    const expanded = mean(rs.map(s => s.rootLegalActions > 0 ? s.rootChildrenExpanded / s.rootLegalActions : 0));
    const topVisitPct = mean(rs.map(s => {
      const total = s.rootActions.reduce((a, b) => a + b.visits, 0);
      const top = Math.max(...s.rootActions.map(b => b.visits));
      return total > 0 ? top / total : 0;
    }));
    const visitEnt = mean(rs.map(s => s.visitEntropy));
    const priorEnt = mean(rs.map(s => s.priorEntropy).filter(x => Number.isFinite(x)));
    const maxDepth = mean(rs.map(s => s.maxDepth));
    const avgLeafDepth = mean(rs.map(s => s.avgLeafDepth));

    console.log(
      `${String(r).padStart(5)}  ${String(rs.length).padStart(2)}  ${fmt(legal, 1).padStart(5)}   ` +
      `${fmt(expanded * 100, 0).padStart(4)}%  ${fmt(topVisitPct * 100, 1).padStart(8)}%   ` +
      `${fmt(visitEnt).padStart(10)}    ${fmt(priorEnt).padStart(10)}     ${fmt(maxDepth, 1).padStart(6)}    ${fmt(avgLeafDepth)}`,
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });

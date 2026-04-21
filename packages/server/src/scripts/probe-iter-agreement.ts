/**
 * Do 2k iters and 10k iters produce the same chosen action, or does deeper
 * search find something different?
 *
 * For each state, runs MCTS (no Dirichlet noise, deterministic) at multiple
 * iter counts and records the top-visit action. Reports cross-iter agreement
 * vs the 10k-iter "reference answer."
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/probe-iter-agreement.ts \
 *     [--states 20] [--iters 200,500,1000,2000,5000,10000]
 */

import {
  createInitialState, applyAction, autoAdvance, GameLog,
} from '@ruin/engine';
import { probeMctsSearch } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

function isTerminal(state: GameState): boolean {
  return state.winners !== null || state.phase === 'completed';
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1]! : def;
  };
  return {
    power: get('--power', 'tenzen') as Power,
    states: parseInt(get('--states', '20'), 10),
    iters: get('--iters', '200,500,1000,2000,5000,10000').split(',').map(s => parseInt(s, 10)),
    timeMs: parseInt(get('--time', '120000'), 10),
    seed: parseInt(get('--seed', '1'), 10),
    skipN: parseInt(get('--skip', '5'), 10),
  };
}

function stateAtNthTargetDecision(
  baseSeed: number, targetPower: Power, n: number,
): GameState | null {
  let state: GameState = createInitialState({
    gameId: `iter-probe-${baseSeed}`,
    activePowers: POWERS,
    playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
    seed: baseSeed,
  });
  ({ state } = autoAdvance({ state, log: new GameLog() }));
  let seen = 0;
  let safety = 0;
  while (!isTerminal(state) && safety < 2000) {
    safety++;
    const pending = state.pendingAction;
    if (!pending) { ({ state } = autoAdvance({ state, log: new GameLog() })); continue; }
    if (pending.waitingFor === targetPower) {
      if (seen === n) return state;
      seen++;
    }
    const cheap = probeMctsSearch(state, pending.waitingFor, { iterations: 500, timeMs: 20000 });
    ({ state } = applyAction(state, cheap.action));
    ({ state } = autoAdvance({ state, log: new GameLog() }));
  }
  return null;
}

async function main() {
  const opts = parseArgs();
  loadLearnedModelIfPresent();

  console.log(`\n=== Iter-count action agreement probe ===`);
  console.log(`power:  ${opts.power}`);
  console.log(`states: ${opts.states}`);
  console.log(`iters:  ${opts.iters.join(', ')}`);
  console.log(`NO Dirichlet noise (deterministic within each iter count)\n`);

  // Fetch states.
  const states: GameState[] = [];
  for (let s = 0; s < opts.states; s++) {
    const st = stateAtNthTargetDecision(opts.seed + s * 1000, opts.power, opts.skipN);
    if (!st) continue;
    states.push(st);
  }
  console.log(`collected ${states.length} states\n`);

  // For each state, get chosen action at each iter count.
  // chosenSlots[stateIdx][iterIdx] = canonical slot chosen
  const chosenSlots: number[][] = [];
  for (let s = 0; s < states.length; s++) {
    process.stdout.write(`state ${s}: `);
    const row: number[] = [];
    for (const iter of opts.iters) {
      const stats = probeMctsSearch(states[s]!, opts.power, {
        iterations: iter,
        timeMs: opts.timeMs,
        // no dirichletNoise — deterministic
      });
      // Find the top-visit action's canonical slot.
      let topSlot = -1, topVisits = -1;
      for (const a of stats.rootActions) {
        if (a.visits > topVisits) { topVisits = a.visits; topSlot = a.slotIdx; }
      }
      row.push(topSlot);
      process.stdout.write(`${iter}:${topSlot} `);
    }
    console.log('');
    chosenSlots.push(row);
  }

  // Compare each iter count to the 10k-reference answer (last column).
  const refIdx = opts.iters.length - 1;
  console.log(`\n── agreement with iter=${opts.iters[refIdx]} reference ──`);
  for (let i = 0; i < opts.iters.length; i++) {
    let agree = 0;
    for (const row of chosenSlots) {
      if (row[i] === row[refIdx]) agree++;
    }
    const pct = (100 * agree / chosenSlots.length).toFixed(0);
    console.log(`  iter=${String(opts.iters[i]).padStart(6)}: ${pct}% (${agree}/${chosenSlots.length})`);
  }

  // Also: for each pair of iter counts, agreement rate.
  console.log(`\n── pairwise agreement matrix ──`);
  const header = '         ' + opts.iters.map(i => String(i).padStart(6)).join(' ');
  console.log(header);
  for (let i = 0; i < opts.iters.length; i++) {
    const row = [String(opts.iters[i]).padStart(6), ' '];
    for (let j = 0; j < opts.iters.length; j++) {
      let a = 0;
      for (const r of chosenSlots) if (r[i] === r[j]) a++;
      const pct = Math.round(100 * a / chosenSlots.length);
      row.push(String(pct).padStart(5) + '%');
    }
    console.log(row.join(' '));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

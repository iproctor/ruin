/**
 * AI benchmark: runs N headless games and reports win rates per power.
 * Usage (from repo root): pnpm benchmark [--games 20] [--players 2|3|4] [--seed 42]
 */

import {
  createInitialState, applyAction, getLegalActions, autoAdvance,
} from '@ruin/engine';
import { runMcts, greedyAction } from '@ruin/ai';
import type { Power, Action } from '@ruin/engine';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const gameCount = parseInt(getArg('--games', '20'), 10);
const playerCount = parseInt(getArg('--players', '4'), 10) as 2 | 3 | 4;
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const activePowers = ALL_POWERS.slice(0, playerCount);

// ── Stats ─────────────────────────────────────────────────────────────────────

const wins: Record<string, number> = Object.fromEntries(activePowers.map(p => [p, 0]));
const winConditions: Record<string, number> = {};
const roundCounts: number[] = [];
const errors: string[] = [];

// ── Run one game ──────────────────────────────────────────────────────────────

function runGame(seed: number): { winners: Power[]; winCondition: string; rounds: number } | { error: string } {
  let { state, log: _log } = autoAdvance({
    state: createInitialState({
      gameId: `bench-${seed}`,
      activePowers,
      playerTypes: Object.fromEntries(activePowers.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: [],
  });

  let actionCount = 0;

  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) {
      return { error: `Exceeded ${maxActions} actions (seed ${seed})` };
    }

    const pending = state.pendingAction;
    if (!pending) {
      return { error: `No pendingAction (phase: ${state.phase}, seed: ${seed})` };
    }

    const { waitingFor } = pending;
    let legalActions: Action[];
    try {
      legalActions = getLegalActions(state, waitingFor);
    } catch (err) {
      return { error: `getLegalActions threw for ${waitingFor}: ${err}` };
    }

    if (legalActions.length === 0) {
      return { error: `No legal actions for ${waitingFor} (${pending.actionKind}, seed: ${seed})` };
    }

    let action: Action;
    try {
      action = pending.actionKind === 'summoning_action'
        ? runMcts(state, waitingFor)
        : greedyAction(state, waitingFor);
    } catch (err) {
      return { error: `AI failed for ${waitingFor}: ${err}` };
    }

    try {
      const result = applyAction(state, action);
      state = result.state;
    } catch (err) {
      return { error: `applyAction threw: ${err}` };
    }

    actionCount++;
  }

  return {
    winners: (state.winners ?? []) as Power[],
    winCondition: state.winCondition ?? 'unknown',
    rounds: state.round,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== AI Benchmark ===`);
console.log(`Games: ${gameCount}  |  Players: ${activePowers.join(', ')}  |  Base seed: ${baseSeed}`);
console.log(`────────────────────────────────────────`);

const totalStart = Date.now();

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  const gameStart = Date.now();
  const result = runGame(seed);
  const elapsed = ((Date.now() - gameStart) / 1000).toFixed(1);

  if ('error' in result) {
    errors.push(result.error);
    console.log(`  Game ${String(i + 1).padStart(3)}/seed ${seed}: ERROR — ${result.error}`);
    continue;
  }

  const { winners, winCondition, rounds } = result;
  roundCounts.push(rounds);
  winConditions[winCondition] = (winConditions[winCondition] ?? 0) + 1;

  for (const w of winners) {
    wins[w] = (wins[w] ?? 0) + (1 / winners.length); // split credit for ties
  }

  const winnerStr = winners.join('+');
  console.log(`  Game ${String(i + 1).padStart(3)}/seed ${seed}: ${winnerStr.padEnd(14)} (${winCondition}, ${rounds}r, ${elapsed}s)`);
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
const completed = gameCount - errors.length;

console.log(`\n────────────────────────────────────────`);
console.log(`WIN RATES (${completed} completed games):`);

const sorted = Object.entries(wins).sort((a, b) => b[1] - a[1]);
for (const [power, w] of sorted) {
  const pct = completed > 0 ? ((w / completed) * 100).toFixed(1) : '0.0';
  const bar = '█'.repeat(Math.round(Number(pct) / 5));
  console.log(`  ${power.padEnd(8)} ${pct.padStart(5)}%  ${bar}`);
}

console.log(`\nWIN CONDITIONS:`);
for (const [cond, count] of Object.entries(winConditions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cond.padEnd(20)} ${count}x`);
}

if (roundCounts.length > 0) {
  const avg = (roundCounts.reduce((a, b) => a + b, 0) / roundCounts.length).toFixed(1);
  const min = Math.min(...roundCounts);
  const max = Math.max(...roundCounts);
  console.log(`\nROUNDS: avg ${avg}, min ${min}, max ${max}`);
}

if (errors.length > 0) {
  console.log(`\nERRORS (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
}

console.log(`\nTotal time: ${totalElapsed}s`);
console.log(`────────────────────────────────────────\n`);

/**
 * AI benchmark — runs N headless games and reports structured metrics:
 *
 *   - Win rate per power
 *   - Average rounds per game
 *   - DAC-per-round per power, capped at 1 per round per power (to reward
 *     engagement without biasing toward dial-rush strategies)
 *   - Xarm DAC rate (special metric — if near 0, xarm isn't attacking)
 *   - Game completion rate
 *
 * Usage (from repo root):
 *   pnpm benchmark [--games 20] [--seed 1] [--out metrics.json]
 */

import {
  createInitialState, applyAction, getLegalActions, autoAdvance,
} from '@ruin/engine';
import { runMcts, greedyAction } from '@ruin/ai';
import type { Power, Action } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';
import * as fs from 'node:fs';

loadLearnedModelIfPresent();

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const gameCount = parseInt(getArg('--games', '10'), 10);
const playerCount = parseInt(getArg('--players', '4'), 10) as 2 | 3 | 4;
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);
const outPath = getArg('--out', '');

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const activePowers = ALL_POWERS.slice(0, playerCount);

// ── Per-game runner ───────────────────────────────────────────────────────────

interface GameResult {
  winners: Power[];
  winCondition: string;
  rounds: number;
  // Round → Power → true if power earned ≥1 DAC that round (capped at 1)
  dacByRound: Record<number, Partial<Record<Power, boolean>>>;
  error?: string;
}

// Matches log lines like "norrsund: gormen earns a dial advancement counter."
const DAC_LOG_RE = /(xarm|gormen|tenzen|lasha) earns? a dial advancement counter/i;

function scanLogForDac(
  log: string[],
  round: number,
  dacByRound: Record<number, Partial<Record<Power, boolean>>>,
): void {
  for (const line of log) {
    const m = line.match(DAC_LOG_RE);
    if (m) {
      const p = m[1]!.toLowerCase() as Power;
      if (!dacByRound[round]) dacByRound[round] = {};
      dacByRound[round]![p] = true;
    }
  }
}

function runGame(seed: number): GameResult {
  const dacByRound: Record<number, Partial<Record<Power, boolean>>> = {};

  let { state, log: initialLog } = autoAdvance({
    state: createInitialState({
      gameId: `bench-${seed}`,
      activePowers,
      playerTypes: Object.fromEntries(activePowers.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: [],
  });

  // Scan initial setup log too — DAC may not fire there but be safe
  scanLogForDac(initialLog, state.round, dacByRound);

  let actionCount = 0;

  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) {
      return { winners: [], winCondition: 'timeout', rounds: state.round, dacByRound, error: `maxActions` };
    }
    const pending = state.pendingAction;
    if (!pending) {
      return { winners: [], winCondition: 'stuck', rounds: state.round, dacByRound, error: `no pendingAction` };
    }

    let legal: Action[];
    try {
      legal = getLegalActions(state, pending.waitingFor);
    } catch (err) {
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, error: `${err}` };
    }
    if (legal.length === 0) {
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, error: 'no legal actions' };
    }

    let action: Action;
    try {
      // Use MCTS for any decision where lookahead matters strategically.
      // - summoning_action: the main strategic phase
      // - battle_hit_assignment: per-(power, class) kill commitments
      // - dial_*: rewards from advancing the dial — affect long-term board state
      // - world_choice / world_card_effect: token placements that shape the game
      // - upgrade_choice: a permanent, game-changing choice
      // These are all infrequent enough that MCTS overhead is acceptable.
      const useMcts =
        pending.actionKind === 'summoning_action' ||
        pending.actionKind === 'battle_hit_assignment' ||
        pending.actionKind === 'dial_place_token' ||
        pending.actionKind === 'dial_remove_corruption' ||
        pending.actionKind === 'dial_remove_world_token' ||
        pending.actionKind === 'upgrade_choice' ||
        pending.actionKind === 'world_choice' ||
        pending.actionKind === 'hero_removal' ||
        pending.actionKind === 'corruption_harvest_choice' ||
        pending.actionKind === 'card_on_play_choice';
      action = useMcts
        ? runMcts(state, pending.waitingFor)
        : greedyAction(state, pending.waitingFor);
    } catch (err) {
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, error: `${err}` };
    }

    try {
      const result = applyAction(state, action);
      // Scan the log for DAC events. Doing this via the log (not via
      // dialCounters deltas) is the only correct way: corruption-phase
      // increments + end-phase reset happen inside one applyAction call,
      // so by the time we observe state, dialCounters is always 0 — hiding
      // all non-xarm DACs which are earned in the corruption phase.
      // Attribute to the pre-applyAction round (the round whose battle/
      // corruption phases produced the events).
      scanLogForDac(result.log, state.round, dacByRound);
      state = result.state;
    } catch (err) {
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, error: `${err}` };
    }

    actionCount++;
  }

  return {
    winners: (state.winners ?? []) as Power[],
    winCondition: state.winCondition ?? 'unknown',
    rounds: state.round,
    dacByRound,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== AI Benchmark ===`);
console.log(`Games: ${gameCount}  |  Players: ${activePowers.join(', ')}  |  Seed: ${baseSeed}`);
console.log(`────────────────────────────────────────`);

const totalStart = Date.now();
const wins: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
const winConditions: Record<string, number> = {};
const roundCounts: number[] = [];
// Sum of "rounds where power earned ≥1 DAC" across all games:
const dacRoundsByPower: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
const errors: string[] = [];
let completed = 0;

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  process.stdout.write(`  ${String(i + 1).padStart(3)}/${gameCount} seed ${seed}: `);
  const t0 = Date.now();
  const result = runGame(seed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.error) {
    errors.push(`seed ${seed}: ${result.error}`);
    console.log(`ERROR ${result.error} (${elapsed}s)`);
    continue;
  }
  if (result.winners.length === 0) {
    errors.push(`seed ${seed}: no winner (${result.winCondition})`);
    console.log(`NO WINNER (${elapsed}s)`);
    continue;
  }

  completed++;
  roundCounts.push(result.rounds);
  winConditions[result.winCondition] = (winConditions[result.winCondition] ?? 0) + 1;
  for (const w of result.winners) wins[w] += 1 / result.winners.length;

  // Tally DAC-rounds
  for (const roundKey of Object.keys(result.dacByRound)) {
    const bucket = result.dacByRound[parseInt(roundKey, 10)]!;
    for (const p of activePowers) {
      if (bucket[p]) dacRoundsByPower[p]++;
    }
  }

  // Short per-game DAC string: x/g/t/l counts over this game
  const thisGameDac: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
  for (const roundKey of Object.keys(result.dacByRound)) {
    const bucket = result.dacByRound[parseInt(roundKey, 10)]!;
    for (const p of activePowers) if (bucket[p]) thisGameDac[p]++;
  }
  const dacStr = `DAC:${thisGameDac.xarm}/${thisGameDac.gormen}/${thisGameDac.tenzen}/${thisGameDac.lasha}`;
  console.log(
    `${result.winners.join('+').padEnd(14)} ${result.winCondition.padEnd(16)} ${result.rounds}r ${dacStr} (${elapsed}s)`
  );
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);

console.log(`\n────────────────────────────────────────`);
console.log(`WIN RATES (${completed}/${gameCount} completed):`);
const sortedWins = Object.entries(wins).sort((a, b) => b[1] - a[1]);
for (const [power, w] of sortedWins) {
  const pct = completed > 0 ? ((w / completed) * 100).toFixed(1) : '0.0';
  const bar = '█'.repeat(Math.round(Number(pct) / 5));
  console.log(`  ${power.padEnd(8)} ${pct.padStart(5)}%  ${bar}`);
}

const avgRounds = roundCounts.length > 0
  ? roundCounts.reduce((a, b) => a + b, 0) / roundCounts.length
  : 0;
const totalRounds = roundCounts.reduce((a, b) => a + b, 0);

console.log(`\nDAC METRIC (rounds-with-DAC / total-rounds, capped at 1/round/power):`);
for (const p of activePowers) {
  const rate = totalRounds > 0 ? dacRoundsByPower[p] / totalRounds : 0;
  const bar = '█'.repeat(Math.round(rate * 20));
  const marker = p === 'xarm' ? ' ← xarm is critical' : '';
  console.log(`  ${p.padEnd(8)} ${(rate * 100).toFixed(1).padStart(5)}%  ${bar}${marker}`);
}

console.log(`\nROUNDS: avg ${avgRounds.toFixed(1)}, min ${Math.min(...roundCounts) || 0}, max ${Math.max(...roundCounts) || 0}`);
console.log(`\nWIN CONDITIONS:`);
for (const [c, n] of Object.entries(winConditions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(18)} ${n}`);
}

if (errors.length > 0) {
  console.log(`\nERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
  if (errors.length > 5) console.log(`  ... +${errors.length - 5} more`);
}
console.log(`\nTotal time: ${totalElapsed}s\n`);

// Optional JSON output for comparing runs
if (outPath) {
  const metrics = {
    games: gameCount,
    completed,
    winRates: Object.fromEntries(
      Object.entries(wins).map(([p, w]) => [p, completed > 0 ? w / completed : 0])
    ),
    dacRatePerPower: Object.fromEntries(
      Object.entries(dacRoundsByPower).map(([p, r]) => [p, totalRounds > 0 ? r / totalRounds : 0])
    ),
    avgRounds,
    winConditions,
    errors: errors.length,
    timeSeconds: parseFloat(totalElapsed),
  };
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
  console.log(`Metrics written to ${outPath}\n`);
}

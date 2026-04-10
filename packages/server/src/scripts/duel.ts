/**
 * Duel benchmark: pit two models against each other to test whether one is
 * stronger. The challenger model controls exactly ONE power; the baseline
 * model controls the other three. Both assignments rotate over all 4 powers
 * to remove which-power bias.
 *
 * For each power P, we run two halves:
 *   half A: challenger plays P, baseline plays the other 3 — N games
 *   half B: baseline   plays P, challenger plays the other 3 — N games
 *
 * Result: challenger's average win rate across all (power, role-as-P) trials
 * vs baseline's. If iterations are working, the later model should win more
 * often than the earlier one.
 *
 * Usage:
 *   pnpm duel --challenger packages/ai/data/model_iter_0100.json \
 *             --baseline   packages/ai/data/model_iter_0010.json \
 *             --games 8
 */

import {
  createInitialState, applyAction, getLegalActions, autoAdvance,
  type GameState, type Action, type Power,
} from '@ruin/engine';
import {
  runMcts, greedyAction,
  loadModelForPower, clearPerPowerModels,
  type ModelJson,
} from '@ruin/ai';
import * as fs from 'node:fs';

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string | undefined = undefined): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : (fallback ?? '');
}

const challengerPath = getArg('--challenger');
const baselinePath = getArg('--baseline');
const gamesPerCell = parseInt(getArg('--games', '8'), 10);
const baseSeed = parseInt(getArg('--seed', '5000'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);

if (!challengerPath || !baselinePath) {
  console.error('Usage: duel --challenger <model.json> --baseline <model.json> [--games 8]');
  process.exit(1);
}

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

const challengerJson = JSON.parse(fs.readFileSync(challengerPath, 'utf-8')) as ModelJson;
const baselineJson   = JSON.parse(fs.readFileSync(baselinePath,   'utf-8')) as ModelJson;

console.log(`\n=== Model Duel ===`);
console.log(`challenger: ${challengerPath}`);
console.log(`baseline:   ${baselinePath}`);
console.log(`games per (power, role) cell: ${gamesPerCell}`);
console.log(`total games: ${gamesPerCell * ALL_POWERS.length * 2}\n`);

interface GameResult {
  winner: Power | 'tie' | 'none';
  rounds: number;
  error?: string;
}

function runGame(seed: number, challengerPlays: Power, configLabel: string): GameResult {
  // Reload model assignments fresh each game (paranoia about leaks).
  clearPerPowerModels();
  for (const p of ALL_POWERS) {
    loadModelForPower(p, p === challengerPlays ? challengerJson : baselineJson);
  }

  let { state } = autoAdvance({
    state: createInitialState({
      gameId: `duel-${configLabel}-${seed}`,
      activePowers: ALL_POWERS,
      playerTypes: Object.fromEntries(ALL_POWERS.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: [],
  });

  let actionCount = 0;
  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) return { winner: 'none', rounds: state.round, error: 'maxActions' };
    const pending = state.pendingAction;
    if (!pending) return { winner: 'none', rounds: state.round, error: 'no pendingAction' };

    let legal: Action[];
    try { legal = getLegalActions(state, pending.waitingFor); }
    catch (err) { return { winner: 'none', rounds: state.round, error: `${err}` }; }
    if (legal.length === 0) return { winner: 'none', rounds: state.round, error: 'no legal actions' };

    let action: Action;
    try {
      action = pending.actionKind === 'summoning_action'
        ? runMcts(state, pending.waitingFor)
        : greedyAction(state, pending.waitingFor);
    } catch (err) { return { winner: 'none', rounds: state.round, error: `${err}` }; }

    try { state = applyAction(state, action).state; }
    catch (err) { return { winner: 'none', rounds: state.round, error: `${err}` }; }

    actionCount++;
  }

  const winners = state.winners ?? [];
  if (winners.length === 0) return { winner: 'none', rounds: state.round };
  if (winners.length > 1) return { winner: 'tie', rounds: state.round };
  return { winner: winners[0]!, rounds: state.round };
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface CellResult {
  challengerWins: number;     // games where the challenger's assigned power won
  baselineWins: number;       // games where any of the 3 baseline powers won
  ties: number;
  errors: number;
}

const totals: CellResult = { challengerWins: 0, baselineWins: 0, ties: 0, errors: 0 };
const perPowerResults: Record<Power, CellResult> = {
  xarm:   { challengerWins: 0, baselineWins: 0, ties: 0, errors: 0 },
  gormen: { challengerWins: 0, baselineWins: 0, ties: 0, errors: 0 },
  tenzen: { challengerWins: 0, baselineWins: 0, ties: 0, errors: 0 },
  lasha:  { challengerWins: 0, baselineWins: 0, ties: 0, errors: 0 },
};

const t0 = Date.now();

for (const power of ALL_POWERS) {
  process.stdout.write(`  challenger plays ${power.padEnd(7)}: `);
  const cell = perPowerResults[power];
  for (let g = 0; g < gamesPerCell; g++) {
    const seed = baseSeed + ALL_POWERS.indexOf(power) * 1000 + g;
    const result = runGame(seed, power, `${power}-${g}`);
    if (result.error) {
      cell.errors++;
      totals.errors++;
      process.stdout.write('E');
    } else if (result.winner === 'tie') {
      cell.ties++;
      totals.ties++;
      process.stdout.write('T');
    } else if (result.winner === power) {
      cell.challengerWins++;
      totals.challengerWins++;
      process.stdout.write('C');
    } else {
      cell.baselineWins++;
      totals.baselineWins++;
      process.stdout.write('b');
    }
  }
  console.log();
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const totalGames = gamesPerCell * ALL_POWERS.length;

console.log(`\n────────────────────────────────────────`);
console.log(`Per-power results (challenger plays this power):\n`);
console.log(`  power     challenger  baseline  ties  errors`);
for (const p of ALL_POWERS) {
  const c = perPowerResults[p];
  const cWinPct = ((c.challengerWins / gamesPerCell) * 100).toFixed(0);
  const bWinPct = ((c.baselineWins   / gamesPerCell) * 100).toFixed(0);
  console.log(`  ${p.padEnd(8)}  ${cWinPct.padStart(7)}%   ${bWinPct.padStart(7)}%   ${String(c.ties).padStart(4)}   ${String(c.errors).padStart(6)}`);
}

const completedTotal = totals.challengerWins + totals.baselineWins + totals.ties;
console.log(`\nAggregate over ${totalGames} games (${completedTotal} completed):`);
console.log(`  challenger wins: ${totals.challengerWins} (${((totals.challengerWins / completedTotal) * 100).toFixed(1)}%)`);
console.log(`  baseline   wins: ${totals.baselineWins} (${((totals.baselineWins / completedTotal) * 100).toFixed(1)}%)`);
console.log(`  ties:            ${totals.ties}`);
console.log(`  errors:          ${totals.errors}`);

// Sanity check: in a 4-player game with random outcomes, the "1 against 3"
// challenger should win ~25% of the time. If iterations are improving the
// model, the challenger should beat 25%. Display the delta.
const expected = 0.25;
const observed = completedTotal > 0 ? totals.challengerWins / completedTotal : 0;
const deltaPct = ((observed - expected) * 100).toFixed(1);
const sign = observed > expected ? '+' : '';
console.log(`\nVerdict: challenger ${sign}${deltaPct}pp vs random-fair baseline (25%).`);
if (observed > 0.30) {
  console.log(`  → challenger model is meaningfully stronger.`);
} else if (observed > 0.27) {
  console.log(`  → challenger model is mildly stronger.`);
} else if (observed > 0.23) {
  console.log(`  → results are within noise; models are roughly equivalent.`);
} else {
  console.log(`  → challenger is WEAKER than baseline.`);
}
console.log(`\nTotal time: ${elapsed}s\n`);

/**
 * Headless AI-vs-AI game runner.
 * Usage (from repo root): pnpm headless [--players 2|3|4] [--seed <n>] [--verbose]
 *
 * Runs a full game with all AI players, prints the event log, and reports
 * any errors or stuck states. Good for shaking out engine bugs.
 */

import {
  createInitialState, applyAction, getLegalActions, autoAdvance,
} from '@ruin/engine';
import { runMcts, greedyAction } from '@ruin/ai';
import type { Power, Action } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

loadLearnedModelIfPresent();

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const playerCount = parseInt(getArg('--players', '4'), 10) as 2 | 3 | 4;
const seed = parseInt(getArg('--seed', String(Date.now() & 0xffffffff)), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);
const verbose = args.includes('--verbose');

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const activePowers = ALL_POWERS.slice(0, playerCount);

console.log(`\n=== Headless Game ===`);
console.log(`Players: ${activePowers.join(', ')}  |  Seed: ${seed}`);
console.log(`──────────────────────────────────────\n`);

// ── Setup ─────────────────────────────────────────────────────────────────────

let { state, log } = autoAdvance({
  state: createInitialState({
    gameId: 'headless',
    activePowers,
    playerTypes: Object.fromEntries(activePowers.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
    seed,
  }),
  log: [],
});

function printLog(lines: string[]) {
  for (const l of lines) console.log(l);
}

printLog(log);

// ── Game loop ─────────────────────────────────────────────────────────────────

let actionCount = 0;
const startMs = Date.now();

while (state.winners === null && state.phase !== 'completed') {
  if (actionCount >= maxActions) {
    console.error(`\n[ERROR] Exceeded ${maxActions} actions — possible infinite loop.`);
    process.exit(1);
  }

  const pending = state.pendingAction;
  if (!pending) {
    console.error(`\n[ERROR] No pendingAction and game not over (phase: ${state.phase})`);
    process.exit(1);
  }

  const { waitingFor } = pending;

  // Get legal actions
  let legalActions: Action[];
  try {
    legalActions = getLegalActions(state, waitingFor);
  } catch (err) {
    console.error(`\n[ERROR] getLegalActions threw for ${waitingFor}:`, err);
    process.exit(1);
  }

  if (legalActions.length === 0) {
    console.error(`\n[ERROR] No legal actions for ${waitingFor} (actionKind: ${pending.actionKind})`);
    console.error('State context:', JSON.stringify(pending.context, null, 2));
    process.exit(1);
  }

  // Use MCTS for summoning; greedy 1-ply eval for all other choices
  let action: Action;
  try {
    const useMcts =
      pending.actionKind === 'summoning_action' ||
      pending.actionKind === 'battle_hit_assignment' ||
      pending.actionKind === 'tenzen_discard' ||
      pending.actionKind === 'dial_place_token' ||
      pending.actionKind === 'dial_remove_corruption' ||
      pending.actionKind === 'dial_remove_world_token' ||
      pending.actionKind === 'upgrade_choice' ||
      pending.actionKind === 'world_choice' ||
      pending.actionKind === 'hero_removal' ||
      pending.actionKind === 'corruption_harvest_choice' ||
      pending.actionKind === 'card_on_play_choice';
    if (useMcts) {
      action = runMcts(state, waitingFor);
    } else {
      action = greedyAction(state, waitingFor);
    }
  } catch (err) {
    console.error(`\n[ERROR] AI failed for ${waitingFor} (actionKind: ${pending.actionKind}):`, err);
    console.error('Legal actions sample:', JSON.stringify(legalActions.slice(0, 3), null, 2));
    process.exit(1);
  }

  if (verbose) {
    console.log(`  [${actionCount}] ${waitingFor} (${pending.actionKind}): ${JSON.stringify(action)}`);
  }

  // Apply
  try {
    const result = applyAction(state, action);
    printLog(result.log);
    state = result.state;
  } catch (err) {
    console.error(`\n[ERROR] applyAction threw for ${waitingFor}:`, err);
    console.error('Action:', JSON.stringify(action, null, 2));
    process.exit(1);
  }

  actionCount++;
}

// ── Result ────────────────────────────────────────────────────────────────────

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n──────────────────────────────────────`);
if (state.winners) {
  console.log(`WINNER(S): ${state.winners.join(', ')} (${state.winCondition})`);
} else {
  console.log(`Game ended: phase=${state.phase}`);
}
console.log(`Rounds: ${state.round}  |  Actions: ${actionCount}  |  Time: ${elapsed}s`);
console.log(`──────────────────────────────────────\n`);

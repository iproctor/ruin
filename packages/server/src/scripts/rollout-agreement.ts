/**
 * Measure how often MCTS with rollouts agrees with MCTS without rollouts
 * (pure value head at the leaf). Both use the same policy priors and PUCT —
 * the only difference is leaf evaluation.
 *
 * High agreement → rollouts aren't adding useful signal, safe to drop them.
 * Low agreement → rollouts are still correcting the value head.
 *
 * Usage: pnpm tsx packages/server/src/scripts/rollout-agreement.ts [--games N] [--seed S]
 */

import {
  createInitialState, applyAction, getLegalActions, autoAdvance, GameLog,
} from '@ruin/engine';
import { runMcts, greedyAction } from '@ruin/ai';
import type { Power, Action } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

loadLearnedModelIfPresent();

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const numGames = parseInt(getArg('--games', '5'), 10);
const baseSeed = parseInt(getArg('--seed', String(Date.now() & 0xffff)), 10);

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

let totalDecisions = 0;
let agreements = 0;
const perPower: Record<Power, { total: number; agree: number }> = {
  xarm: { total: 0, agree: 0 },
  gormen: { total: 0, agree: 0 },
  tenzen: { total: 0, agree: 0 },
  lasha: { total: 0, agree: 0 },
};

for (let g = 0; g < numGames; g++) {
  const seed = baseSeed + g * 1000;
  let { state } = autoAdvance({
    state: createInitialState({
      gameId: `agree-${g}`,
      activePowers: ALL_POWERS,
      playerTypes: Object.fromEntries(ALL_POWERS.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: new GameLog(),
  });

  let actionCount = 0;
  while (state.winners === null && state.phase !== 'completed' && actionCount < 500) {
    const pending = state.pendingAction;
    if (!pending) break;

    const { waitingFor } = pending;
    const isSummoning = pending.actionKind === 'summoning_action';

    let action: Action;
    if (isSummoning) {
      // MCTS with normal rollout
      const withRollout = runMcts(state, waitingFor);

      // MCTS with depth 0 (pure value head at leaf)
      const noRollout = runMcts(state, waitingFor, { rolloutDepth: 0 });

      const same = actionsMatch(withRollout, noRollout);
      totalDecisions++;
      perPower[waitingFor].total++;
      if (same) {
        agreements++;
        perPower[waitingFor].agree++;
      }

      // Use the rollout version to advance the game
      action = withRollout;
    } else {
      action = greedyAction(state, waitingFor);
    }

    try {
      const result = applyAction(state, action);
      state = result.state;
    } catch {
      break;
    }
    actionCount++;
  }

  const pct = totalDecisions > 0 ? (agreements / totalDecisions * 100).toFixed(1) : '0';
  console.log(`game ${g + 1}/${numGames}: ${pct}% agreement so far (${agreements}/${totalDecisions})`);
}

console.log(`\n=== Results (${numGames} games) ===`);
console.log(`Overall: ${agreements}/${totalDecisions} = ${(agreements / totalDecisions * 100).toFixed(1)}%`);
for (const p of ALL_POWERS) {
  const { total, agree } = perPower[p];
  const pct = total > 0 ? (agree / total * 100).toFixed(1) : 'n/a';
  console.log(`  ${p}: ${agree}/${total} = ${pct}%`);
}

function actionsMatch(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'summoning_summon_figure' && b.kind === 'summoning_summon_figure') {
    return a.toRegion === b.toRegion && a.followerId === b.followerId;
  }
  if (a.kind === 'summoning_play_card' && b.kind === 'summoning_play_card') {
    return a.cardId === b.cardId && a.toRegion === b.toRegion;
  }
  if (a.kind === 'summoning_pass' && b.kind === 'summoning_pass') return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

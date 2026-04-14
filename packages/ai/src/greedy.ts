import type { GameState, Action, Power } from '@ruin/engine';
import { applyAction, getLegalActions, enumerateBattleHitStrategies } from '@ruin/engine';
import { evaluateState } from './evaluate.js';
import { getAutoPlay } from './mcts/auto-play.js';

function actionsForGreedy(state: GameState, power: Power): Action[] {
  if (state.pendingAction?.actionKind === 'battle_hit_assignment') {
    return enumerateBattleHitStrategies(state, power);
  }
  return getLegalActions(state, power);
}

/**
 * Pick the action that produces the best immediate evaluation score
 * (1-ply greedy look-ahead).
 *
 * Used for non-summoning choices (world cards, upgrades, forced discards, etc.)
 * where a quick greedy heuristic is better than picking legalActions[0].
 *
 * Falls back to legalActions[0] if only one action exists or evaluation fails.
 */
export function greedyAction(state: GameState, power: Power): Action {
  // Forced plays (e.g. Tenzen upgrade priority) take precedence.
  const auto = getAutoPlay(state, power);
  if (auto) return auto;

  const actions = actionsForGreedy(state, power);
  if (actions.length === 0) {
    throw new Error(`greedyAction: no legal actions for ${power}`);
  }
  if (actions.length === 1) return actions[0]!;

  let bestAction = actions[0]!;
  let bestScore = -Infinity;

  for (const action of actions) {
    let score: number;
    try {
      const { state: next } = applyAction(state, action);
      score = evaluateState(next, power);
    } catch {
      score = -Infinity;
    }
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }

  return bestAction;
}

import type { GameState, Power } from '@ruin/engine';
import { evaluateLearned, hasModel } from './learn/evaluator.js';

/**
 * Evaluate the game state from `power`'s perspective.
 * Returns a score in [0, 1] where 1 is best for `power`.
 *
 * Always uses the learned model. Handmade per-power evaluators were removed
 * 2026-05-01 — they outlived their bootstrap purpose, were sneaking back in
 * via a default-2 cutoff env var (running rounds 1-2 of every bench/UI game
 * silently), and the value head is now strictly stronger than they were.
 *
 * If no model is loaded the function throws — there is no fallback. Callers
 * are expected to load a model at startup before invoking MCTS.
 */
export function evaluateState(state: GameState, power: Power): number {
  if (state.winners !== null) {
    return state.winners.includes(power) ? 1.0 : 0.0;
  }
  if (!hasModel()) {
    throw new Error('evaluateState called with no model loaded');
  }
  return evaluateLearned(state, power);
}

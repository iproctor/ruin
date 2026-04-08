import type { GameState, Power } from '@ruin/engine';
import { Mlp, type ModelJson } from './mlp.js';
import { extractFeatures, powerIndex } from './features.js';

/**
 * Loads a trained model (MLP or legacy linear) and exposes an evaluation
 * function compatible with the signature of the hand-crafted evaluateState.
 *
 * Returns P(power wins) from the model's softmax output.
 */

let cachedModel: Mlp | null = null;

export function loadModel(json: ModelJson): void {
  cachedModel = Mlp.fromJson(json);
}

export function clearModel(): void {
  cachedModel = null;
}

export function hasModel(): boolean {
  return cachedModel !== null;
}

export function evaluateLearned(state: GameState, power: Power): number {
  if (state.winners !== null) {
    return state.winners.includes(power) ? 1.0 : 0.0;
  }
  if (cachedModel === null) {
    throw new Error('evaluateLearned: no model loaded');
  }
  const x = extractFeatures(state);
  const probs = cachedModel.forward(x);
  return probs[powerIndex(power)]!;
}

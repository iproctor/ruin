import type { GameState, Power } from '@ruin/engine';
import { Mlp, type ModelJson } from './mlp.js';
import { extractFeatures, extractFeaturesAllPowers, powerIndex, POWERS } from './features.js';

/**
 * Loads trained models and exposes an evaluation function compatible with the
 * signature of the hand-crafted evaluateState.
 *
 * Two modes:
 *  - Single model: `loadModel(json)` sets a global model used for all powers.
 *  - Per-power model: `loadModelForPower(power, json)` sets a model used only
 *    when evaluating from that power's perspective.
 *
 * Per-power overrides take precedence. If a per-power model isn't set for the
 * requested viewpoint, the global model is used. If neither is set,
 * evaluateLearned throws.
 *
 * Used by the duel benchmark to pit two models against each other in the same
 * game by assigning each to a subset of powers.
 */

let cachedModel: Mlp | null = null;
const perPowerModels: Map<Power, Mlp> = new Map();

export function loadModel(json: ModelJson): void {
  cachedModel = Mlp.fromJson(json);
}

export function loadModelForPower(power: Power, json: ModelJson): void {
  perPowerModels.set(power, Mlp.fromJson(json));
}

export function clearModel(): void {
  cachedModel = null;
  perPowerModels.clear();
}

export function clearPerPowerModels(): void {
  perPowerModels.clear();
}

export function hasModel(): boolean {
  return cachedModel !== null || perPowerModels.size > 0;
}

export function modelForPowerLoaded(power: Power): boolean {
  return perPowerModels.has(power);
}

export function hasPolicyHeadFor(power: Power): boolean {
  const model = perPowerModels.get(power) ?? cachedModel;
  return model !== null && model !== undefined && model.hasPolicyHead();
}

/**
 * Convenience: load 4 models at once (one per power) by name.
 * `models[i]` corresponds to POWERS[i].
 */
export function loadModelsForPowers(models: Record<Power, ModelJson>): void {
  for (const p of POWERS) {
    perPowerModels.set(p, Mlp.fromJson(models[p]));
  }
}

export function evaluateLearned(state: GameState, power: Power): number {
  if (state.winners !== null) {
    return state.winners.includes(power) ? 1.0 : 0.0;
  }
  const model = perPowerModels.get(power) ?? cachedModel;
  if (model === null || model === undefined) {
    throw new Error(`evaluateLearned: no model loaded for ${power}`);
  }
  // Pass `power` as the viewpoint so the model only sees the calling power's
  // own hand contents (not opponents' — those are hidden info).
  const x = extractFeatures(state, power);
  // Scalar value head (outDim=1) directly predicts P(viewpoint wins) via
  // sigmoid. Brief mid-target experiment used outDim=2 (end, mid) — those
  // models are tolerated and read column 0 (end). Multi-power head
  // (outDim=4) outputs per-power softmax; extract the viewpoint's component.
  return model.forwardValue(x, powerIndex(power));
}

/**
 * Per-power leaf evaluation in one pass. Extracts features once and re-encodes
 * the hand block for each viewpoint, then runs forward through each viewpoint's
 * model. ~4× faster than calling evaluateLearned 4 times because the
 * viewpoint-independent feature work is shared.
 */
export function evaluateAllPowersLearned(state: GameState): Record<Power, number> {
  if (state.winners !== null) {
    const winners = state.winners;
    return {
      xarm: winners.includes('xarm') ? 1.0 : 0.0,
      gormen: winners.includes('gormen') ? 1.0 : 0.0,
      tenzen: winners.includes('tenzen') ? 1.0 : 0.0,
      lasha: winners.includes('lasha') ? 1.0 : 0.0,
    };
  }
  const features = extractFeaturesAllPowers(state);
  const result = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 } as Record<Power, number>;
  for (const p of POWERS) {
    const model = perPowerModels.get(p) ?? cachedModel;
    if (model === null || model === undefined) {
      throw new Error(`evaluateLearned: no model loaded for ${p}`);
    }
    result[p] = model.forwardValue(features[p], powerIndex(p));
  }
  return result;
}

function valueForPowerOutput(output: Float32Array, power: Power): number {
  return (output.length === 1 || output.length === 2) ? output[0]! : output[powerIndex(power)]!;
}

/**
 * Combined leaf evaluation for MCTS expansion. It evaluates all four value
 * heads and, for `policyPower`, also returns that power's policy distribution
 * from the same trunk pass used for its value.
 */
export function evaluateAllPowersAndPolicyLearned(
  state: GameState,
  policyPower: Power,
): { values: Record<Power, number>; policy: Float32Array | null } {
  if (state.winners !== null) {
    return { values: evaluateAllPowersLearned(state), policy: null };
  }
  const features = extractFeaturesAllPowers(state);
  const values = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 } as Record<Power, number>;
  let policy: Float32Array | null = null;

  for (const p of POWERS) {
    const model = perPowerModels.get(p) ?? cachedModel;
    if (model === null || model === undefined) {
      throw new Error(`evaluateLearned: no model loaded for ${p}`);
    }

    if (p === policyPower && model.hasPolicyHead()) {
      const out = model.forwardWithPolicy(features[p], p);
      values[p] = valueForPowerOutput(out.value, p);
      policy = out.policy;
    } else {
      values[p] = model.forwardValue(features[p], powerIndex(p));
    }
  }

  return { values, policy };
}

/**
 * Returns the policy distribution from the model's policy head, viewed from
 * `power`'s perspective. Returns null if the loaded model has no policy head
 * or no model is loaded — caller should fall back to uniform priors.
 */
export function policyForState(state: GameState, power: Power): Float32Array | null {
  const model = perPowerModels.get(power) ?? cachedModel;
  if (model === null || model === undefined) return null;
  if (!model.hasPolicyHead()) return null;
  const x = extractFeatures(state, power);
  const { policy } = model.forwardWithPolicy(x, power);
  return policy;
}

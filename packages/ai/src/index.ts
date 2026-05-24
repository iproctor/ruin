export { runMcts, runMctsWithStats, probeMctsSearch, type MctsStats, type TreeProbeStats, reportMctsStats, _mctsStats } from './mcts/search.js';
export { enumerateKillActions } from './mcts/hit-allocation.js';
export { filterPointlessActions } from './mcts/filter-actions.js';
export { evaluateState } from './evaluate.js';
export { greedyAction } from './greedy.js';
export type { MctsNode } from './mcts/node.js';

// Learned evaluator pipeline
export { extractFeatures, extractFeaturesAllPowers, FEATURE_DIM, HAND_BLOCK_OFFSET, POWERS, powerIndex } from './learn/features.js';
export {
  ACTION_DIM,
  canonicalActionIndex,
  buildLegalMask,
  inverseCanonicalAction,
  describeSlot,
  countLegalSlots,
} from './learn/action-canon.js';
export { Mlp, type ModelJson, type MlpJson, type LinearJson, type DualHeadMlpJson } from './learn/mlp.js';
export {
  loadModel, loadModelForPower, loadModelsForPowers,
  clearModel, clearPerPowerModels, hasModel, modelForPowerLoaded, hasPolicyHeadFor,
  evaluateAllPowersLearned,
} from './learn/evaluator.js';

export { runMcts, runMctsWithStats, probeMctsSearch, type MctsStats, type TreeProbeStats, reportMctsStats } from './mcts/search.js';
export { evaluateState, setTenzenCutoff, setGormenCutoff } from './evaluate.js';
export { greedyAction } from './greedy.js';
export type { MctsNode } from './mcts/node.js';

// Learned evaluator pipeline
export { extractFeatures, FEATURE_DIM, POWERS, powerIndex } from './learn/features.js';
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
} from './learn/evaluator.js';

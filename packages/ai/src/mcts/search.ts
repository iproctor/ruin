import type { GameState, Action, Power } from '@ruin/engine';
import { applyAction, getLegalActions, makeRng, REGIONS } from '@ruin/engine';
import { evaluateState } from '../evaluate.js';
import { type MctsNode, createNode, ucb1 } from './node.js';
import { filterPointlessActions, actionBuildsTowardDac } from './filter-actions.js';
import { enumerateKillActions } from './hit-allocation.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface MctsOptions {
  /** Maximum number of MCTS iterations (default 500). */
  iterations?: number;
  /** Maximum wall-clock time in milliseconds (default 1000). */
  timeMs?: number;
  /** UCB1 exploration constant (default √2 ≈ 1.414). */
  explorationC?: number;
}

const DEFAULT_ITERATIONS = 2000;
const DEFAULT_TIME_MS = 300;
const DEFAULT_EXPLORATION_C = Math.SQRT2;

/**
 * Adaptive rollout depth: roll out further when the value network is least
 * reliable (early game) and shorter when it's most reliable (late game).
 *
 * The model is trained on game outcomes, so its predictions get sharper
 * monotonically through the game — round-1 states have nearly-uniform soft
 * targets, round-7 states are essentially deterministic.
 *
 * Pushing the rollout leaf into rounds where the model is more accurate
 * partially compensates for the early-state weakness, at the cost of more
 * random-rollout-policy noise.
 */
function rolloutDepthForRound(round: number): number {
  if (round <= 1) return 35;
  if (round <= 2) return 28;
  if (round <= 3) return 20;
  if (round <= 5) return 14;
  return 10;
}

// Probability of picking a non-pass action when one is available in rollouts.
// This biases simulations toward aggressive play and avoids pass-heavy rollouts
// that produce unrealistically low scores, causing the AI to play too cautiously.
const ROLLOUT_AGGRESSION = 0.92;

// Maximum root-level candidates fed into MCTS tree search.
// Pruning the action space improves tree coverage without losing quality.
const MAX_ROOT_ACTIONS = 24;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run Paranoid MCTS and return the best action for `forPower`.
 *
 * Paranoid strategy: the AI maximises its own score; every other player is
 * treated as a single adversary minimising the AI's score.
 *
 * @throws if the state has no pending action for `forPower`.
 */
export function runMcts(
  state: GameState,
  forPower: Power,
  options?: MctsOptions,
): Action {
  const maxIterations = options?.iterations ?? DEFAULT_ITERATIONS;
  const maxTimeMs = options?.timeMs ?? DEFAULT_TIME_MS;
  const explorationC = options?.explorationC ?? DEFAULT_EXPLORATION_C;

  // For battle_hit_assignment, use a richer per-(power, class) enumeration
  // instead of the engine's 3 hand-picked strategies. This gives MCTS the
  // ability to discriminate between "kill 2 cultists" vs "kill 1 warrior"
  // vs "kill mixed" — the granularity the value model needs to compare.
  let legalRootRaw: Action[];
  if (state.pendingAction?.actionKind === 'battle_hit_assignment') {
    legalRootRaw = enumerateKillActions(state, forPower);
  } else {
    legalRootRaw = getLegalActions(state, forPower);
  }
  if (legalRootRaw.length === 0) {
    throw new Error(`runMcts: no legal actions for ${forPower}`);
  }
  // Strip out card plays whose preconditions can't fire (Hollow Pact in empty
  // region, Ritual Death without own figures, etc). Always keeps at least pass
  // and any non-card actions.
  const legalRoot = filterPointlessActions(state, legalRootRaw);
  if (legalRoot.length === 1) {
    return legalRoot[0]!;
  }

  // Random downsample to keep root branching tractable.
  const prunedRoot = pruneActions(state, forPower, legalRoot);

  const root = createNode(state, null, null, null, forPower, [...prunedRoot]);

  // Adaptive rollout depth based on the root state's round — see
  // rolloutDepthForRound for the rationale.
  const rolloutDepth = rolloutDepthForRound(state.round);

  const deadline = Date.now() + maxTimeMs;
  let iteration = 0;

  while (iteration < maxIterations && Date.now() < deadline) {
    // 1. Selection
    const selected = select(root, explorationC);

    // 2. Expansion
    const expanded = expand(selected, forPower);

    // 3. Simulation (rollout)
    const score = rollout(expanded.state, forPower, state.rngSeed + iteration, rolloutDepth);

    // 4. Backpropagation
    backpropagate(expanded, score);

    iteration += 1;
  }

  // Return the action from the most-visited child of root.
  return bestAction(root);
}

// ─── MCTS phases ─────────────────────────────────────────────────────────────

/**
 * Selection: descend the tree following UCB1 until we reach a node that has
 * untried actions (expandable) or is terminal.
 */
function select(node: MctsNode, explorationC: number): MctsNode {
  let current = node;
  while (current.untriedActions.length === 0 && current.children.length > 0) {
    // Terminal node (no children and no untried actions): stop.
    if (isTerminal(current.state)) break;

    // Pick the child with highest UCB1.
    let bestChild: MctsNode | null = null;
    let bestScore = -Infinity;
    for (const child of current.children) {
      const score = ucb1(child, explorationC);
      if (score > bestScore) {
        bestScore = score;
        bestChild = child;
      }
    }
    if (bestChild === null) break;
    current = bestChild;
  }
  return current;
}

/**
 * Expansion: pick one untried action from the node and create a child.
 * If the node is terminal or fully expanded, return the node itself.
 */
function expand(node: MctsNode, forPower: Power): MctsNode {
  if (isTerminal(node.state) || node.untriedActions.length === 0) {
    return node;
  }

  // Pop an untried action (last element for O(1) removal).
  const action = node.untriedActions.pop()!;
  const actingPower = action.power;

  let newState: GameState;
  try {
    const result = applyAction(node.state, action);
    newState = result.state;
  } catch {
    // If the action throws (shouldn't happen with legal actions), return parent.
    return node;
  }

  // Determine legal actions for whoever is now waiting.
  const childUntriedActions = getChildUntriedActions(newState);

  const child = createNode(newState, action, actingPower, node, forPower, childUntriedActions);
  node.children.push(child);
  return child;
}

/**
 * Simulation (rollout): from `state`, play biased-random actions until the
 * game ends or `maxDepth` half-moves have been played.
 *
 * Selection policy:
 *   - In summoning phase, strongly prefers non-pass and filters out pointless
 *     card plays via filterPointlessActions (keeps the random play realistic).
 *   - In other phases, uniform random over legal actions.
 *
 * `maxDepth` is set adaptively by the caller based on the root state's round
 * (see rolloutDepthForRound) — deeper rollouts in early game push the leaf
 * state into rounds where the value network is more reliable.
 */
function rollout(state: GameState, forPower: Power, seed: number, maxDepth: number): number {
  const rng = makeRng(seed);
  let current = state;
  let depth = 0;

  while (!isTerminal(current) && depth < maxDepth) {
    if (current.pendingAction === null) break;

    const waitingFor = current.pendingAction.waitingFor;
    const rawActions = getLegalActions(current, waitingFor);
    if (rawActions.length === 0) break;

    // Filter out card plays whose preconditions can't fire — same rule the
    // root and tree expansion use. Keeps rollouts from wasting plies on
    // dead actions and producing nonsense leaf states.
    const actions = filterPointlessActions(current, rawActions);
    if (actions.length === 0) break;

    let action: (typeof actions)[number] | undefined;

    // Biased selection: in summoning phase, strongly prefer non-pass actions.
    if (current.pendingAction.actionKind === 'summoning_action' && actions.length > 1) {
      const nonPass = actions.filter(a => a.kind !== 'summoning_pass');
      if (nonPass.length > 0 && rng() < ROLLOUT_AGGRESSION) {
        action = nonPass[Math.floor(rng() * nonPass.length)];
      } else {
        action = actions[Math.floor(rng() * actions.length)];
      }
    } else {
      // Uniform random for all other action types.
      action = actions[Math.floor(rng() * actions.length)];
    }

    if (action === undefined) break;

    try {
      const result = applyAction(current, action);
      current = result.state;
    } catch {
      break;
    }

    depth += 1;
  }

  return evaluateState(current, forPower);
}

/**
 * Backpropagation: walk up the tree updating visit counts and total scores.
 */
function backpropagate(node: MctsNode, score: number): void {
  let current: MctsNode | null = node;
  while (current !== null) {
    current.visits += 1;
    current.totalScore += score;
    current = current.parent;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTerminal(state: GameState): boolean {
  return state.winners !== null || state.phase === 'completed';
}

/**
 * Return the legal actions for whoever needs to act next in `state`.
 * Returns an empty array if the game is over or no one needs to act.
 */
function getChildUntriedActions(state: GameState): Action[] {
  if (isTerminal(state)) return [];
  if (state.pendingAction === null) return [];
  const waiting = state.pendingAction.waitingFor;
  // For battle_hit_assignment, use the richer per-(power, class) enumeration.
  if (state.pendingAction.actionKind === 'battle_hit_assignment') {
    return enumerateKillActions(state, waiting);
  }
  // Apply the same pointless-card filter inside the tree, so we don't waste
  // node expansions on actions whose effect cannot fire.
  return filterPointlessActions(state, getLegalActions(state, waiting));
}

/**
 * Pick the best action from the root's children by visit count (most robust).
 * Falls back to the first legal action if somehow no child was expanded.
 */
function bestAction(root: MctsNode): Action {
  let bestChild: MctsNode | null = null;
  let bestVisits = -1;

  for (const child of root.children) {
    if (child.visits > bestVisits) {
      bestVisits = child.visits;
      bestChild = child;
    }
  }

  if (bestChild !== null && bestChild.action !== null) {
    return bestChild.action;
  }

  // Fallback: return the first untried action if no child was expanded.
  const fallback = root.untriedActions[0];
  if (fallback !== undefined) return fallback;

  throw new Error('runMcts: could not determine best action — tree is empty');
}

// ─── Action pruning ───────────────────────────────────────────────────────────

/**
 * Reduce a large legal-action set to at most MAX_ROOT_ACTIONS candidates.
 *
 * For summoning actions we rank by a fast heuristic:
 *   - Playing a card scores higher than summoning a figure
 *   - Actions targeting populous/high-value regions score higher
 *   - Placing into a region where I already have figures scores higher
 *   - Pass is always included but at lowest priority
 *
 * Non-summoning actions are returned as-is (sets are typically small).
 */
function pruneActions(state: GameState, _power: Power, actions: Action[]): Action[] {
  // Cap root branching, with light DAC bias: actions that move toward earning
  // DAC for the acting power are preferentially preserved in the sampled set.
  // The remaining slots are random samples from the rest. Pass is always kept.
  if (actions.length <= MAX_ROOT_ACTIONS) return actions;
  if (state.pendingAction?.actionKind !== 'summoning_action') return actions;

  const passActions = actions.filter(a => a.kind === 'summoning_pass');
  const dacActions: Action[] = [];
  const otherActions: Action[] = [];
  for (const a of actions) {
    if (a.kind === 'summoning_pass') continue;
    if (actionBuildsTowardDac(state, a)) dacActions.push(a);
    else otherActions.push(a);
  }

  // Deterministic pseudo-random pick based on state.rngSeed so replay is stable.
  let seed = state.rngSeed | 0;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  function fisherYatesPick<T>(pool: T[], k: number): T[] {
    const arr = [...pool];
    const out: T[] = [];
    for (let i = 0; i < k && arr.length > 0; i++) {
      const j = Math.floor(rand() * arr.length);
      out.push(arr[j]!);
      arr[j] = arr[arr.length - 1]!;
      arr.pop();
    }
    return out;
  }

  // Reserve up to half the budget for DAC-helpful actions (or all of them
  // if there are fewer). The other half is random exploration.
  const budget = MAX_ROOT_ACTIONS - passActions.length;
  const dacQuota = Math.min(dacActions.length, Math.ceil(budget * 0.6));
  const otherQuota = Math.max(0, budget - dacQuota);

  const sampledDac = fisherYatesPick(dacActions, dacQuota);
  const sampledOther = fisherYatesPick(otherActions, otherQuota);

  return [...sampledDac, ...sampledOther, ...passActions];
}

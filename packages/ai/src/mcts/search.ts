import type { GameState, Action, Power } from '@ruin/engine';
import { applyAction, getLegalActions, makeRng } from '@ruin/engine';
import { evaluateState } from '../evaluate.js';
import { type MctsNode, createNode, ucb1 } from './node.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface MctsOptions {
  /** Maximum number of MCTS iterations (default 500). */
  iterations?: number;
  /** Maximum wall-clock time in milliseconds (default 1000). */
  timeMs?: number;
  /** UCB1 exploration constant (default √2 ≈ 1.414). */
  explorationC?: number;
}

const DEFAULT_ITERATIONS = 500;
const DEFAULT_TIME_MS = 1000;
const DEFAULT_EXPLORATION_C = Math.SQRT2;
const MAX_ROLLOUT_DEPTH = 50;

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

  const legalRoot = getLegalActions(state, forPower);
  if (legalRoot.length === 0) {
    throw new Error(`runMcts: no legal actions for ${forPower}`);
  }
  // Fast path: only one legal action.
  if (legalRoot.length === 1) {
    return legalRoot[0]!;
  }

  const root = createNode(state, null, null, null, forPower, [...legalRoot]);

  const deadline = Date.now() + maxTimeMs;
  let iteration = 0;

  while (iteration < maxIterations && Date.now() < deadline) {
    // 1. Selection
    const selected = select(root, explorationC);

    // 2. Expansion
    const expanded = expand(selected, forPower);

    // 3. Simulation (rollout)
    const score = rollout(expanded.state, forPower, state.rngSeed + iteration);

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
 * Simulation (rollout): from `state`, play random actions until the game ends
 * or `MAX_ROLLOUT_DEPTH` half-moves have been played.
 */
function rollout(state: GameState, forPower: Power, seed: number): number {
  const rng = makeRng(seed);
  let current = state;
  let depth = 0;

  while (!isTerminal(current) && depth < MAX_ROLLOUT_DEPTH) {
    if (current.pendingAction === null) break;

    const waitingFor = current.pendingAction.waitingFor;
    const actions = getLegalActions(current, waitingFor);
    if (actions.length === 0) break;

    // Pick a uniformly random legal action.
    const idx = Math.floor(rng() * actions.length);
    const action = actions[idx];
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
  return getLegalActions(state, waiting);
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

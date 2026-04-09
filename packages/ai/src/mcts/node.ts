import type { GameState, Action, Power } from '@ruin/engine';

/**
 * A node in the Paranoid MCTS tree.
 *
 * `forPower` is always the AI's own power — it never changes throughout the
 * tree. `power` is whose action led to this node (may be the AI or an
 * opponent).
 *
 * Paranoid strategy: when selecting a child at an *opponent's* node, invert
 * the UCB1 score so that the opponent is treated as minimising the AI's score.
 */
export interface MctsNode {
  state: GameState;
  /** The action that led to this node (null at root). */
  action: Action | null;
  /** Who took the action that produced this node (null at root). */
  power: Power | null;
  parent: MctsNode | null;
  children: MctsNode[];
  visits: number;
  /** Cumulative score for `forPower` across all rollouts through this node. */
  totalScore: number;
  /** The AI player's power — constant across the whole tree. */
  forPower: Power;
  /** Actions not yet expanded from this node. */
  untriedActions: Action[];
  /** Policy prior for this child (from the policy head). 1.0 = uniform default. */
  prior: number;
  /** Optional: lookup table mapping a child's action to its prior probability.
   *  Only set on the root when a policy head is available. */
  childPriors: ((action: Action) => number) | null;
}

export function createNode(
  state: GameState,
  action: Action | null,
  power: Power | null,
  parent: MctsNode | null,
  forPower: Power,
  untriedActions: Action[],
  prior: number = 1.0,
): MctsNode {
  return {
    state,
    action,
    power,
    parent,
    children: [],
    visits: 0,
    totalScore: 0,
    forPower,
    untriedActions,
    prior,
    childPriors: null,
  };
}

/**
 * UCB1 value for selecting which child to visit next.
 *
 * For the AI's own node: maximise expected score.
 * For an opponent's node (paranoid): opponent minimises AI score, so we
 * select the child with the *lowest* expected score from the AI's point of
 * view — equivalent to using `(1 - avgScore)` in the UCB1 numerator.
 *
 * The `power` field on the node is who *acted* to reach this node; the
 * selecting player is the node's *parent*'s acting player (or root = AI).
 * For simplicity we key off the node's `power` field: if the node was
 * reached by an opponent action, the parent was choosing adversarially.
 */
export function ucb1(node: MctsNode, explorationC: number): number {
  if (node.visits === 0) {
    // Unvisited nodes get +Infinity so they are tried first.
    return Infinity;
  }

  const parent = node.parent;
  const parentVisits = parent !== null ? parent.visits : node.visits;

  const exploitation = node.totalScore / node.visits;
  const exploration = explorationC * Math.sqrt(Math.log(parentVisits) / node.visits);

  // If this node was reached by an opponent's action, the *parent* (an
  // opponent) is selecting among children to minimise our score. We flip the
  // exploitation term so that the selection algorithm (which always picks
  // the maximum UCB1) effectively picks the child with the lowest AI score.
  const isOpponentNode = node.power !== null && node.power !== node.forPower;
  if (isOpponentNode) {
    return (1 - exploitation) + exploration;
  }

  return exploitation + exploration;
}

/**
 * PUCT selection score (AlphaZero-style).
 *
 *   PUCT(child) = Q(child) + c * P(action) * sqrt(N_parent) / (1 + n_child)
 *
 * Differs from UCB1 in three ways:
 *   - Uses sqrt(N_parent) (not log(N_parent)) so exploration grows faster.
 *   - Multiplies the exploration bonus by P(action) — the policy prior — so
 *     promising actions get visited more from the very first iteration.
 *   - Uses (1 + n_child) so unvisited children get a finite (large) score
 *     rather than infinity. They still get visited first by virtue of the
 *     prior * sqrt(N_parent) term being large when n_child = 0.
 *
 * Same paranoid flip as UCB1: opponent nodes use (1 - Q) for exploitation.
 */
export function puct(node: MctsNode, explorationC: number): number {
  const parent = node.parent;
  const parentVisits = parent !== null ? Math.max(1, parent.visits) : Math.max(1, node.visits);

  const exploitation = node.visits > 0 ? node.totalScore / node.visits : 0.5;
  const exploration =
    explorationC * node.prior * Math.sqrt(parentVisits) / (1 + node.visits);

  const isOpponentNode = node.power !== null && node.power !== node.forPower;
  if (isOpponentNode) {
    return (1 - exploitation) + exploration;
  }
  return exploitation + exploration;
}

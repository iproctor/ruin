import type { GameState, Action, Power } from '@ruin/engine';

/**
 * A node in the MaxN MCTS tree.
 *
 * `forPower` is the AI's own power — constant across the tree. `power` is who
 * acted to reach this node.
 *
 * MaxN strategy: each player picks the action that maximises *their own*
 * value. Backprop tracks per-power scores (rollouts return a vector of
 * value-head evaluations, one per power). At child selection, the acting
 * power's own avg score is the exploitation term — no paranoid flip.
 *
 * This replaces the previous Paranoid model (opponent minimises my score)
 * because CitOW has cooperative moments — e.g. multiple powers piling
 * corruption into a region they all want ruined — that paranoid can't
 * represent. Under paranoid, an opponent's "best" action was always the one
 * worst for the AI, even when the opponent's actual incentive aligned with
 * helping the AI score.
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
  /** Per-power cumulative score across rollouts through this node.
   *  Each entry is in [0, 1]; rollouts contribute one value per power based
   *  on each power's own value-head evaluation of the leaf state. */
  totalScores: Record<Power, number>;
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

const ZERO_SCORES: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };

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
    totalScores: { ...ZERO_SCORES },
    forPower,
    untriedActions,
    prior,
    childPriors: null,
  };
}

/** Acting player at a node: who's deciding among this node's children?
 *  At the root, that's forPower. At any other node, the action's power led
 *  here, so the *next* action is by whoever pendingAction.waitingFor names —
 *  but since we score children (where action is set), we use the child's
 *  action.power directly. So this is called on each child to determine which
 *  perspective to score from. */
function actingPowerForChild(child: MctsNode): Power {
  // Child's action is the action being scored — we want to know "who picked
  // this action and what's its value to them."
  return (child.action?.power ?? child.forPower) as Power;
}

/**
 * Effective exploitation Q from a power's perspective, optionally with xarm
 * suppression. When `xarmSuppression > 0` and the acting power is not xarm,
 * subtract λ × xarm's avg progress at this node — biasing non-xarm players
 * toward lines that retard xarm's dial in addition to advancing their own VP.
 * Set λ = 0 for vanilla MaxN behaviour.
 */
function effectiveQ(
  totalScores: Record<Power, number>,
  visits: number,
  acting: Power,
  xarmSuppression: number,
): number {
  if (visits <= 0) return 0;
  const own = totalScores[acting] / visits;
  if (xarmSuppression > 0 && acting !== 'xarm') {
    return own - xarmSuppression * (totalScores.xarm / visits);
  }
  return own;
}

/**
 * UCB1 value for selecting which child to visit next, MaxN-style.
 *
 * Each player maximises their own avg score. The acting player's perspective
 * is determined by the action stored on the child being scored.
 */
export function ucb1(node: MctsNode, explorationC: number, xarmSuppression: number = 0): number {
  if (node.visits === 0) {
    return Infinity;
  }
  const parent = node.parent;
  const parentVisits = parent !== null ? parent.visits : node.visits;

  const acting = actingPowerForChild(node);
  const exploitation = effectiveQ(node.totalScores, node.visits, acting, xarmSuppression);
  const exploration = explorationC * Math.sqrt(Math.log(parentVisits) / node.visits);
  return exploitation + exploration;
}

export const FPU_REDUCTION = 0.1;

/**
 * PUCT score for an UNTRIED action at `parent`.
 *
 * Untried child has no Q; we estimate Q via FPU from the parent's average
 * score *from the action's actor's perspective* (not paranoid-flipped).
 */
export function puctForUntriedAction(
  parent: MctsNode,
  action: Action,
  prior: number,
  explorationC: number,
  xarmSuppression: number = 0,
): number {
  const parentVisits = Math.max(1, parent.visits);
  const acting = action.power as Power;

  let exploitation: number;
  if (parent.visits > 0) {
    const parentAvg = effectiveQ(parent.totalScores, parent.visits, acting, xarmSuppression);
    exploitation = Math.max(0, parentAvg - FPU_REDUCTION);
  } else {
    exploitation = 0.5;
  }

  const exploration = explorationC * prior * Math.sqrt(parentVisits);
  return exploitation + exploration;
}

export function puct(node: MctsNode, explorationC: number, xarmSuppression: number = 0): number {
  const parent = node.parent;
  const parentVisits = parent !== null ? Math.max(1, parent.visits) : Math.max(1, node.visits);
  const acting = actingPowerForChild(node);

  let exploitation: number;
  if (node.visits > 0) {
    exploitation = effectiveQ(node.totalScores, node.visits, acting, xarmSuppression);
  } else if (parent !== null && parent.visits > 0) {
    const parentAvg = effectiveQ(parent.totalScores, parent.visits, acting, xarmSuppression);
    exploitation = Math.max(0, parentAvg - FPU_REDUCTION);
  } else {
    exploitation = 0.5;
  }

  const exploration =
    explorationC * node.prior * Math.sqrt(parentVisits) / (1 + node.visits);
  return exploitation + exploration;
}

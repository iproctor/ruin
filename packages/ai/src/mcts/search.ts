import type { GameState, Action, Power } from '@ruin/engine';
import { applyAction, getLegalActions, makeRng, REGIONS } from '@ruin/engine';
import { appendFileSync } from 'node:fs';
import { evaluateState } from '../evaluate.js';
import { type MctsNode, createNode, ucb1, puct } from './node.js';
import { filterPointlessActions, isXarmDelayPlay, isZeroCostCardPlay, isDacCompletion, isFeedingXarmDac, isRetreatFromXarm, isTenzenDefensivePlay } from './filter-actions.js';
import { enumerateKillActions } from './hit-allocation.js';
import { getAutoPlay, forceZeroCostFlush } from './auto-play.js';
import { policyForState } from '../learn/evaluator.js';
import { canonicalActionIndex } from '../learn/action-canon.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface MctsOptions {
  /** Maximum number of MCTS iterations (default 500). */
  iterations?: number;
  /** Maximum wall-clock time in milliseconds (default 1000). */
  timeMs?: number;
  /** UCB1 exploration constant (default √2 ≈ 1.414). */
  explorationC?: number;
  /** Override rollout depth. 0 = pure value head at leaf (no rollout). */
  rolloutDepth?: number;
}

const DEFAULT_ITERATIONS = 2000;
const DEFAULT_TIME_MS = 300;
const DEFAULT_EXPLORATION_C = Math.SQRT2;

/**
 * Build a "lookup the policy prior for this child action" function from the
 * model's policy head output. Returns null if there's no policy head loaded.
 *
 * The priors are normalized so the sum over LEGAL children equals 1.0 (we
 * renormalize over the actions actually in the pruned root set, not the full
 * 298-slot output, so the priors sum cleanly within the search space).
 */
function makeRootPriors(
  state: GameState,
  forPower: Power,
  rootActions: Action[],
): ((action: Action) => number) | null {
  const raw = policyForState(state, forPower);
  if (raw === null) return null;
  return makeRootPriorsFromRaw(raw, state, rootActions);
}

function makeRootPriorsFromRaw(
  raw: Float32Array,
  state: GameState,
  rootActions: Action[],
): ((action: Action) => number) | null {
  // Build slot → raw policy
  const slotPriors = new Map<number, number>();
  let totalForLegal = 0;
  for (const a of rootActions) {
    const idx = canonicalActionIndex(a, state);
    if (idx >= 0) {
      const p = raw[idx]!;
      slotPriors.set(idx, p);
      totalForLegal += p;
    }
  }
  // Normalize within the legal-action set
  if (totalForLegal <= 0) return null;

  // Boost zero-cost card priors: the policy head systematically undervalues
  // free cards because their effects are indirect. Give them a minimum prior
  // floor so MCTS explores them enough to learn their value.
  const FREE_CARD_PRIOR_FLOOR = 0.06;
  const zeroCostSlots = new Set<number>();
  for (const a of rootActions) {
    if (isZeroCostCardPlay(state, a)) {
      const idx = canonicalActionIndex(a, state);
      if (idx >= 0) zeroCostSlots.add(idx);
    }
  }

  return (action: Action) => {
    const idx = canonicalActionIndex(action, state);
    if (idx < 0) return 1 / rootActions.length;
    let p = (slotPriors.get(idx) ?? 0) / totalForLegal;
    if (zeroCostSlots.has(idx)) p = Math.max(p, FREE_CARD_PRIOR_FLOOR);
    return p;
  };
}

/**
 * Adaptive minimum rollout depth (passed as `minDepth` to rollout()).
 *
 * The rollout exits as soon as the round number changes AND minDepth has
 * been reached. So minDepth is a *floor*: rollouts won't bail before this
 * many plies even if something causes early exit conditions.
 *
 * In normal play, a round takes ~40-60 plies to traverse (summoning + battle
 * + corruption + end), so the round-change exit fires well after the floor.
 * The floor matters mainly when the game ends mid-round.
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
  // Obviously-good plays that don't need search
  const auto = getAutoPlay(state, forPower);
  if (auto) return auto;

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
  let legalRoot = filterPointlessActions(state, legalRootRaw);

  // Tenzen: force 0-cost card plays when PP is low to cycle the hand
  legalRoot = forceZeroCostFlush(state, forPower, legalRoot);

  if (legalRoot.length === 1) {
    return legalRoot[0]!;
  }

  // If the policy head is loaded, trust PUCT to focus search — give it
  // all legal actions and let the priors guide exploration. Without a
  // policy head, fall back to random downsampling.
  const rawPolicy = policyForState(state, forPower);
  const rootActions = rawPolicy !== null ? legalRoot : pruneActions(state, forPower, legalRoot);

  const root = createNode(state, null, null, null, forPower, [...rootActions]);
  const priors = rawPolicy !== null ? makeRootPriorsFromRaw(rawPolicy, state, rootActions) : null;
  root.childPriors = priors;
  const usePuct = priors !== null;

  const rolloutDepth = options?.rolloutDepth ?? rolloutDepthForRound(state.round);
  const deadline = Date.now() + maxTimeMs;
  let iteration = 0;

  while (iteration < maxIterations && Date.now() < deadline) {
    const selected = select(root, explorationC, usePuct);
    const expanded = expand(selected, forPower);
    const score = rollout(expanded.state, forPower, state.rngSeed + iteration, rolloutDepth);
    backpropagate(expanded, score);
    iteration += 1;
  }

  const hitTimeCap = iteration < maxIterations;
  _mctsStats.total++;
  _mctsStats.iters += iteration;
  if (hitTimeCap) _mctsStats.timeCapped++;

  // Visit margin: how decisive was this search?
  const sorted = [...root.children].sort((a, b) => b.visits - a.visits);
  if (sorted.length >= 2) {
    const margin = sorted[0]!.visits / Math.max(sorted[1]!.visits, 1);
    _mctsStats.margins.push(margin);
  }

  return bestAction(root);
}

// Temporary instrumentation — call reportMctsStats() to print
export const _mctsStats = { total: 0, timeCapped: 0, iters: 0, margins: [] as number[] };
export function reportMctsStats(): void {
  const { total, timeCapped, iters, margins } = _mctsStats;
  if (total === 0) return;
  const avgMargin = margins.length > 0 ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
  const closeCount = margins.filter(m => m < 1.5).length;
  const decisiveCount = margins.filter(m => m >= 3).length;
  console.log(`[mcts] ${total} searches: ${timeCapped} time-capped (${(timeCapped/total*100).toFixed(0)}%), avg ${(iters/total).toFixed(0)} iters`);
  console.log(`[mcts] visit margin: avg ${avgMargin.toFixed(1)}x, close (<1.5x) ${closeCount}/${margins.length} (${(closeCount/margins.length*100).toFixed(0)}%), decisive (>3x) ${decisiveCount}/${margins.length} (${(decisiveCount/margins.length*100).toFixed(0)}%)`);
}

/**
 * Same as runMcts but also returns the visit count for each root child,
 * keyed by the child's action. This is the training signal for a policy
 * head — the policy is trained to mimic MCTS's visit distribution.
 */
export interface MctsStats {
  action: Action;
  visitCounts: Array<{ action: Action; visits: number }>;
}

export function runMctsWithStats(
  state: GameState,
  forPower: Power,
  options?: MctsOptions,
): MctsStats {
  // Obviously-good plays that don't need search
  const auto = getAutoPlay(state, forPower);
  if (auto) return { action: auto, visitCounts: [{ action: auto, visits: 1 }] };

  const maxIterations = options?.iterations ?? DEFAULT_ITERATIONS;
  const maxTimeMs = options?.timeMs ?? DEFAULT_TIME_MS;
  const explorationC = options?.explorationC ?? DEFAULT_EXPLORATION_C;

  let legalRootRaw: Action[];
  if (state.pendingAction?.actionKind === 'battle_hit_assignment') {
    legalRootRaw = enumerateKillActions(state, forPower);
  } else {
    legalRootRaw = getLegalActions(state, forPower);
  }
  if (legalRootRaw.length === 0) {
    throw new Error(`runMctsWithStats: no legal actions for ${forPower}`);
  }
  let legalRoot = filterPointlessActions(state, legalRootRaw);
  legalRoot = forceZeroCostFlush(state, forPower, legalRoot);
  if (legalRoot.length === 1) {
    return {
      action: legalRoot[0]!,
      visitCounts: [{ action: legalRoot[0]!, visits: 1 }],
    };
  }

  const rawPolicy = policyForState(state, forPower);
  const rootActions = rawPolicy !== null ? legalRoot : pruneActions(state, forPower, legalRoot);
  const root = createNode(state, null, null, null, forPower, [...rootActions]);

  const priors = rawPolicy !== null ? makeRootPriorsFromRaw(rawPolicy, state, rootActions) : null;
  root.childPriors = priors;
  const usePuct = priors !== null;

  const rolloutDepth = rolloutDepthForRound(state.round);
  const deadline = Date.now() + maxTimeMs;
  let iteration = 0;

  while (iteration < maxIterations && Date.now() < deadline) {
    const selected = select(root, explorationC, usePuct);
    const expanded = expand(selected, forPower);
    const score = rollout(expanded.state, forPower, state.rngSeed + iteration, rolloutDepth);
    backpropagate(expanded, score);
    iteration += 1;
  }

  // Walk root children to collect (action, visits) pairs.
  const visitCounts: Array<{ action: Action; visits: number }> = [];
  for (const child of root.children) {
    if (child.action !== null) {
      visitCounts.push({ action: child.action, visits: child.visits });
    }
  }
  return { action: bestAction(root), visitCounts };
}

// ─── MCTS phases ─────────────────────────────────────────────────────────────

/**
 * Selection: descend the tree following UCB1 until we reach a node that has
 * untried actions (expandable) or is terminal.
 */
function select(node: MctsNode, explorationC: number, usePuct: boolean): MctsNode {
  let current = node;
  while (current.untriedActions.length === 0 && current.children.length > 0) {
    // Terminal node (no children and no untried actions): stop.
    if (isTerminal(current.state)) break;

    // Pick the child with highest UCB1 / PUCT.
    let bestChild: MctsNode | null = null;
    let bestScore = -Infinity;
    for (const child of current.children) {
      const score = usePuct ? puct(child, explorationC) : ucb1(child, explorationC);
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
  } catch (err) {
    // If the action throws (shouldn't happen with legal actions), log and
    // return parent. Logging here so we can find the root cause: an action
    // that getLegalActions reports as legal but applyAction rejects.
    const e = err as Error;
    try {
      {
        // Full serialized state so a tiny repro script can do:
        //   const r = JSON.parse(fs.readFileSync('record.json', 'utf-8'));
        //   applyAction(r.state, r.action);
        // …without needing to replay from a seed.
        appendFileSync('/tmp/mcts-expand-throws.log', JSON.stringify({
          ts: new Date().toISOString(),
          round: node.state.round,
          phase: node.state.phase,
          actingPower,
          action,
          pendingAction: node.state.pendingAction,
          message: e.message,
          stack: e.stack,
          state: node.state, // entire game state — enables direct repro
        }) + '\n');
      }
    } catch { /* logging best-effort */ }
    return node;
  }

  // Determine legal actions for whoever is now waiting.
  const childUntriedActions = getChildUntriedActions(newState);

  // Look up the prior for this child if the parent has a priors function
  // (only the root sets one — see runMcts). Default 1.0 = uniform.
  const childPrior = node.childPriors ? node.childPriors(action) : 1.0;

  const child = createNode(
    newState, action, actingPower, node, forPower, childUntriedActions, childPrior,
  );
  node.children.push(child);
  return child;
}

/**
 * Simulation (rollout): from `state`, play biased-random actions until either
 *   - the round number changes (we've finished the current round, including
 *     the corruption phase where most card effects pay off), AND we've gone
 *     at least `minDepth` plies, OR
 *   - the hard cap of HARD_ROLLOUT_CAP plies is hit (safety brake), OR
 *   - the game ends.
 *
 * The "until end of round" guarantee is what gives MCTS visibility into
 * delayed card effects (War Cry blocking corruption, Bloody Rebirth firing
 * an extra battle, Ritual Death stacking draws). Without it, the rollout
 * leaf state often sits mid-summoning and the value head can't see whether
 * the action paid off.
 *
 * The `minDepth` floor (passed in by the caller via rolloutDepthForRound)
 * ensures rollouts never bail too early. The hard cap prevents pathological
 * very-long rollouts in busy late-game states.
 */
const HARD_ROLLOUT_CAP = 120;

function rollout(state: GameState, forPower: Power, seed: number, minDepth: number): number {
  const rng = makeRng(seed);
  let current = state;
  let depth = 0;
  const startRound = state.round;

  while (!isTerminal(current) && depth < HARD_ROLLOUT_CAP) {
    // Stop early if we've reached at least minDepth AND the round has
    // advanced — meaning battle + corruption + end have resolved for the
    // round we started in.
    if (depth >= minDepth && current.round !== startRound) break;

    if (current.pendingAction === null) break;

    const waitingFor = current.pendingAction.waitingFor;
    const actions = getLegalActions(current, waitingFor);
    if (actions.length === 0) break;
    // NOTE: filterPointlessActions deliberately skipped here. Profile showed it
    // accounted for ~14% of total runtime, almost entirely inside rollouts.
    // Rollouts are noisy biased-random simulations — pruning "dead" plays from
    // them barely changes leaf-value estimates but adds significant overhead.
    // The root and tree expansion still apply the filter (see runMcts).

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
  // Cap root branching with class-aware sampling.
  //
  // Sampling buckets (sample independently to ensure each kind gets
  // explored, since otherwise the model's preference for summons would
  // dominate the random sample):
  //   1. always-keep:  pass + 0-cost cards + xarm-delay plays
  //   2. card plays:   gets ~half the remaining budget
  //   3. summons:      gets the rest
  //
  // The class-aware split is important because the value head systematically
  // under-values card plays (their effects fire later, indirectly), so a
  // uniform random sample concentrates visits on summons. By forcing cards
  // into ~half the slots, we guarantee the policy head sees card plays in
  // training data and can learn to value them.
  if (actions.length <= MAX_ROOT_ACTIONS) return actions;
  if (state.pendingAction?.actionKind !== 'summoning_action') return actions;

  const passActions: Action[] = [];
  const alwaysKeep: Action[] = [];
  const cardPool: Action[] = [];
  const summonPool: Action[] = [];
  for (const a of actions) {
    if (a.kind === 'summoning_pass') passActions.push(a);
    else if (isRetreatFromXarm(state, a)) alwaysKeep.push(a);
    else if (isFeedingXarmDac(state, a)) { /* drop */ }
    else if (isZeroCostCardPlay(state, a) || isXarmDelayPlay(state, a) || isDacCompletion(state, a) || isTenzenDefensivePlay(state, a)) alwaysKeep.push(a);
    else if (a.kind === 'summoning_play_card') cardPool.push(a);
    else summonPool.push(a);
  }

  // Deterministic pseudo-random pick based on state.rngSeed so replay is stable.
  let seed = state.rngSeed | 0;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  function sampleN<T>(pool: T[], k: number): T[] {
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

  const budget = Math.max(0, MAX_ROOT_ACTIONS - passActions.length - alwaysKeep.length);
  // Split budget ~half/half, but cap by what each pool can offer
  const cardSlots = Math.min(cardPool.length, Math.ceil(budget / 2));
  const summonSlots = Math.min(summonPool.length, budget - cardSlots);
  // If summon pool was exhausted, top up cards with the leftover
  const extraCardSlots = Math.min(
    cardPool.length - cardSlots,
    budget - cardSlots - summonSlots,
  );

  const sampledCards = sampleN(cardPool, cardSlots + extraCardSlots);
  const sampledSummons = sampleN(summonPool, summonSlots);

  return [...alwaysKeep, ...sampledCards, ...sampledSummons, ...passActions];
}

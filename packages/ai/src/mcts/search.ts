import type { GameState, Action, Power } from '@ruin/engine';
import {
  applyAction, getLegalActions, enumerateBattleHitStrategies, makeRng,
  sampleLegalSummoningAction,
} from '@ruin/engine';
import { appendFileSync } from 'node:fs';
import { type MctsNode, createNode, ucb1, puct, puctForUntriedAction } from './node.js';
import { filterPointlessActions, isZeroCostCardPlay, isUrgentRetreatFromXarm } from './filter-actions.js';
import { enumerateKillActions } from './hit-allocation.js';
import {
  policyForState, modelForPowerLoaded, evaluateAllPowersLearned, hasModel,
} from '../learn/evaluator.js';
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
  /**
   * Whether rollouts should sample summoning actions from the policy head
   * instead of biased-random. Modes:
   *   'off' (default): biased-random via sampleLegalSummoningAction
   *   'all': every acting power uses its policy head
   *   'tenzen': only when tenzen is acting
   *   'except-tenzen': only when non-tenzen powers are acting
   * Falls back to biased-random if the policy head isn't loaded.
   */
  rolloutPolicy?: 'off' | 'all' | 'tenzen' | 'except-tenzen';
  /**
   * Dirichlet noise on root priors (AlphaZero-style training exploration).
   * Blends (1-weight)·P(a) + weight·Dir(alpha) per root, so MCTS still picks
   * sensible actions but is encouraged to explore non-top-prior lines.
   * Omit at inference; enable only in collection.
   */
  dirichletNoise?: { alpha: number; weight: number };
  /**
   * Auxiliary "suppress xarm" reward shaping at MCTS selection. When > 0 and
   * the acting power is non-xarm, the exploitation term becomes
   *   Q = own_avg_progress - xarmSuppression * xarm_avg_progress
   * instead of the pure own-progress MaxN value. Biases non-xarm play toward
   * lines that retard xarm's dial in addition to advancing the actor's own
   * VP, breaking the xarm-clock attractor that pure MaxN converges to. Value
   * head training is unaffected (still trains on true per-power progress) —
   * the shaped policy comes purely from biased visit distributions. Anneal
   * to 0 once non-xarm powers have learned defensive play.
   */
  xarmSuppression?: number;
}

// Iteration cap is effectively only a safety net — time cap governs in
// practice. Set high enough that fast searches (shallow trees, no rollout)
// don't artificially bottleneck.
const DEFAULT_ITERATIONS = 100000;
const DEFAULT_TIME_MS = 400;
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
  return makeRootPriorsFromRaw(raw, state, rootActions, forPower);
}

function makeRootPriorsFromRaw(
  raw: Float32Array,
  state: GameState,
  rootActions: Action[],
  forPower?: Power,
  dirichlet?: { alpha: number; weight: number },
): ((action: Action) => number) | null {
  // 1. Per-slot raw policy mass.
  const slotPriors = new Map<number, number>();
  const slotCount = new Map<number, number>();
  for (const a of rootActions) {
    const idx = canonicalActionIndex(a, state);
    if (idx >= 0) {
      slotPriors.set(idx, raw[idx]!);
      slotCount.set(idx, (slotCount.get(idx) ?? 0) + 1);
    }
  }
  let totalForLegal = 0;
  for (const v of slotPriors.values()) totalForLegal += v;
  if (totalForLegal <= 0) return null;

  // 2. Per-action raw prior. When several legal actions canonicalise to the
  // same slot, split the slot's mass evenly among them so the action-level
  // priors sum to 1 (matching the slot-level normalisation).
  const N = rootActions.length;
  const actionPriors = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    const idx = canonicalActionIndex(rootActions[i]!, state);
    if (idx >= 0) {
      actionPriors[i] = (slotPriors.get(idx)! / totalForLegal) / slotCount.get(idx)!;
    } else {
      actionPriors[i] = 1 / N; // canonical-action lookup failed, uniform fallback
    }
  }

  // 3. Dirichlet noise per legal action (NOT per slot — per-slot noise
  // duplicates mass across same-slot actions and inflates effective noise).
  if (dirichlet && N > 0) {
    const gammas = new Array<number>(N);
    let gtotal = 0;
    for (let i = 0; i < N; i++) { gammas[i] = sampleGamma(dirichlet.alpha); gtotal += gammas[i]!; }
    if (gtotal <= 0) gtotal = 1;
    const w = dirichlet.weight;
    for (let i = 0; i < N; i++) {
      actionPriors[i] = (1 - w) * actionPriors[i]! + w * (gammas[i]! / gtotal);
    }
  }

  // 4. Heuristic floors (per action) — both disabled. The free-card floor was
  // causing indiscriminate region picks for tenzen's 0-cost cards (every region
  // looked equally good). The urgent-retreat floor was causing weird forced-
  // retreat play. Let policy head decide unaided.
  // const FREE_CARD_PRIOR_FLOOR = 0.06;
  // const URGENT_RETREAT_PRIOR_FLOOR = 0.25;
  // for (let i = 0; i < N; i++) {
  //   const a = rootActions[i]!;
  //   if (isZeroCostCardPlay(state, a)) {
  //     actionPriors[i] = Math.max(actionPriors[i]!, FREE_CARD_PRIOR_FLOOR);
  //   }
  //   if (forPower !== 'xarm' && isUrgentRetreatFromXarm(state, a)) {
  //     actionPriors[i] = Math.max(actionPriors[i]!, URGENT_RETREAT_PRIOR_FLOOR);
  //   }
  // }

  // 5. Renormalise after floors so total mass = 1. Without this, PUCT's
  // effective exploration constant becomes state-dependent (lots of
  // floor-firing actions = inflated total = different c_puct in practice).
  let finalTotal = 0;
  for (let i = 0; i < N; i++) finalTotal += actionPriors[i]!;
  if (finalTotal > 0) {
    for (let i = 0; i < N; i++) actionPriors[i] = actionPriors[i]! / finalTotal;
  }

  // 6. Build per-action lookup. Action object identity is stable through
  // selection/expansion, so we key the Map by action reference.
  const priorByAction = new Map<Action, number>();
  for (let i = 0; i < N; i++) priorByAction.set(rootActions[i]!, actionPriors[i]!);

  return (action: Action) => priorByAction.get(action) ?? (1 / N);
}

// Standard normal via Box-Muller. Accepts Math.random() as a source.
function sampleStandardNormal(): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Gamma(alpha, 1). Marsaglia-Tsang for alpha >= 1; recursion for alpha < 1.
// Used only at root priors in collection, so Math.random is fine — no need
// for a seeded RNG (training noise, not replay-critical).
function sampleGamma(alpha: number): number {
  if (alpha < 1) {
    return sampleGamma(alpha + 1) * Math.pow(Math.max(1e-10, Math.random()), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
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
// 1.0 = never voluntarily pass. Previously 0.92 (~8% random pass per turn).
// Random passing cut card-play rollouts short: Siphon +1 PP would never get
// spent because rollouts passed before converting PP → figures. This made
// the value head score card plays artificially low — probe-card-value.ts
// showed Siphon: post-card rollout had 1.82 avg figures vs 2.40 for summon,
// because random-pass kept ending the Siphon trajectory before its PP was
// used. Skilled play never passes with resources available.
const ROLLOUT_AGGRESSION = 1.0;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Internal: run Paranoid MCTS and return the root tree node + meta. Shared by
 * runMcts / runMctsWithStats / probeMctsSearch — the wrappers extract whatever
 * subset they need.
 *
 * Paranoid strategy: the AI maximises its own score; every other player is
 * treated as a single adversary minimising the AI's score.
 *
 * Two return shapes:
 *   - `forced: true` when filterPointlessActions reduces the root to one legal
 *     action — no search runs, the wrapper returns that action directly.
 *   - `forced: false` when the search executed; `root` is the populated tree.
 */
type MctsRunResult =
  | { forced: true; action: Action }
  | {
      forced: false;
      root: MctsNode;
      legalRoot: Action[];
      priors: ((a: Action) => number) | null;
      usePuct: boolean;
      iteration: number;
      elapsed: number;
      hitTimeCap: boolean;
      hitIterCap: boolean;
      sumLeafDepth: number;
      leafCount: number;
      maxDepth: number;
    };

function runMctsCore(
  state: GameState,
  forPower: Power,
  options?: MctsOptions,
): MctsRunResult {
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

  // Strip card plays whose preconditions can't fire (Hollow Pact in empty
  // region, Ritual Death without own figures, etc). Always keeps at least pass
  // and any non-card actions.
  const legalRoot = filterPointlessActions(state, legalRootRaw);

  if (legalRoot.length === 1) {
    return { forced: true, action: legalRoot[0]! };
  }

  // Policy head guides PUCT to focus search across the full legal-action space.
  const rawPolicy = policyForState(state, forPower);
  const root = createNode(state, null, null, null, forPower, [...legalRoot]);
  const priors = rawPolicy !== null
    ? makeRootPriorsFromRaw(rawPolicy, state, legalRoot, forPower, options?.dirichletNoise)
    : null;
  root.childPriors = priors;
  const usePuct = priors !== null;

  // Default to r0 (-1, skip rollout) when a per-power model is loaded —
  // matches the all-r0 training regime that produced the tenzen breakout.
  // Without a model, fall back to biased-random rollout with the adaptive
  // min-depth floor. Caller can override via options.rolloutDepth.
  const rolloutDepth = options?.rolloutDepth ?? (
    modelForPowerLoaded(forPower) ? -1 : rolloutDepthForRound(state.round)
  );
  const t0 = Date.now();
  const deadline = t0 + maxTimeMs;
  let iteration = 0;
  let sumLeafDepth = 0;
  let leafCount = 0;
  let maxDepth = 0;

  while (iteration < maxIterations && Date.now() < deadline) {
    const selected = select(root, explorationC, usePuct, options?.xarmSuppression ?? 0);
    const expanded = expand(selected, forPower);
    // Track depth so probeMctsSearch can report tree shape. Cheap (one
    // pointer walk per iter); always-on rather than conditional.
    let depth = 0;
    let n: MctsNode | null = expanded;
    while (n && n.parent !== null) { depth += 1; n = n.parent; }
    sumLeafDepth += depth;
    leafCount += 1;
    if (depth > maxDepth) maxDepth = depth;

    const score = rollout(expanded.state, forPower, state.rngSeed + iteration, rolloutDepth, options?.rolloutPolicy ?? 'off');
    backpropagate(expanded, score);
    iteration += 1;
  }
  const elapsed = Date.now() - t0;

  return {
    forced: false,
    root,
    legalRoot,
    priors,
    usePuct,
    iteration,
    elapsed,
    hitTimeCap: iteration < maxIterations,
    hitIterCap: iteration >= maxIterations,
    sumLeafDepth,
    leafCount,
    maxDepth,
  };
}

/**
 * Run Paranoid MCTS and return the best action for `forPower`.
 *
 * @throws if the state has no pending action for `forPower`.
 */
export function runMcts(
  state: GameState,
  forPower: Power,
  options?: MctsOptions,
): Action {
  const res = runMctsCore(state, forPower, options);
  if (res.forced) return res.action;

  _mctsStats.total++;
  _mctsStats.iters += res.iteration;
  if (res.hitTimeCap) _mctsStats.timeCapped++;

  // Visit margin: how decisive was this search?
  const sorted = [...res.root.children].sort((a, b) => b.visits - a.visits);
  if (sorted.length >= 2) {
    const margin = sorted[0]!.visits / Math.max(sorted[1]!.visits, 1);
    _mctsStats.margins.push(margin);
  }

  return bestAction(res.root);
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
  const res = runMctsCore(state, forPower, options);
  if (res.forced) {
    return { action: res.action, visitCounts: [{ action: res.action, visits: 1 }] };
  }
  const visitCounts: Array<{ action: Action; visits: number }> = [];
  for (const child of res.root.children) {
    if (child.action !== null) {
      visitCounts.push({ action: child.action, visits: child.visits });
    }
  }
  return { action: bestAction(res.root), visitCounts };
}

// ─── Diagnostic probe ────────────────────────────────────────────────────────

export interface TreeProbeStats {
  /** The action that would have been chosen (highest-visit root child). */
  action: Action;
  iterations: number;
  timeMs: number;
  hitTimeCap: boolean;
  hitIterCap: boolean;
  /** Deepest path from root (edges traversed). */
  maxDepth: number;
  /** Average depth at which a rollout was launched (= node expanded from). */
  avgLeafDepth: number;
  /** Legal actions considered at root (post-filter). */
  rootLegalActions: number;
  /** Root children that were expanded at least once. */
  rootChildrenExpanded: number;
  /** Root actions never expanded (ran out of budget). */
  rootUntriedRemaining: number;
  /** Whether PUCT was used (policy priors available). */
  usedPuct: boolean;
  /** True if AZ-style select was active (per-power model loaded). */
  azStyle: boolean;
  /** Per-root-action (visits, prior) entries. `slotIdx` is the canonical
   *  action slot (used to align distributions across independent MCTS runs on
   *  the same state where child-list order can differ). -1 if the action
   *  doesn't map to a canonical slot. */
  rootActions: Array<{ actionKind: string; slotIdx: number; visits: number; prior: number; q: number }>;
  /** Top action by visits. */
  topVisitKind: string;
  /** Top action by prior (null if no policy head). */
  topPriorKind: string | null;
  priorVisitAgree: boolean;
  /** Shannon entropy (bits) of normalized visit distribution. */
  visitEntropy: number;
  /** Shannon entropy (bits) of prior distribution. NaN if no priors. */
  priorEntropy: number;
  /** KL( visits || prior ) in bits — how much search moved away from policy. NaN if no priors. */
  klVisitToPrior: number;
}

/**
 * Run MCTS and return detailed tree statistics for diagnosis.
 */
export function probeMctsSearch(
  state: GameState,
  forPower: Power,
  options?: MctsOptions,
): TreeProbeStats {
  const res = runMctsCore(state, forPower, options);

  // Short-circuit: forced single action, return minimal stats.
  if (res.forced) {
    return {
      action: res.action,
      iterations: 0,
      timeMs: 0,
      hitTimeCap: false,
      hitIterCap: false,
      maxDepth: 0,
      avgLeafDepth: 0,
      rootLegalActions: 1,
      rootChildrenExpanded: 0,
      rootUntriedRemaining: 1,
      usedPuct: false,
      azStyle: modelForPowerLoaded(forPower),
      rootActions: [{ actionKind: res.action.kind, slotIdx: canonicalActionIndex(res.action, state), visits: 0, prior: NaN, q: NaN }],
      topVisitKind: res.action.kind,
      topPriorKind: null,
      priorVisitAgree: false,
      visitEntropy: 0,
      priorEntropy: NaN,
      klVisitToPrior: NaN,
    };
  }

  const { root, legalRoot, priors, usePuct, iteration, elapsed, hitTimeCap, hitIterCap, sumLeafDepth, leafCount, maxDepth } = res;

  const rootActions: Array<{ actionKind: string; slotIdx: number; visits: number; prior: number; q: number }> = [];
  let totalVisits = 0;
  for (const child of root.children) {
    const kind = child.action?.kind ?? 'null';
    const p = priors && child.action ? priors(child.action) : NaN;
    const slotIdx = child.action ? canonicalActionIndex(child.action, state) : -1;
    // Q at root children = AI's avg value from this action. forPower's slot
    // since root children represent forPower's moves.
    const q = child.visits > 0 ? child.totalScores[forPower] / child.visits : NaN;
    rootActions.push({ actionKind: kind, slotIdx, visits: child.visits, prior: p, q });
    totalVisits += child.visits;
  }

  const visitEntropy = (() => {
    if (totalVisits === 0) return 0;
    let h = 0;
    for (const r of rootActions) {
      if (r.visits === 0) continue;
      const p = r.visits / totalVisits;
      h -= p * Math.log2(p);
    }
    return h;
  })();

  const priorEntropy = (() => {
    if (!priors) return NaN;
    let h = 0;
    for (const a of legalRoot) {
      const p = priors(a);
      if (p > 0) h -= p * Math.log2(p);
    }
    return h;
  })();

  const klVisitToPrior = (() => {
    if (!priors || totalVisits === 0) return NaN;
    let kl = 0;
    for (const r of rootActions) {
      if (r.visits === 0) continue;
      const q = r.visits / totalVisits;
      const p = r.prior;
      if (!(p > 0)) continue;
      kl += q * Math.log2(q / p);
    }
    return kl;
  })();

  let topVisitKind = 'null';
  let topVisits = -1;
  let topVisitChild: MctsNode | null = null;
  for (const child of root.children) {
    if (child.visits > topVisits) {
      topVisits = child.visits;
      topVisitKind = child.action?.kind ?? 'null';
      topVisitChild = child;
    }
  }
  const chosenAction = topVisitChild?.action ?? legalRoot[0]!;

  let topPriorKind: string | null = null;
  if (priors) {
    let topPrior = -Infinity;
    for (const a of legalRoot) {
      const p = priors(a);
      if (p > topPrior) { topPrior = p; topPriorKind = a.kind; }
    }
  }

  return {
    action: chosenAction,
    iterations: iteration,
    timeMs: elapsed,
    hitTimeCap,
    hitIterCap,
    maxDepth,
    avgLeafDepth: leafCount > 0 ? sumLeafDepth / leafCount : 0,
    rootLegalActions: legalRoot.length,
    rootChildrenExpanded: root.children.length,
    rootUntriedRemaining: root.untriedActions.length,
    usedPuct: usePuct,
    azStyle: modelForPowerLoaded(forPower),
    rootActions,
    topVisitKind,
    topPriorKind,
    priorVisitAgree: topPriorKind !== null && topPriorKind === topVisitKind,
    visitEntropy,
    priorEntropy,
    klVisitToPrior,
  };
}

// ─── MCTS phases ─────────────────────────────────────────────────────────────

/**
 * Selection: descend the tree following UCB1 until we reach a node that has
 * untried actions (expandable) or is terminal.
 */
/**
 * Selection: walk from root down until we hit a node to expand or rollout from.
 *
 * Two modes, toggled by whether forPower has a dedicated per-power model
 * loaded (= it's currently being focus-trained, or previously was):
 *   - **AZ-style**: PUCT compares existing children and untried actions
 *     (FPU-scored) jointly at each node. Lets promising lines deepen earlier.
 *     When an untried wins, it's swapped to the end so expand() pops the
 *     chosen action via its O(1) pop.
 *   - **Classic**: stop at any node with untried actions (let expand() pop
 *     one); only descend when a node is fully expanded. Broadens before
 *     deepening. Used for powers without per-power models.
 */
function select(node: MctsNode, explorationC: number, usePuct: boolean, xarmSup: number): MctsNode {
  const useAzStyle = modelForPowerLoaded(node.forPower);
  let current = node;

  while (!isTerminal(current.state)) {
    const hasChildren = current.children.length > 0;
    const hasUntried = current.untriedActions.length > 0;
    if (!hasChildren && !hasUntried) break;

    if (!useAzStyle) {
      // Classic: expand every untried before descending.
      if (hasUntried) break;
      let bestChild: MctsNode | null = null;
      let bestScore = -Infinity;
      for (const child of current.children) {
        const s = usePuct ? puct(child, explorationC, xarmSup) : ucb1(child, explorationC, xarmSup);
        if (s > bestScore) { bestScore = s; bestChild = child; }
      }
      if (bestChild === null) break;
      current = bestChild;
      continue;
    }

    // AZ-style: score children + untried jointly.
    let bestChildScore = -Infinity;
    let bestChild: MctsNode | null = null;
    for (const child of current.children) {
      const s = usePuct ? puct(child, explorationC, xarmSup) : ucb1(child, explorationC, xarmSup);
      if (s > bestChildScore) { bestChildScore = s; bestChild = child; }
    }

    let bestUntriedScore = -Infinity;
    let bestUntriedIdx = -1;
    if (hasUntried) {
      if (usePuct) {
        // Below root, childPriors is null (only root has a policy lookup).
        // Use uniform prior 1/N over legal actions at this node so PUCT's
        // exploration term has the right scale instead of treating every
        // sibling as if it had prior=1.
        const totalLegalHere = current.children.length + current.untriedActions.length;
        const fallbackPrior = totalLegalHere > 0 ? 1 / totalLegalHere : 1.0;
        for (let i = 0; i < current.untriedActions.length; i++) {
          const action = current.untriedActions[i]!;
          const prior = current.childPriors !== null ? current.childPriors(action) : fallbackPrior;
          const s = puctForUntriedAction(current, action, prior, explorationC, xarmSup);
          if (s > bestUntriedScore) { bestUntriedScore = s; bestUntriedIdx = i; }
        }
      } else {
        bestUntriedScore = Infinity;
        bestUntriedIdx = current.untriedActions.length - 1;
      }
    }

    if (bestUntriedIdx >= 0 && bestUntriedScore >= bestChildScore) {
      const lastIdx = current.untriedActions.length - 1;
      if (bestUntriedIdx !== lastIdx) {
        const tmp = current.untriedActions[lastIdx]!;
        current.untriedActions[lastIdx] = current.untriedActions[bestUntriedIdx]!;
        current.untriedActions[bestUntriedIdx] = tmp;
      }
      return current;
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
  // (only the root sets one — see runMcts). Below root, fall back to uniform
  // 1/N over the parent's legal actions so PUCT exploration scales correctly
  // instead of treating each sibling as if it had prior=1.
  const totalLegalHere = node.children.length + node.untriedActions.length + 1;
  const fallbackPrior = 1 / totalLegalHere;
  const childPrior = node.childPriors ? node.childPriors(action) : fallbackPrior;

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

/** Per-power leaf evaluation: each power's value-head score for the state.
 *  Used for MaxN backup so each tree node tracks values for all four powers
 *  independently, letting opponent nodes pick actions that maximise the
 *  acting opponent's own value (not the AI's negated value).
 *
 *  Shares one feature-extraction across the four viewpoints — only the
 *  hand-encoding block differs per viewpoint — instead of running the full
 *  854-dim extractor four times. */
function evaluateAllPowers(state: GameState): Record<Power, number> {
  if (!hasModel()) {
    throw new Error('evaluateAllPowers called with no model loaded');
  }
  return evaluateAllPowersLearned(state);
}

/**
 * Sample a summoning action from the policy head's distribution. Returns
 * null if no policy head is loaded for the acting power (caller falls back
 * to biased-random). Skips filterPointlessActions per AI CLAUDE.md invariant.
 */
function samplePolicyAction(state: GameState, waitingFor: Power, rng: () => number): Action | undefined {
  const raw = policyForState(state, waitingFor);
  if (raw === null) return undefined;
  const legal = getLegalActions(state, waitingFor);
  if (legal.length === 0) return undefined;
  const probs: number[] = new Array(legal.length);
  let total = 0;
  for (let i = 0; i < legal.length; i++) {
    const idx = canonicalActionIndex(legal[i]!, state);
    const p = idx >= 0 ? raw[idx]! : 0;
    probs[i] = p;
    total += p;
  }
  if (total <= 0) return legal[Math.floor(rng() * legal.length)];
  const r = rng() * total;
  let cum = 0;
  for (let i = 0; i < legal.length; i++) {
    cum += probs[i]!;
    if (r <= cum) return legal[i];
  }
  return legal[legal.length - 1];
}

function rollout(
  state: GameState,
  _forPower: Power,
  seed: number,
  minDepth: number,
  rolloutPolicy: 'off' | 'all' | 'tenzen' | 'except-tenzen' = 'off',
): Record<Power, number> {
  // NOTE: a minDepth===0 short-circuit was retried on Apr 20 at 10k iters
  // (the hypothesis: more leaves backprop'd to root would wash out mid-round
  // value-head noise). It didn't — tenzen freq halved 0.205 → 0.109 at the
  // same seeds, and xarm shot to 0.842. Rollout-to-round-change is load-
  // bearing for correctness even at high iter budgets.
  // minDepth < 0 = skip rollout entirely. Pure value-head leaf eval.
  if (minDepth < 0) return evaluateAllPowers(state);

  const rng = makeRng(seed);
  let current = state;
  let depth = 0;
  const startRound = state.round;

  while (!isTerminal(current) && depth < HARD_ROLLOUT_CAP) {
    if (depth >= minDepth && current.round !== startRound) break;
    if (current.pendingAction === null) break;

    const waitingFor = current.pendingAction.waitingFor;
    let action: Action | undefined;
    if (current.pendingAction.actionKind === 'summoning_action') {
      const usePolicy =
        rolloutPolicy === 'all' ||
        (rolloutPolicy === 'tenzen' && waitingFor === 'tenzen') ||
        (rolloutPolicy === 'except-tenzen' && waitingFor !== 'tenzen');
      action = usePolicy
        ? samplePolicyAction(current, waitingFor, rng) ?? sampleLegalSummoningAction(current, waitingFor, rng, ROLLOUT_AGGRESSION)
        : sampleLegalSummoningAction(current, waitingFor, rng, ROLLOUT_AGGRESSION);
    } else {
      const actions = current.pendingAction.actionKind === 'battle_hit_assignment'
        ? enumerateBattleHitStrategies(current, waitingFor)
        : getLegalActions(current, waitingFor);
      if (actions.length === 0) break;
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

  return evaluateAllPowers(current);
}

/**
 * Backpropagation: walk up the tree updating visit counts and per-power
 * totalScores. Each tree level stores ALL powers' cumulative values so
 * MaxN selection can use the acting power's own perspective at each child.
 */
function backpropagate(node: MctsNode, scores: Record<Power, number>): void {
  let current: MctsNode | null = node;
  while (current !== null) {
    current.visits += 1;
    current.totalScores.xarm += scores.xarm;
    current.totalScores.gormen += scores.gormen;
    current.totalScores.tenzen += scores.tenzen;
    current.totalScores.lasha += scores.lasha;
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


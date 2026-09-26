import type { GameState, Action, Power } from '@ruin/engine';
import {
  applyAction, getLegalActions, enumerateBattleHitStrategies, makeRng,
  sampleLegalSummoningAction,
} from '@ruin/engine';
import { appendFileSync } from 'node:fs';
import { type MctsNode, type QBounds, createNode, ucb1, puct, puctForUntriedAction, childQBounds } from './node.js';
import { filterPointlessActions, isZeroCostCardPlay, isUrgentRetreatFromXarm } from './filter-actions.js';
import { enumerateKillActions } from './hit-allocation.js';
import {
  policyForState, modelForPowerLoaded, evaluateAllPowersLearned, evaluateAllPowersAndPolicyLearned, hasModel,
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
  /**
   * Node-local min-max Q normalization for PUCT (MuZero-style). When set,
   * each AZ-style selection rescales the acting power's child Qs to [0,1]
   * using the min/max over visited siblings (span floored at this value), so
   * the exploration constant is independent of how compressed a power's
   * value head is. Defaults to DEFAULT_Q_NORM_MIN_SPAN; 0 = off (raw Q).
   */
  normalizeQMinSpan?: number;
  /**
   * Determinized search (hidden information + chance). 0 = search the true
   * state (sees every hand, deck order and the real future dice). K >= 1 =
   * run K independent trees, each on its own determinization of what
   * `forPower` cannot know (fresh dice seed, opponents' hands re-dealt from
   * hand+deck, every deck and the world deck shuffled), splitting the
   * iteration/time budget evenly, then merge root statistics.
   */
  determinizations?: number;
  /**
   * Round-end leaf evaluation. When > 0, a leaf reached during the summoning
   * phase is fast-forwarded: every remaining player passes, the engine
   * resolves battle / corruption / end phase (and the next world + draw
   * phase), and the value head scores the next round's first summoning
   * decision. Leaf value = (1 - blend) * value-now + blend * value-after.
   * Card and figure effects then reach the search through the rules engine
   * instead of having to be predicted by the value head. 0 = off.
   */
  roundEndBlend?: number;
  /**
   * With roundEndBlend: how many summoning actions the fast-forward plays
   * (each acting power's top policy choice) before everyone passes. 0 =
   * pure pass-out.
   */
  roundEndPolicyActions?: number;
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
   * Root-only forced playouts for Dirichlet-noised actions. Enabled by
   * default when dirichletNoise is present; set false to restore plain PUCT.
   *
   * Quotas are derived from the sampled Dirichlet mass, so only actions that
   * the root noise actually highlighted receive forced visits. These visits
   * are used for search, then subtracted from non-best moves in the policy
   * target returned by runMctsWithStats.
   */
  forcedPlayouts?: false | {
    /** Multiplier on sqrt(iterations) * noisePrior. Default 2.0. */
    factor?: number;
    /** Hard cap per root action. Default 16. */
    maxVisits?: number;
    /** Ignore tiny noise draws below this action-level mass. Default 0.002. */
    minNoisePrior?: number;
  };
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
  /**
   * Optional collection-time leaf shaping that rewards building regions toward
   * ruination before they are already urgent. This is intentionally small and
   * relative across powers: it nudges round-2/3 setup toward concentrated
   * corruption without changing terminal scores.
   */
  ruinPressureLambda?: number;
  /** Apply ruinPressureLambda only through this round. Default: all rounds. */
  ruinPressureMaxRound?: number;
  /** Probe-only: record the root child backed up for the first N iterations. */
  traceIterations?: number;
}

// Iteration cap is effectively only a safety net — time cap governs in
// practice. Set high enough that fast searches (shallow trees, no rollout)
// don't artificially bottleneck.
const DEFAULT_ITERATIONS = 100000;
const DEFAULT_TIME_MS = 400;
const DEFAULT_EXPLORATION_C = Math.SQRT2;
// Node-local min-max Q normalization (see MctsOptions.normalizeQMinSpan).
// Sep 25 2026 paired-seed bench (~100 games/arm, one power switched on,
// others off): positive for all four powers — xarm +9.6pp win, gormen +5.2 VP
// (3.3 sigma), tenzen +1.5 VP, lasha +0.8 VP. Raw g/t/l value spreads (~0.08)
// were smaller than PUCT's exploration term, so search mostly echoed priors.
const DEFAULT_Q_NORM_MIN_SPAN = 0.05;
// Determinized search by default. Until Sep 25 2026 search ran on the true
// state: it saw every opponent's hand, all deck orders and the real future
// dice (dice are f(rngSeed, actionCount)), so move values for anything
// touching battle were single clairvoyant samples — and the browser bot saw
// the human's hand. Paired-seed bench, one power fair vs 3 clairvoyant:
// K=1 worst (xarm -15pp, lasha -19pp), K=4 best of the fair variants
// (xarm -3.5pp, lasha -14pp), K=8 ~K=4. Set 0 for the legacy true-state search.
const DEFAULT_DETERMINIZATIONS = 4;
// Round-end leaf evaluation (MctsOptions.roundEndBlend). Sep 26 2026 paired
// bench, 152 games/arm, one power switched on: blend 0.5 won for all four —
// xarm +5.9pp/+1.8VP, gormen +5.9pp/+3.0VP, tenzen +2.6pp/+3.1VP, lasha
// +7.9pp/+2.6VP — and cut no-payoff fighter summons (xarm 43->39%, gormen
// 21->16%, tenzen 27->20%). Blend 1.0 was weaker. Costs ~1.6x time per move.
const DEFAULT_ROUND_END_BLEND = 0.5;
const DEFAULT_ROUND_END_POLICY_ACTIONS = 0;
const DEFAULT_FORCED_PLAYOUT_FACTOR = 2.0;
const DEFAULT_FORCED_PLAYOUT_MAX = 16;
const DEFAULT_FORCED_PLAYOUT_MIN_NOISE = 0.002;

interface RootPriorInfo {
  priors: (action: Action) => number;
  /** Priors before Dirichlet noise (what the policy head actually said). */
  cleanPriors: (action: Action) => number;
  noisePriors: ((action: Action) => number) | null;
}

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
  return makeRootPriorInfoFromRaw(raw, state, rootActions, forPower)?.priors ?? null;
}

function makeRootPriorInfoFromRaw(
  raw: Float32Array,
  state: GameState,
  rootActions: Action[],
  forPower?: Power,
  dirichlet?: { alpha: number; weight: number },
): RootPriorInfo | null {
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
  const noisePriors = dirichlet && N > 0 ? new Array<number>(N).fill(0) : null;
  for (let i = 0; i < N; i++) {
    const idx = canonicalActionIndex(rootActions[i]!, state);
    if (idx >= 0) {
      actionPriors[i] = (slotPriors.get(idx)! / totalForLegal) / slotCount.get(idx)!;
    } else {
      actionPriors[i] = 1 / N; // canonical-action lookup failed, uniform fallback
    }
  }

  const cleanPriors = actionPriors.slice();
  // 3. Dirichlet noise per legal action (NOT per slot — per-slot noise
  // duplicates mass across same-slot actions and inflates effective noise).
  if (dirichlet && N > 0) {
    const gammas = new Array<number>(N);
    let gtotal = 0;
    for (let i = 0; i < N; i++) { gammas[i] = sampleGamma(dirichlet.alpha); gtotal += gammas[i]!; }
    if (gtotal <= 0) gtotal = 1;
    const w = dirichlet.weight;
    for (let i = 0; i < N; i++) {
      const noisePrior = gammas[i]! / gtotal;
      noisePriors![i] = noisePrior;
      actionPriors[i] = (1 - w) * actionPriors[i]! + w * noisePrior;
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
  const noiseByAction = new Map<Action, number>();
  if (noisePriors) {
    for (let i = 0; i < N; i++) noiseByAction.set(rootActions[i]!, noisePriors[i]!);
  }

  const cleanByAction = new Map<Action, number>();
  for (let i = 0; i < N; i++) cleanByAction.set(rootActions[i]!, cleanPriors[i]!);
  return {
    priors: (action: Action) => priorByAction.get(action) ?? (1 / N),
    cleanPriors: (action: Action) => cleanByAction.get(action) ?? (1 / N),
    noisePriors: noisePriors
      ? (action: Action) => noiseByAction.get(action) ?? 0
      : null,
  };
}

function makeChildPriors(
  state: GameState,
  actions: Action[],
  rawPolicy?: Float32Array | null,
): ((action: Action) => number) | null {
  if (state.pendingAction === null || actions.length === 0) return null;
  const actingPower = state.pendingAction.waitingFor;
  const raw = rawPolicy !== undefined ? rawPolicy : policyForState(state, actingPower);
  if (raw === null) return null;
  return makeRootPriorInfoFromRaw(raw, state, actions, actingPower)?.priors ?? null;
}

function makeForcedRootVisits(
  noisePriors: ((action: Action) => number) | null,
  maxIterations: number,
  options?: MctsOptions,
): ((action: Action) => number) | null {
  if (!noisePriors || options?.forcedPlayouts === false) return null;

  const cfg = options?.forcedPlayouts && typeof options.forcedPlayouts === 'object'
    ? options.forcedPlayouts
    : {};
  const factor = cfg.factor ?? DEFAULT_FORCED_PLAYOUT_FACTOR;
  const maxVisits = cfg.maxVisits ?? DEFAULT_FORCED_PLAYOUT_MAX;
  const minNoisePrior = cfg.minNoisePrior ?? DEFAULT_FORCED_PLAYOUT_MIN_NOISE;
  const budgetScale = Math.sqrt(Math.max(1, maxIterations));

  return (action: Action): number => {
    const noisePrior = noisePriors(action);
    if (!(noisePrior >= minNoisePrior) || factor <= 0 || maxVisits <= 0) return 0;
    const quota = Math.floor(factor * budgetScale * noisePrior);
    // A one-visit quota is indistinguishable from ordinary first expansion
    // and is pruned from the policy target anyway; only force meaningful probes.
    return quota >= 2 ? Math.min(maxVisits, quota) : 0;
  };
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
const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

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
      cleanPriors: ((a: Action) => number) | null;
      forcedRootVisits: ((a: Action) => number) | null;
      usePuct: boolean;
      iteration: number;
      elapsed: number;
      hitTimeCap: boolean;
      hitIterCap: boolean;
      sumLeafDepth: number;
      leafCount: number;
      maxDepth: number;
      rootTrace: Array<{ iteration: number; action: Action; leafDepth: number; score: number; path: Action[] }>;
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
  const rootPriorInfo = rawPolicy !== null
    ? makeRootPriorInfoFromRaw(rawPolicy, state, legalRoot, forPower, options?.dirichletNoise)
    : null;
  const priors = rootPriorInfo?.priors ?? null;
  const cleanPriors = rootPriorInfo?.cleanPriors ?? null;
  const usePuct = priors !== null;

  // Default to r0 (-1, skip rollout) when a per-power model is loaded —
  // matches the all-r0 training regime that produced the tenzen breakout.
  // Without a model, fall back to biased-random rollout with the adaptive
  // min-depth floor. Caller can override via options.rolloutDepth.
  const rolloutDepth = options?.rolloutDepth ?? (
    modelForPowerLoaded(forPower) ? -1 : rolloutDepthForRound(state.round)
  );
  const t0 = Date.now();
  const K = Math.max(0, Math.floor(options?.determinizations ?? DEFAULT_DETERMINIZATIONS));
  if (K === 0) {
    const forcedRootVisits = makeForcedRootVisits(rootPriorInfo?.noisePriors ?? null, maxIterations, options);
    const root = createNode(state, null, null, null, forPower, [...legalRoot]);
    root.childPriors = priors;
    const r = searchTree(root, forPower, maxIterations, t0 + maxTimeMs, explorationC, usePuct, forcedRootVisits, rolloutDepth, options);
    return {
      forced: false, root, legalRoot, priors, cleanPriors, forcedRootVisits, usePuct,
      iteration: r.iteration, elapsed: Date.now() - t0,
      hitTimeCap: r.iteration < maxIterations, hitIterCap: r.iteration >= maxIterations,
      sumLeafDepth: r.sumLeafDepth, leafCount: r.leafCount, maxDepth: r.maxDepth, rootTrace: r.rootTrace,
    };
  }

  // Determinized: K trees over sampled hidden info + dice, same root actions
  // (the mover's own options don't depend on anything hidden from it).
  const perTree = Math.max(1, Math.floor(maxIterations / K));
  const perTreeForced = makeForcedRootVisits(rootPriorInfo?.noisePriors ?? null, perTree, options);
  const rng = Math.random;
  const trees: MctsNode[] = [];
  let iteration = 0, sumLeafDepth = 0, leafCount = 0, maxDepth = 0;
  let rootTrace: Array<{ iteration: number; action: Action; leafDepth: number; score: number; path: Action[] }> = [];
  for (let k = 0; k < K; k++) {
    const det = determinizeForViewer(state, forPower, rng);
    const tree = createNode(det, null, null, null, forPower, [...legalRoot]);
    tree.childPriors = priors;
    const r = searchTree(tree, forPower, perTree, t0 + (maxTimeMs * (k + 1)) / K, explorationC, usePuct, perTreeForced, rolloutDepth, options);
    trees.push(tree);
    iteration += r.iteration; sumLeafDepth += r.sumLeafDepth; leafCount += r.leafCount;
    if (r.maxDepth > maxDepth) maxDepth = r.maxDepth;
    if (k === 0) rootTrace = r.rootTrace;
  }
  const root = mergeRoots(state, forPower, legalRoot, trees, priors);
  const forcedRootVisits = perTreeForced ? (a: Action) => K * perTreeForced(a) : null;
  return {
    forced: false, root, legalRoot, priors, cleanPriors, forcedRootVisits, usePuct,
    iteration, elapsed: Date.now() - t0,
    hitTimeCap: iteration < perTree * K, hitIterCap: iteration >= perTree * K,
    sumLeafDepth, leafCount, maxDepth, rootTrace,
  };
}

interface TreeSearchResult {
  iteration: number;
  sumLeafDepth: number;
  leafCount: number;
  maxDepth: number;
  rootTrace: Array<{ iteration: number; action: Action; leafDepth: number; score: number; path: Action[] }>;
}

/** Run MCTS iterations on one tree until the iteration or time cap. */
function searchTree(
  root: MctsNode,
  forPower: Power,
  maxIterations: number,
  deadline: number,
  explorationC: number,
  usePuct: boolean,
  forcedRootVisits: ((a: Action) => number) | null,
  rolloutDepth: number,
  options?: MctsOptions,
): TreeSearchResult {
  const state = root.state;
  let iteration = 0;
  let sumLeafDepth = 0;
  let leafCount = 0;
  let maxDepth = 0;
  const rootTrace: Array<{ iteration: number; action: Action; leafDepth: number; score: number; path: Action[] }> = [];

  while (iteration < maxIterations && Date.now() < deadline) {
    const selected = select(root, explorationC, usePuct, options?.xarmSuppression ?? 0, forcedRootVisits, options?.normalizeQMinSpan ?? DEFAULT_Q_NORM_MIN_SPAN);
    const expanded = expand(selected, forPower, rolloutDepth < 0);
    // Track depth so probeMctsSearch can report tree shape. Cheap (one
    // pointer walk per iter); always-on rather than conditional.
    let depth = 0;
    let n: MctsNode | null = expanded;
    while (n && n.parent !== null) { depth += 1; n = n.parent; }
    sumLeafDepth += depth;
    leafCount += 1;
    if (depth > maxDepth) maxDepth = depth;
    const blend = options?.roundEndBlend ?? DEFAULT_ROUND_END_BLEND;
    if (blend > 0 && expanded.leafScores !== null && !expanded.roundEndApplied) {
      expanded.roundEndApplied = true;
      if (expanded.state.phase === 'summoning') {
        const resolved = fastForwardRound(expanded.state, options?.roundEndPolicyActions ?? DEFAULT_ROUND_END_POLICY_ACTIONS);
        if (resolved !== null) {
          const after = isTerminal(resolved) ? terminalScores(resolved) : evaluateAllPowers(resolved);
          for (const p of ALL_POWERS) {
            expanded.leafScores[p] = (1 - blend) * expanded.leafScores[p] + blend * after[p];
          }
        }
      }
    }
    const baseScore = expanded.leafScores
      ?? rollout(expanded.state, forPower, state.rngSeed + iteration, rolloutDepth, options?.rolloutPolicy ?? 'off');
    const score = shapeScoresWithRuinPressure(expanded.state, baseScore, options);
    if (iteration < (options?.traceIterations ?? 0)) {
      let rootChild: MctsNode | null = expanded;
      while (rootChild.parent !== null && rootChild.parent.parent !== null) rootChild = rootChild.parent;
      if (rootChild.parent === root && rootChild.action !== null) {
        const path: Action[] = [];
        let cursor: MctsNode | null = expanded;
        while (cursor !== null && cursor.parent !== null) {
          if (cursor.action !== null) path.push(cursor.action);
          cursor = cursor.parent;
        }
        path.reverse();
        rootTrace.push({ iteration: iteration + 1, action: rootChild.action, leafDepth: depth, score: score[forPower], path });
      }
    }
    backpropagate(expanded, score);
    iteration += 1;
  }
  return { iteration, sumLeafDepth, leafCount, maxDepth, rootTrace };
}

/**
 * Sample one world consistent with what `viewer` can see: a fresh dice/draw
 * seed, every other power's hand re-dealt from its hand+deck pool (hand size
 * is public, contents are not), and all deck orders plus the world deck
 * shuffled. Discards, board and the viewer's own hand are public/known.
 */
export function determinizeForViewer(state: GameState, viewer: Power, rng: () => number): GameState {
  const shuffled = <T>(arr: readonly T[]): T[] => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]!; a[i] = a[j]!; a[j] = t;
    }
    return a;
  };
  const powers = { ...state.powers };
  for (const p of state.activePowers) {
    const ps = state.powers[p];
    if (p === viewer) {
      powers[p] = { ...ps, deckIds: shuffled(ps.deckIds) };
    } else {
      const pool = shuffled([...ps.hand, ...ps.deckIds]);
      powers[p] = { ...ps, hand: pool.slice(0, ps.hand.length), deckIds: pool.slice(ps.hand.length) };
    }
  }
  return {
    ...state,
    powers,
    worldDeck: shuffled(state.worldDeck),
    rngSeed: Math.floor(rng() * 0x100000000) >>> 0,
  };
}

/** Sum K determinized trees' root statistics into one synthetic root. */
function mergeRoots(
  state: GameState,
  forPower: Power,
  legalRoot: Action[],
  trees: MctsNode[],
  priors: ((a: Action) => number) | null,
): MctsNode {
  const root = createNode(state, null, null, null, forPower, []);
  root.childPriors = priors;
  const byAction = new Map<Action, MctsNode>();
  for (const tree of trees) {
    root.visits += tree.visits;
    for (const p of ALL_POWERS) root.totalScores[p] += tree.totalScores[p];
    for (const child of tree.children) {
      if (child.action === null) continue;
      let m = byAction.get(child.action);
      if (!m) {
        m = createNode(child.state, child.action, child.power, root, forPower, [], child.prior);
        byAction.set(child.action, m);
      }
      m.visits += child.visits;
      for (const p of ALL_POWERS) m.totalScores[p] += child.totalScores[p];
    }
  }
  // Keep legal-root order so ties in bestAction resolve deterministically.
  for (const a of legalRoot) {
    const m = byAction.get(a);
    if (m) root.children.push(m);
    else root.untriedActions.push(a);
  }
  return root;
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

  recordMctsStats(res);

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
function recordMctsStats(res: Extract<MctsRunResult, { forced: false }>): void {
  _mctsStats.total++;
  _mctsStats.iters += res.iteration;
  if (res.hitTimeCap) _mctsStats.timeCapped++;
}
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
  /** Policy-supervision visit counts, with artificial forced playouts pruned. */
  visitCounts: Array<{ action: Action; visits: number }>;
  /** Raw root visit counts from search, including forced exploration. */
  searchVisitCounts: Array<{ action: Action; visits: number }>;
  /** Diagnostic root rows: raw visits plus action prior and root-child Q. */
  searchDebugRows: Array<{ action: Action; visits: number; prior: number; q: number }>;
  /**
   * Visit-weighted mean backed-up value at the root, per power (the search's
   * own estimate of each power's outcome from this state). Absent for forced
   * single-action roots. Recorded in self-play so training can blend the
   * noisy game-outcome value target with this lower-variance estimate.
   */
  rootQ?: Record<Power, number>;
  /** Probe-only root child backed up per early iteration. */
  rootTrace?: Array<{ iteration: number; action: Action; leafDepth: number; score: number; path: Action[] }>;
}

export function runMctsWithStats(
  state: GameState,
  forPower: Power,
  options?: MctsOptions,
): MctsStats {
  const res = runMctsCore(state, forPower, options);
  if (res.forced) {
    const visitCounts = [{ action: res.action, visits: 1 }];
    const searchDebugRows = [{ action: res.action, visits: 1, prior: NaN, q: NaN }];
    return { action: res.action, visitCounts, searchVisitCounts: visitCounts, searchDebugRows, rootTrace: [] };
  }
  recordMctsStats(res);
  const searchVisitCounts: Array<{ action: Action; visits: number }> = [];
  const searchDebugRows: Array<{ action: Action; visits: number; prior: number; q: number }> = [];
  for (const child of res.root.children) {
    if (child.action !== null) {
      searchVisitCounts.push({ action: child.action, visits: child.visits });
      searchDebugRows.push({
        action: child.action,
        visits: child.visits,
        prior: res.cleanPriors ? res.cleanPriors(child.action) : child.prior,
        q: child.visits > 0 ? child.totalScores[child.action.power] / child.visits : NaN,
      });
    }
  }
  // Unexpanded root actions (visits 0) so consumers building targets from
  // priors + Q see every legal move, not only the ones search reached.
  for (const a of res.root.untriedActions) {
    searchDebugRows.push({ action: a, visits: 0, prior: res.cleanPriors ? res.cleanPriors(a) : NaN, q: NaN });
  }
  const action = bestAction(res.root);
  const visitCounts = pruneForcedPolicyTarget(res.root, res.forcedRootVisits);
  const rv = Math.max(1, res.root.visits);
  const rootQ = Object.fromEntries(
    (Object.keys(res.root.totalScores) as Power[]).map(p => [p, res.root.totalScores[p] / rv]),
  ) as Record<Power, number>;
  return { action, visitCounts, searchVisitCounts, searchDebugRows, rootQ, rootTrace: res.rootTrace };
}

function pruneForcedPolicyTarget(
  root: MctsNode,
  forcedRootVisits: ((action: Action) => number) | null,
): Array<{ action: Action; visits: number }> {
  const raw: Array<{ action: Action; visits: number }> = [];
  for (const child of root.children) {
    if (child.action !== null) raw.push({ action: child.action, visits: child.visits });
  }
  if (!forcedRootVisits || raw.length === 0) return raw;

  let best = raw[0]!;
  for (const row of raw) {
    if (row.visits > best.visits) best = row;
  }

  const pruned: Array<{ action: Action; visits: number }> = [];
  for (const row of raw) {
    if (row.action === best.action) {
      pruned.push(row);
      continue;
    }
    const adjusted = row.visits - forcedRootVisits(row.action);
    if (adjusted > 1) pruned.push({ action: row.action, visits: adjusted });
  }

  return pruned.length > 0 ? pruned : [{ action: best.action, visits: Math.max(1, best.visits) }];
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
function select(
  node: MctsNode,
  explorationC: number,
  usePuct: boolean,
  xarmSup: number,
  forcedRootVisits: ((action: Action) => number) | null = null,
  normMinSpan: number = 0,
): MctsNode {
  const useAzStyle = modelForPowerLoaded(node.forPower);
  let current = node;

  while (!isTerminal(current.state)) {
    const hasChildren = current.children.length > 0;
    const hasUntried = current.untriedActions.length > 0;
    if (!hasChildren && !hasUntried) break;

    if (current.parent === null && useAzStyle && forcedRootVisits) {
      const forced = pickForcedRootChild(current, forcedRootVisits);
      if (forced === 'expand-root') return current;
      if (forced !== null) return forced;
    }

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
    const bounds: QBounds = usePuct && normMinSpan > 0 ? childQBounds(current, xarmSup, normMinSpan) : null;
    let bestChildScore = -Infinity;
    let bestChild: MctsNode | null = null;
    for (const child of current.children) {
      const s = usePuct ? puct(child, explorationC, xarmSup, bounds) : ucb1(child, explorationC, xarmSup);
      if (s > bestChildScore) { bestChildScore = s; bestChild = child; }
    }

    let bestUntriedScore = -Infinity;
    let bestUntriedIdx = -1;
    if (hasUntried) {
      if (usePuct) {
        // If this node has network priors, use them. Otherwise use uniform
        // prior 1/N over legal actions at this node so PUCT's exploration term
        // has the right scale instead of treating every sibling as prior=1.
        const totalLegalHere = current.children.length + current.untriedActions.length;
        const fallbackPrior = totalLegalHere > 0 ? 1 / totalLegalHere : 1.0;
        for (let i = 0; i < current.untriedActions.length; i++) {
          const action = current.untriedActions[i]!;
          const prior = current.childPriors !== null ? current.childPriors(action) : fallbackPrior;
          const s = puctForUntriedAction(current, action, prior, explorationC, xarmSup, bounds);
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

function pickForcedRootChild(
  root: MctsNode,
  forcedRootVisits: (action: Action) => number,
): MctsNode | 'expand-root' | null {
  let bestChild: MctsNode | null = null;
  let bestUntriedIdx = -1;
  let bestDeficit = 0;
  let bestQuota = 0;

  for (const child of root.children) {
    if (child.action === null) continue;
    const quota = forcedRootVisits(child.action);
    const deficit = quota - child.visits;
    if (deficit > bestDeficit || (deficit === bestDeficit && quota > bestQuota)) {
      bestChild = child;
      bestUntriedIdx = -1;
      bestDeficit = deficit;
      bestQuota = quota;
    }
  }

  for (let i = 0; i < root.untriedActions.length; i++) {
    const action = root.untriedActions[i]!;
    const quota = forcedRootVisits(action);
    if (quota > bestDeficit || (quota === bestDeficit && quota > bestQuota)) {
      bestChild = null;
      bestUntriedIdx = i;
      bestDeficit = quota;
      bestQuota = quota;
    }
  }

  if (bestDeficit <= 0) return null;
  if (bestUntriedIdx >= 0) {
    const lastIdx = root.untriedActions.length - 1;
    if (bestUntriedIdx !== lastIdx) {
      const tmp = root.untriedActions[lastIdx]!;
      root.untriedActions[lastIdx] = root.untriedActions[bestUntriedIdx]!;
      root.untriedActions[bestUntriedIdx] = tmp;
    }
    return 'expand-root';
  }
  return bestChild;
}

/**
 * Expansion: pick one untried action from the node and create a child.
 * If the node is terminal or fully expanded, return the node itself.
 */
function expand(node: MctsNode, forPower: Power, cacheLeafScores: boolean): MctsNode {
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

  // Look up the prior for this child if the parent has a priors function.
  // If no network prior exists for this node/action kind, fall back to uniform
  // 1/N over the parent's legal actions so PUCT exploration scales correctly.
  const totalLegalHere = node.children.length + node.untriedActions.length + 1;
  const fallbackPrior = 1 / totalLegalHere;
  const childPrior = node.childPriors ? node.childPriors(action) : fallbackPrior;

  const child = createNode(
    newState, action, actingPower, node, forPower, childUntriedActions, childPrior,
  );
  if (cacheLeafScores && !isTerminal(newState)) {
    const policyPower = newState.pendingAction?.waitingFor;
    if (policyPower !== undefined) {
      const evalResult = evaluateAllPowersAndPolicyLearned(newState, policyPower);
      child.leafScores = evalResult.values;
      child.childPriors = makeChildPriors(newState, childUntriedActions, evalResult.policy);
    }
  } else {
    child.childPriors = makeChildPriors(newState, childUntriedActions);
  }
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

function shapeScoresWithRuinPressure(
  state: GameState,
  scores: Record<Power, number>,
  options?: MctsOptions,
): Record<Power, number> {
  const lambda = options?.ruinPressureLambda ?? 0;
  if (lambda <= 0) return scores;
  const maxRound = options?.ruinPressureMaxRound;
  if (maxRound !== undefined && state.round > maxRound) return scores;

  const pressure = computeRuinPressure(state);
  const shaped = { ...scores };
  const ruinPowers = ALL_POWERS.filter(p => p !== 'xarm');
  for (const p of ruinPowers) {
    let other = 0;
    for (const q of ruinPowers) {
      if (q !== p) other += pressure[q];
    }
    const relativePressure = pressure[p] - other / Math.max(1, ruinPowers.length - 1);
    shaped[p] = Math.min(Math.max(scores[p] + lambda * relativePressure, 0), 1);
  }
  return shaped;
}

function computeRuinPressure(state: GameState): Record<Power, number> {
  const pressure: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
  let totalWeight = 0;

  for (const region of Object.values(state.regions)) {
    if (!region || region.ruinationCardIndex !== null) continue;
    const resistance = Math.max(1, region.resistance || 1);
    const tokens = region.corruptionTokens;
    const total = ALL_POWERS.reduce((sum, p) => sum + Math.max(0, tokens[p] ?? 0), 0);
    if (total <= 0) continue;

    // Starts nudging once a region is a real project, then ramps smoothly
    // before the existing "near ruin" signals become obvious.
    const fill = total / resistance;
    const ramp = Math.min(Math.max((fill - 0.25) / 0.75, 0), 1);
    if (ramp <= 0) continue;
    const curve = ramp * ramp * (3 - 2 * ramp);
    const valueWeight = 0.75 + Math.min(Math.max(region.conquestValue, 1), 5) / 5;
    totalWeight += valueWeight;

    for (const p of ALL_POWERS) {
      const own = Math.max(0, tokens[p] ?? 0);
      if (own <= 0) continue;
      const share = own / total;
      const concentration = Math.min(own / resistance, 1);
      pressure[p] += valueWeight * curve * (0.6 * share + 0.4 * concentration);
    }
  }

  if (totalWeight > 0) {
    for (const p of ALL_POWERS) pressure[p] = Math.min(Math.max(pressure[p] / totalWeight, 0), 1);
  }
  return pressure;
}

/**
 * Sample a summoning action from the policy head's distribution. Returns
 * null if no policy head is loaded for the acting power (caller falls back
 * to biased-random). Skips filterPointlessActions per AI CLAUDE.md invariant.
 */
/** Highest-prior legal summoning action from the actor's policy head. */
function greedyPolicyAction(state: GameState, waitingFor: Power): Action | undefined {
  const raw = policyForState(state, waitingFor);
  if (raw === null) return undefined;
  const legal = getLegalActions(state, waitingFor);
  let best: Action | undefined;
  let bestP = -1;
  for (const a of legal) {
    const idx = canonicalActionIndex(a, state);
    const p = idx >= 0 ? raw[idx]! : 0;
    if (p > bestP) { bestP = p; best = a; }
  }
  return best;
}

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
 * Pass-out fast-forward for round-end leaf evaluation (MctsOptions.roundEndBlend).
 * Everyone passes the rest of the summoning phase; other decisions (hit
 * assignment, hero removal, dial rewards, world choices) take the first legal
 * option. Stops at the next round's first summoning decision, or at game end.
 * Returns null if the engine rejects an action or the cap is hit.
 */
function fastForwardRound(state: GameState, policyActions: number = 0): GameState | null {
  const startRound = state.round;
  let current = state;
  let policyLeft = policyActions;
  for (let steps = 0; steps < 600; steps++) {
    if (isTerminal(current)) return current;
    const pending = current.pendingAction;
    if (pending === null) return null;
    if (current.round !== startRound && pending.actionKind === 'summoning_action') return current;
    const who = pending.waitingFor;
    let candidates: Action[];
    if (pending.actionKind === 'summoning_action') {
      const pick = current.round === startRound && policyLeft > 0 ? greedyPolicyAction(current, who) : undefined;
      if (pick !== undefined) policyLeft -= 1;
      candidates = pick !== undefined
        ? [pick, { kind: 'summoning_pass', power: who } as Action]
        : [{ kind: 'summoning_pass', power: who } as Action];
    } else if (pending.actionKind === 'battle_hit_assignment') {
      // Some enumerated strategies under-allocate hits for the current board;
      // take the first one the engine accepts.
      candidates = [...enumerateBattleHitStrategies(current, who), ...enumerateKillActions(current, who)];
    } else {
      candidates = getLegalActions(current, who);
    }
    let next: GameState | null = null;
    for (const action of candidates) {
      try {
        next = applyAction(current, action).state;
        break;
      } catch {
        // try the next candidate
      }
    }
    if (next === null) return null;
    current = next;
  }
  return null;
}

function terminalScores(state: GameState): Record<Power, number> {
  const w = state.winners ?? [];
  return {
    xarm: w.includes('xarm') ? 1 : 0,
    gormen: w.includes('gormen') ? 1 : 0,
    tenzen: w.includes('tenzen') ? 1 : 0,
    lasha: w.includes('lasha') ? 1 : 0,
  };
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

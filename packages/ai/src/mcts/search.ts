import type { GameState, Action, Power } from '@ruin/engine';
import { applyAction, getLegalActions, makeRng, REGIONS } from '@ruin/engine';
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

const DEFAULT_ITERATIONS = 1500;
const DEFAULT_TIME_MS = 1000;
const DEFAULT_EXPLORATION_C = Math.SQRT2;
const MAX_ROLLOUT_DEPTH = 150;

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

  const legalRoot = getLegalActions(state, forPower);
  if (legalRoot.length === 0) {
    throw new Error(`runMcts: no legal actions for ${forPower}`);
  }
  // Fast path: only one legal action.
  if (legalRoot.length === 1) {
    return legalRoot[0]!;
  }

  // Prune the root action set to keep tree coverage manageable.
  const prunedRoot = pruneActions(state, forPower, legalRoot);

  const root = createNode(state, null, null, null, forPower, [...prunedRoot]);

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
 *
 * Uses a biased selection policy: in the summoning phase, pass actions are
 * chosen only ROLLOUT_AGGRESSION% of the time to simulate aggressive play.
 * All other phases use uniform random selection.
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
function pruneActions(state: GameState, power: Power, actions: Action[]): Action[] {
  if (actions.length <= MAX_ROOT_ACTIONS) return actions;

  // Only apply pruning for summoning actions.
  if (state.pendingAction?.actionKind !== 'summoning_action') return actions;

  const isLasha = power === 'lasha';
  const isXarm = power === 'xarm';
  const isGormen = power === 'gormen';

  // Score each action with a fast heuristic.
  type Scored = { action: Action; score: number };
  const scored: Scored[] = actions.map(action => {
    let score = 0;

    if (action.kind === 'summoning_pass') {
      score = -100;
    } else if (action.kind === 'summoning_play_card') {
      score = 50;
      const regionDef = REGIONS[action.toRegion];
      score += (regionDef?.baseValue ?? 1) * 3;
      const region = state.regions[action.toRegion];

      if (region) {
        const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);
        const myFigs = region.placements.filter(f => (f.controlledBy ?? f.power) === power).length;
        const enemyFigs = region.placements.filter(f => (f.controlledBy ?? f.power) !== power);
        const enemyCultists = enemyFigs.filter(f => f.class === 'cultist').length;
        const hasEnemy = enemyFigs.length > 0;

        // ── Card-specific effect scoring ─────────────────────────────────────
        // Cards whose effect requires specific conditions get a large penalty
        // when those conditions aren't met, and a bonus when they are.
        switch (action.cardId) {
          // Siphon Power: drains 1 PP per enemy cultist. Worthless with no enemies.
          case 'tenzen_siphon_power':
            score += enemyCultists * 12;
            if (!hasEnemy) score -= 60;
            break;

          // Shimmer: each opponent loses one cultist's worth of corruption contribution.
          // Only worthwhile if multiple opponents have cultists contributing here.
          case 'tenzen_shimmer': {
            const opponentCultistPowers = state.activePowers.filter(p =>
              p !== power && region.placements.some(f => (f.controlledBy ?? f.power) === p && f.class === 'cultist')
            ).length;
            score += opponentCultistPowers * 14;
            if (opponentCultistPowers === 0) score -= 40;
            break;
          }

          // Fate Shield: protects one own figure. Useless without own figures.
          case 'tenzen_fate_shield':
            score += myFigs * 8;
            if (myFigs === 0) score -= 60;
            break;

          // Teleport: moves own figure. Needs own figure present.
          case 'tenzen_teleport':
            if (myFigs === 0) score -= 50;
            break;

          // Null Weave: cancels all other card text in the region. Best where many cards played.
          case 'tenzen_changer_of_fate': {
            const cardCount = region.chaosCards.filter(c => c !== null).length;
            score += cardCount * 10;
            break;
          }

          // Recursive Pattern: kept if Tenzen kills. Only useful in contested regions.
          case 'tenzen_persistence_matrix':
            if (!hasEnemy) score -= 30;
            score += enemyFigs.length * 5;
            break;

          // Vile Consumption: sacrifice own figures for corruption. Needs own figures to sacrifice.
          case 'gormen_vile_consumption':
            score += myFigs * 10;
            if (myFigs === 0) score -= 70;
            break;

          // Rain of Bile: defense +1 for own figures. Useful only with own figures AND enemies.
          case 'gormen_rain_of_bile':
            score += myFigs * 8;
            if (!hasEnemy) score -= 30;
            if (myFigs === 0) score -= 40;
            break;

          // Pandemic: reduces resistance by 2. Most powerful in high-resistance regions with
          // existing corruption (makes ruination much more attainable).
          case 'gormen_pandemic':
            score += (region.resistance ?? 1) * 4;
            score += totalCorr * 3;
            break;

          // Decay: removes 1 corruption token. Best when disrupting a high-corruption rival.
          case 'gormen_decay': {
            const maxRivalCorr = Math.max(
              ...state.activePowers.filter(p => p !== power)
                .map(p => region.corruptionTokens[p] ?? 0)
            );
            score += maxRivalCorr * 8;
            if (totalCorr === 0) score -= 40;
            break;
          }

          // Ecstasy: no battle dice this round. Protects own figures. Best when lasha is
          // outnumbered and would lose a battle.
          case 'lasha_ecstasy':
            score += myFigs * 8;
            if (!hasEnemy) score -= 40;
            if (myFigs === 0) score -= 50; // nothing to protect
            break;

          // Narcotic Musk: control an enemy cultist. Requires enemy cultists.
          case 'lasha_narcotic_musk':
            score += enemyCultists * 12;
            if (enemyCultists === 0) score -= 70;
            break;

          // Hidden Influence: move a peasant/noble/hero token. Needs one present.
          case 'lasha_hidden_influence': {
            const hasToken = region.tokens.some(t => t === 'peasant' || t === 'noble' || t === 'hero');
            if (!hasToken) score -= 70;
            else score += 20;
            break;
          }

          // War Frenzy: rolls 2 pre-battle dice in THIS region before normal battle.
          // Extremely strong in contested regions — fires free dice that can wipe enemies
          // before they get to roll back. Totally wasted in empty regions.
          case 'xarm_war_frenzy':
            score += enemyFigs.length * 15;         // each enemy is a target for those free dice
            if (!hasEnemy) score -= 60;             // useless without enemies to hit
            break;

          // War Cry: no corruption placement. Best where opponents have high corruption potential.
          case 'xarm_war_cry':
            score += totalCorr * 5;
            score += hasEnemy ? 10 : -20;
            break;

          // Carnage Trap: traps enemy figures. Only useful with enemies present.
          case 'xarm_carnage_trap':
            score += enemyFigs.length * 10;
            if (!hasEnemy) score -= 50;
            break;

          // Ritual Death: draw per kill. Best when xarm has many figures and will kill a lot.
          case 'xarm_ritual_death':
            score += myFigs * 6;
            score += enemyFigs.length * 8;
            if (!hasEnemy) score -= 50;
            break;

          // Red Throne: domination uses attack sum. Best with many xarm warriors.
          case 'xarm_the_red_throne': {
            const myWarriors = region.placements.filter(
              f => (f.controlledBy ?? f.power) === 'xarm' && f.class === 'warrior'
            ).length;
            score += myWarriors * 10;
            break;
          }

          // Bloody Rebirth: extra battle round. Best in strongly contested regions.
          case 'xarm_bloody_rebirth':
            score += myFigs * 5;
            score += enemyFigs.length * 8;
            if (!hasEnemy) score -= 50;
            break;
        }

        if (isLasha) {
          // Play cards into high-corruption regions (Depraved Infiltration sneak, Hollow Pact spoil)
          if (region.ruinationCardIndex === null) score += totalCorr * 4;
          else score += 15;
        }

        if (isGormen) {
          // Play cards (Pandemic, Aura) into populous regions where gormen has or wants corruption
          if (region.populous) score += 12;
          score += (region.corruptionTokens['gormen'] ?? 0) * 3;
        }

        if (isXarm) {
          // Play battle cards where enemies are and xarm has presence.
          if (hasEnemy) score += 15;
          score += myFigs * 4; // stack effect — more xarm figures = battle cards more valuable
        }
      }
    } else if (action.kind === 'summoning_summon_figure') {
      const regionDef = REGIONS[action.toRegion];
      const baseValue = regionDef?.baseValue ?? 1;
      score += baseValue * 5;
      score += (regionDef?.populous ?? false) ? 10 : 0;

      const region = state.regions[action.toRegion];
      if (region) {
        const myFigures = region.placements.filter(f => (f.controlledBy ?? f.power) === power).length;
        const hasOpponent = region.placements.some(f => (f.controlledBy ?? f.power) !== power);
        score += myFigures * 3;
        score += hasOpponent ? 8 : 0;

        const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);

        // Compute xarm attack dice already in this region (used by xarm overkill check
        // and by other powers to identify dangerous regions to avoid).
        const hasHeartseekersUp = state.powers['xarm']?.upgradesInPlay.includes('xarm_heartseekers') ?? false;
        const cultistAttack = hasHeartseekersUp ? 1 : 0;
        const xarmAttackDice = region.placements
          .filter(f => (f.controlledBy ?? f.power) === 'xarm')
          .reduce((sum, f) => {
            if (f.class === 'cultist') return sum + cultistAttack;
            if (f.class === 'warrior') return sum + 2;
            if (f.class === 'incarnation') return sum + 4;
            return sum;
          }, 0);
        const enemyCount = region.placements.filter(f => (f.controlledBy ?? f.power) !== 'xarm').length;

        // General: placing a cultist into a region with enemy battle dice is asking to die.
        // A cultist contributes almost nothing in combat and will just hand the enemy a kill.
        // Any region without those dice is strictly better for a cultist, all else equal.
        const isCultistPlacement = action.followerId.includes('_cultist_');
        const isUpgradedXarmCultist = isXarm && isCultistPlacement && hasHeartseekersUp;
        if (isCultistPlacement && !isUpgradedXarmCultist) {
          const enemyAttackDice = region.placements
            .filter(f => (f.controlledBy ?? f.power) !== power)
            .reduce((sum, f) => {
              if (f.class === 'warrior') return sum + 2;
              if (f.class === 'incarnation') return sum + 4;
              return sum; // enemy cultists have low attack, cultists fighting cultists is fine
            }, 0);
          if (enemyAttackDice >= 2) score -= 20;  // 1 warrior already present — avoid
          if (enemyAttackDice >= 4) score -= 20;  // stacks: -40 for heavy presence
        }

        if (isLasha) {
          // Figures enable Musk/Hollow Pact in high-corruption regions
          score += totalCorr * 2;
          // Avoid xarm kill zones — high xarm attack presence means lasha figures die for nothing
          if (xarmAttackDice >= 4) score -= 20;
          if (xarmAttackDice >= 6) score -= 20; // stacks: -40 total for incarnation-level threat
        }

        if (isXarm) {
          // Three strategic pillars for xarm figure placement:
          //
          // 1. DAC acquisition — kill enemies to lead the dial race
          // 2. Domination prevention — stop opponents from scoring free VP
          // 3. Central positioning — long-term map control
          //
          // Notably absent: stacking bonuses. More xarm in one empty region is NOT
          // good — spread out and find fights.

          const isCentral = baseValue >= 3;
          const isPeripheral = baseValue <= 1;

          // Pillar 3: central positioning
          if (isCentral) score += 10;
          if (isPeripheral) score -= 15;

          // Pillar 1: DAC acquisition — each enemy figure is a potential kill/dial tick
          score += enemyCount * 8;

          // Pillar 2: domination prevention — if an opponent is scoring or about to score
          // in this region, contest it
          const maxOpponentCount = Math.max(0, ...state.activePowers
            .filter(p => p !== 'xarm')
            .map(p => region.placements.filter(f => (f.controlledBy ?? f.power) === p).length)
          );
          const resistance = region.resistance;
          if (maxOpponentCount >= resistance) score += 20;        // opponent already dominating
          else if (maxOpponentCount >= resistance - 1) score += 10; // one away from dominating

          // Ruin awareness: high corruption = ruin coming = be present
          score += totalCorr * 2;

          // Mild overkill guard: don't pile into a region already way over-invested
          if (enemyCount > 0 && xarmAttackDice >= enemyCount * 4) score -= 15;
          if (enemyCount === 0 && myFigures >= 1) score -= myFigures * 10; // don't stack in empty regions
        }

        if (isGormen) {
          // Spread cultists into new distinct regions (each adds a corruption placer)
          const isNewRegion = myFigures === 0;
          if (isNewRegion) score += 15;
          score += totalCorr * 2;
          // Avoid xarm kill zones — gormen cultists die cheaply to xarm warriors
          if (xarmAttackDice >= 4) score -= 15;
        }
      }
    }

    return { action, score };
  });

  // Sort descending by score, take top MAX_ROOT_ACTIONS.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_ROOT_ACTIONS).map(s => s.action);
}

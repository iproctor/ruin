import type {
  GameState, Power, Action, RegionId,
  SummonFigureAction, PlayCardAction, SummoningPassAction,
  TenzenDiscardAction, WorldChoiceAction, CorruptionHarvestChoiceAction,
  UpgradeChoiceAction, CardOnPlayChoiceAction, TokenType, BattleHitAssignmentAction,
  DialPlaceTokenAction, DialRemoveCorruptionAction, DialRemoveWorldTokenAction,
  HeroRemovalAction, RaptureChoiceAction,
} from './types.js';
import { REGION_ORDER, CARD_BY_ID, UPGRADES, ADJACENCY, FOLLOWERS } from './constants.js';
import {
  legalPlacementRegions, cardSlotsAvailable, isRuined, isWorldCardActive,
  followersInRegion,
} from './helpers.js';
import { getWorldChoiceRegions } from './phases/world.js';
import { getFollowerCost, getCardCost } from './phases/summoning.js';
import { effectiveDefense } from './phases/battle.js';
import type { Rng } from './dice.js';

const CLASS_IDX: Record<string, number> = { cultist: 0, warrior: 1, incarnation: 2 };
const REGION_IDX: Record<string, number> = Object.fromEntries(REGION_ORDER.map((r, i) => [r, i]));

const WORLD_THREE_REGION_CARDS = new Set(['chaos_storm']);
const WORLD_PAIR_CHOICE_CARDS = new Set(['northern_heir', 'ratmens_price']);

/**
 * Returns all legal actions for the given power in the current game state.
 * The pendingAction field defines what kind of action is currently required.
 */
export function getLegalActions(state: GameState, power: Power): Action[] {
  if (!state.pendingAction) return [];
  if (state.pendingAction.waitingFor !== power) return [];

  switch (state.pendingAction.actionKind) {
    case 'summoning_action':
      return getSummoningActions(state, power);

    case 'tenzen_discard':
      return getTenzenDiscardActions(state);

    case 'upgrade_choice':
      return getUpgradeChoiceActions(state, power);

    case 'corruption_harvest_choice':
      return getCorruptionHarvestActions(state, power);

    case 'card_on_play_choice':
      return getCardOnPlayChoiceActions(state, power);

    case 'forced_discard': {
      const ps = state.powers[power]!;
      const required = Math.min((state.pendingAction?.context['count'] as number) ?? 2, ps.hand.length);
      // Enumerate every distinct multiset of `required` cards drawn from the
      // hand. Earlier this returned single-card actions and relied on the
      // client to enforce the count — but bots pick one legal action and
      // submit it directly, so they only ever discarded one card. (Bug
      // observed against Meddling of Rats: AI discarded only 1 of the 2.)
      const counts = new Map<string, number>();
      for (const c of ps.hand) {
        if (c === '?') continue;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const unique = [...counts.entries()].map(([id, available]) => ({ id, available }));

      const combos: string[][] = [];
      const recurse = (startIdx: number, picked: string[], remaining: number): void => {
        if (remaining === 0) { combos.push(picked); return; }
        for (let i = startIdx; i < unique.length; i++) {
          const u = unique[i]!;
          const already = picked.filter(p => p === u.id).length;
          if (already < u.available) {
            recurse(i, [...picked, u.id], remaining - 1);
          }
        }
      };
      if (required > 0) recurse(0, [], required);
      else combos.push([]); // nothing in hand → submit empty

      return combos.map(cardIds => ({
        kind: 'forced_discard' as const,
        power,
        cardIds,
      }));
    }

    case 'dial_place_token': {
      const queue = state.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'place_token') return [];
      return REGION_ORDER
        .filter(r => state.regions[r]!.ruinationCardIndex === null)
        .map(regionId => ({ kind: 'dial_place_token' as const, power, regionId } satisfies DialPlaceTokenAction));
    }

    case 'tenzen_apprentice_choice': {
      const ctx = state.pendingAction.context;
      const followerId = ctx['followerId'] as string;
      const fromRegion = ctx['fromRegion'] as RegionId;
      const toRegion = ctx['toRegion'] as RegionId;
      // Two options: carry the chaos stone or leave it.
      return [
        { kind: 'tenzen_apprentice_choice', power: 'tenzen', followerId, fromRegion, toRegion, carry: true },
        { kind: 'tenzen_apprentice_choice', power: 'tenzen', followerId, fromRegion, toRegion, carry: false },
      ];
    }

    case 'rapture_choice': {
      const ctx = state.pendingAction.context;
      const regionId = ctx['regionId'] as RegionId;
      const candidateIds = (ctx['candidateIds'] as string[]) ?? [];
      return candidateIds.map(id => ({
        kind: 'rapture_choice',
        power: 'lasha',
        regionId,
        targetFollowerId: id,
      } satisfies RaptureChoiceAction));
    }

    case 'dial_remove_corruption': {
      const queue = state.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'remove_corruption') return [];
      // Remove ANY power's corruption from any region — the dial reward is
      // strategic: you can clean up your own to redeploy, OR strip an
      // opponent's contribution from a high-corruption region.
      const allPowers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
      const actions: DialRemoveCorruptionAction[] = [];
      for (const regionId of REGION_ORDER) {
        const region = state.regions[regionId]!;
        for (const targetPower of allPowers) {
          if ((region.corruptionTokens[targetPower] ?? 0) > 0) {
            actions.push({
              kind: 'dial_remove_corruption' as const,
              power,
              regionId,
              targetPower,
            });
          }
        }
      }
      return actions;
    }

    case 'dial_remove_world_token': {
      const queue = state.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'remove_world_tokens') return [];
      const actions: DialRemoveWorldTokenAction[] = [];
      for (const regionId of REGION_ORDER) {
        for (const tokenType of new Set(state.regions[regionId]!.tokens)) {
          actions.push({ kind: 'dial_remove_world_token' as const, power, regionId, tokenType } satisfies DialRemoveWorldTokenAction);
        }
      }
      return actions;
    }

    case 'battle_hit_assignment':
      // There is no finite "all legal actions" for hit assignment — the space
      // is exponential in the number of enemy figures. Callers must pick the
      // enumeration they want: `enumerateBattleHitStrategies` (a few cheap
      // hand-picked strategies, good for rollouts/greedy) or the AI package's
      // `enumerateKillActions` (richer per-(power, class) enumeration, used
      // at the MCTS root).
      throw new Error('getLegalActions: battle_hit_assignment has no finite legal set; call enumerateBattleHitStrategies or enumerateKillActions');

    case 'world_choice': {
      const cardId = state.pendingAction.context['cardId'] as string;
      const regions = getWorldChoiceRegions(state, cardId);

      // {pair: 'ab' | 'cd'} cards
      if (WORLD_PAIR_CHOICE_CARDS.has(cardId)) {
        return [
          { kind: 'world_choice' as const, power, cardId, choices: { pair: 'ab' } },
          { kind: 'world_choice' as const, power, cardId, choices: { pair: 'cd' } },
        ];
      }

      // diplomatic_envoy: place Noble on 3 different regions
      if (cardId === 'diplomatic_envoy') {
        const actions: WorldChoiceAction[] = [];
        for (let i = 0; i < regions.length; i++) {
          for (let j = i + 1; j < regions.length; j++) {
            for (let k = j + 1; k < regions.length; k++) {
              actions.push({ kind: 'world_choice', power, cardId, choices: { regions: [regions[i], regions[j], regions[k]] } });
            }
          }
        }
        if (actions.length === 0) {
          // Fewer than 3 regions available — use whatever we have
          actions.push({ kind: 'world_choice', power, cardId, choices: { regions: regions.slice(0, 3) } });
        }
        return actions;
      }

      // grand_muster: choose regions for peasants, heroes, and nobles (2 each)
      if (cardId === 'grand_muster') {
        // Simple strategy: split regions across the three types
        const r = regions;
        const peasantRegions = r.slice(0, 2);
        const heroRegions = r.slice(2, 4);
        const nobleRegions = r.slice(4, 6);
        return [{ kind: 'world_choice' as const, power, cardId, choices: { peasantRegions, heroRegions, nobleRegions } }];
      }

      // {regions: [r1, r2, r3]} cards
      if (WORLD_THREE_REGION_CARDS.has(cardId)) {
        const actions: WorldChoiceAction[] = [];
        for (let i = 0; i < regions.length; i++) {
          for (let j = i + 1; j < regions.length; j++) {
            for (let k = j + 1; k < regions.length; k++) {
              actions.push({ kind: 'world_choice', power, cardId, choices: { regions: [regions[i], regions[j], regions[k]] } });
            }
          }
        }
        if (actions.length === 0) {
          // Fewer than 3 regions available — use whatever we have
          actions.push({ kind: 'world_choice', power, cardId, choices: { regions: regions.slice(0, 3) } });
        }
        return actions;
      }

      // Default: {regionId} cards
      return regions.map(regionId => ({
        kind: 'world_choice' as const,
        power,
        cardId,
        choices: { regionId },
      }));
    }

    case 'hero_removal': {
      const regionId = state.pendingAction.context['regionId'] as RegionId;
      if (!state.regions[regionId]) return [];
      return followersInRegion(state, regionId)
        .filter(f => f.power === power)
        .map(f => ({
          kind: 'hero_removal' as const,
          power,
          followerId: f.id,
          regionId,
        } satisfies HeroRemovalAction));
    }

    case 'world_card_effect':
      // No interactive choice needed — submit empty choices
      return [{ kind: 'world_card_effect' as const, power, cardId: '', choices: {} }];

    default:
      return [];
  }
}

// ─── Battle hit assignment ────────────────────────────────────────────────────

type AnnotatedEnemy = { id: string; cls: string; def: number; atk: number };

function greedyKill(sorted: AnnotatedEnemy[], hitsRemaining: number): string[] {
  const ids: string[] = [];
  let spent = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (spent + a.def <= hitsRemaining) { ids.push(a.id); spent += a.def; }
  }
  return ids;
}

/**
 * Enumerate a small set of hand-picked battle-hit-assignment strategies
 * (cultists-first, highest-attack-first, most-kills + peasants). Used by
 * rollouts and the greedy AI fallback where a cheap sample of "reasonable"
 * choices is enough; MCTS at the root uses a richer enumeration instead.
 */
export function enumerateBattleHitStrategies(state: GameState, power: Power): BattleHitAssignmentAction[] {
  const ctx = state.pendingAction!.context;
  const regionId = ctx['regionId'] as RegionId;
  const hitsRemaining = ctx['hitsRemaining'] as number;
  const peasantsAvailable = (ctx['peasantsAvailable'] as number | undefined) ?? 0;
  const region = state.regions[regionId]!;

  const annotated: AnnotatedEnemy[] = [];
  for (const f of followersInRegion(state, regionId)) {
    const ctrl = f.controlledBy ?? f.power;
    if (ctrl === power || f.tipped || f.protected) continue;
    const def = effectiveDefense(state, regionId, f, power);
    const stats = FOLLOWERS[f.power as import('./types.js').Power]?.[f.class]?.base;
    annotated.push({ id: f.id, cls: f.class, def, atk: stats?.attack ?? 0 });
  }

  const actions: BattleHitAssignmentAction[] = [];
  const seen = new Set<string>();

  const add = (ids: string[], peasants = 0): void => {
    const key = [...ids].sort().join(',') + '|' + peasants;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(peasants > 0
      ? { kind: 'battle_hit_assignment', power, regionId, followerIds: ids, peasantsToTake: peasants }
      : { kind: 'battle_hit_assignment', power, regionId, followerIds: ids });
  };

  // Strategy 1: cultists first, then remaining enemies by cheapest def
  const cultistFirst = [
    ...annotated.filter(a => a.cls === 'cultist').sort((a, b) => a.def - b.def),
    ...annotated.filter(a => a.cls !== 'cultist').sort((a, b) => a.def - b.def),
  ];
  const cultistKills = greedyKill(cultistFirst, hitsRemaining);
  if (cultistKills.length > 0) add(cultistKills);

  // Strategy 2: highest attack first
  const attackFirst = annotated.slice().sort((a, b) => b.atk - a.atk || a.def - b.def);
  const attackKills = greedyKill(attackFirst, hitsRemaining);
  if (attackKills.length > 0) add(attackKills);

  // Strategy 3: most kills (cheapest def first)
  const countFirst = annotated.slice().sort((a, b) => a.def - b.def);
  const countKills = greedyKill(countFirst, hitsRemaining);
  if (countKills.length > 0) {
    // Build a defense lookup once so we don't do an O(n) find per kill.
    let spent = 0;
    const killSet = new Set(countKills);
    for (let i = 0; i < annotated.length; i++) {
      if (killSet.has(annotated[i]!.id)) spent += annotated[i]!.def;
    }
    const peasants = Math.min(hitsRemaining - spent, peasantsAvailable);
    add(countKills, peasants);
  }

  // If no enemy figures can be killed but peasants are available, must take peasants
  if (actions.length === 0 && peasantsAvailable > 0) {
    const peasants = Math.min(hitsRemaining, peasantsAvailable);
    add([], peasants);
  }

  if (actions.length === 0) {
    actions.push({ kind: 'battle_hit_assignment', power, regionId, followerIds: [] });
  }
  return actions;
}

// ─── Summoning actions ────────────────────────────────────────────────────────

function getSummoningActions(state: GameState, power: Power): Action[] {
  const actions: Action[] = [];
  const p = state.powers[power]!;

  if (p.powerPoints === 0 || p.passedSummoning) {
    return [{ kind: 'summoning_pass', power }];
  }

  // ── Summon / move figure actions ──────────────────────────────────────────
  // Collect all candidate summon actions, then deduplicate: followers of the
  // same class with identical strategic attributes (source region, protected,
  // controlledBy) moving to the same destination are interchangeable.  Keep
  // only the cheapest candidate per equivalence group so the AI doesn't waste
  // search time evaluating identical board states.
  const legalRegions = legalPlacementRegions(state, power);

  // Pre-compute region counts and move caches for board moves
  const regionCounts: Partial<Record<RegionId, number>> = {};
  for (const f of p.followers) {
    if (f.regionId !== null) regionCounts[f.regionId] = (regionCounts[f.regionId] ?? 0) + 1;
  }
  const moveCache = new Map<RegionId, RegionId[]>();

  // Gather every (follower, toRegion, cost) candidate
  type Candidate = { followerId: string; toRegion: RegionId; cost: number; key: string };
  const candidates: Candidate[] = [];

  const makeKey = (f: typeof p.followers[0], toRegion: RegionId) =>
    `${f.class}|${f.regionId ?? 'R'}|${toRegion}|${f.protected ? 1 : 0}|${f.controlledBy ?? ''}`;

  // Reserve figures
  for (const follower of p.followers) {
    if (follower.regionId !== null) continue;
    for (const regionId of legalRegions) {
      const cost = getFollowerCost(state, power, follower.class, follower.id, regionId);
      if (p.powerPoints < cost) continue;
      candidates.push({ followerId: follower.id, toRegion: regionId, cost, key: makeKey(follower, regionId) });
    }
  }

  // Board figures (own)
  for (const follower of p.followers) {
    if (follower.regionId === null) continue;
    if (follower.controlledBy && follower.controlledBy !== power) continue;
    const currentRegion = follower.regionId;
    const hasKillingGround = state.regions[currentRegion]!.chaosCards.some(
      c => c?.cardId === 'xarm_carnage_trap'
    );
    if (hasKillingGround && (follower.controlledBy ?? follower.power) !== 'xarm') continue;

    let legalRegionsForMove = moveCache.get(currentRegion);
    if (!legalRegionsForMove) {
      legalRegionsForMove = (regionCounts[currentRegion] ?? 0) > 1
        ? legalRegions
        : legalPlacementRegions(state, power, follower.id);
      moveCache.set(currentRegion, legalRegionsForMove);
    }
    for (const regionId of legalRegionsForMove) {
      if (regionId === follower.regionId) continue;
      const cost = getFollowerCost(state, power, follower.class, follower.id, regionId);
      if (p.powerPoints < cost) continue;
      candidates.push({ followerId: follower.id, toRegion: regionId, cost, key: makeKey(follower, regionId) });
    }
  }

  // Controlled figures (e.g. Narcotic Musk) — these are unique, no dedup needed
  for (const otherPower of state.activePowers) {
    if (otherPower === power) continue;
    for (const follower of state.powers[otherPower]!.followers) {
      if (follower.regionId === null) continue;
      if ((follower.controlledBy ?? follower.power) !== power) continue;
      const currentRegion = follower.regionId;
      const hasKillingGround = state.regions[currentRegion]!.chaosCards.some(
        c => c?.cardId === 'xarm_carnage_trap'
      );
      if (hasKillingGround && power !== 'xarm') continue;

      const movableRegions = legalPlacementRegions(state, power, follower.id);
      for (const regionId of movableRegions) {
        if (regionId === currentRegion) continue;
        const cost = getFollowerCost(state, power, follower.class, follower.id, regionId);
        if (p.powerPoints < cost) continue;
        actions.push({
          kind: 'summoning_summon_figure',
          power,
          followerId: follower.id,
          toRegion: regionId,
        } satisfies SummonFigureAction);
      }
    }
  }

  // Deduplicate own-figure candidates: keep cheapest per equivalence group
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = best.get(c.key);
    if (!prev || c.cost < prev.cost) best.set(c.key, c);
  }
  for (const c of best.values()) {
    actions.push({
      kind: 'summoning_summon_figure',
      power,
      followerId: c.followerId,
      toRegion: c.toRegion,
    } satisfies SummonFigureAction);
  }

  // Play card actions — dedupe so duplicate cards in hand don't produce identical actions
  const uniqueCards = [...new Set(p.hand)];
  for (const cardId of uniqueCards) {
    const def = CARD_BY_ID[cardId];
    if (!def) continue;
    // Cheap upper-bound prefilter: if the base cost alone is unaffordable
    // there's no region where it could become cheaper enough to matter.
    if (p.powerPoints < 0) continue;

    for (const regionId of REGION_ORDER) {
      const region = state.regions[regionId]!;
      if (isRuined(region)) continue;
      const available = cardSlotsAvailable(state, regionId);
      if (available === 0) continue;
      if (!isCardPlayableInRegion(state, power, cardId, regionId)) continue;

      // Cost depends on destination region (debauched royalty discount, etc).
      // Use the real getCardCost from the engine to avoid drift.
      const cost = getCardCost(state, power, cardId, regionId);
      if (p.powerPoints < cost) continue;

      for (let slot = 0; slot <= 1; slot++) {
        if (region.chaosCards[slot as 0 | 1] !== null) continue;
        // If this card needs a follow-up choice and there's exactly one legal
        // choice, bundle it so the play resolves without pausing.
        const unique = uniqueOnPlayChoice(state, cardId, power, regionId);
        actions.push({
          kind: 'summoning_play_card',
          power,
          cardId,
          toRegion: regionId,
          slotIndex: slot as 0 | 1,
          ...(unique ? { onPlayChoice: unique } : {}),
        } satisfies PlayCardAction);
        break; // Only one action per (card, region) pair — first available slot
      }
    }
  }

  // Pass
  actions.push({ kind: 'summoning_pass', power } satisfies SummoningPassAction);

  return actions;
}

/**
 * Sample a single legal summoning action for MCTS rollouts. Reservoir-samples
 * over the same candidate space as `getSummoningActions` but skips:
 *   - equivalence-class dedup (duplicate board states are fine in a rollout)
 *   - `uniqueOnPlayChoice` bundling (engine pauses via pendingAction and the
 *     rollout resolves the follow-up on the next ply)
 *   - full Action[] materialization (one allocation, not ~N)
 *
 * `preferNonPassProb` matches the rollout's existing aggression bias: with
 * that probability, return a uniform non-pass action; otherwise, return a
 * uniform mix over all legal actions (pass included). If no non-pass action
 * is legal, always returns pass.
 */
export function sampleLegalSummoningAction(
  state: GameState,
  power: Power,
  rng: Rng,
  preferNonPassProb = 1,
): Action {
  const p = state.powers[power]!;
  const pass: SummoningPassAction = { kind: 'summoning_pass', power };
  if (p.powerPoints === 0 || p.passedSummoning) return pass;

  const legalRegions = legalPlacementRegions(state, power);

  const regionCounts: Partial<Record<RegionId, number>> = {};
  for (const f of p.followers) {
    if (f.regionId !== null) regionCounts[f.regionId] = (regionCounts[f.regionId] ?? 0) + 1;
  }
  const moveCache = new Map<RegionId, RegionId[]>();

  let count = 0;
  let chosen: SummonFigureAction | PlayCardAction | null = null;
  const consider = (a: SummonFigureAction | PlayCardAction): void => {
    count += 1;
    if (rng() * count < 1) chosen = a;
  };

  // Group freely-movable figures by (class, regionId|null). Figures in the
  // same group are equivalent for action selection — cost depends on class
  // and destination, not which specific follower ID. Check cost once per
  // (class, destination), then weight the reservoir sample by group size.
  type FigureGroup = { cls: string; ids: string[]; regionId: RegionId | null };
  const groups: FigureGroup[] = [];
  const groupKey = new Map<string, FigureGroup>();
  for (const f of p.followers) {
    if (f.controlledBy && f.controlledBy !== power) continue;
    if (f.regionId !== null) {
      const hasKillingGround = state.regions[f.regionId]!.chaosCards.some(
        c => c?.cardId === 'xarm_carnage_trap',
      );
      if (hasKillingGround && (f.controlledBy ?? f.power) !== 'xarm') continue;
    }
    const k = `${f.class}|${f.regionId ?? 'R'}`;
    let g = groupKey.get(k);
    if (!g) { g = { cls: f.class, ids: [], regionId: f.regionId }; groupKey.set(k, g); groups.push(g); }
    g.ids.push(f.id);
  }

  // Flat cost cache: 3 classes × 9 regions. -1 = not computed yet.
  const costArr = new Int8Array(27).fill(-1);
  const getCost = (cls: string, clsIdx: number, repId: string, toRegionIdx: number, toRegion: RegionId): number => {
    const idx = clsIdx * 9 + toRegionIdx;
    let c = costArr[idx]!;
    if (c === -1) {
      c = getFollowerCost(state, power, cls as 'cultist' | 'warrior' | 'incarnation', repId, toRegion);
      costArr[idx] = c;
    }
    return c;
  };

  // Weighted reservoir sampling: advance count by N (group size), only
  // construct the action object when we actually select this group.
  let chosenGroup: FigureGroup | null = null;
  let chosenRegion: RegionId | null = null;

  for (const g of groups) {
    const repId = g.ids[0]!;
    const n = g.ids.length;
    const clsIdx = CLASS_IDX[g.cls] ?? 0;

    if (g.regionId === null) {
      for (const regionId of legalRegions) {
        if (p.powerPoints < getCost(g.cls, clsIdx, repId, REGION_IDX[regionId]!, regionId)) continue;
        count += n;
        if (rng() * count < n) { chosenGroup = g; chosenRegion = regionId; }
      }
    } else {
      const currentRegion = g.regionId;
      let legalRegionsForMove = moveCache.get(currentRegion);
      if (!legalRegionsForMove) {
        legalRegionsForMove = (regionCounts[currentRegion] ?? 0) > 1
          ? legalRegions
          : legalPlacementRegions(state, power, repId);
        moveCache.set(currentRegion, legalRegionsForMove);
      }
      for (const regionId of legalRegionsForMove) {
        if (regionId === currentRegion) continue;
        if (p.powerPoints < getCost(g.cls, clsIdx, repId, REGION_IDX[regionId]!, regionId)) continue;
        count += n;
        if (rng() * count < n) { chosenGroup = g; chosenRegion = regionId; }
      }
    }
  }

  // Card and controlled-figure candidates (materialized only at the end).
  let chosenCard: { cardId: string; toRegion: RegionId; slotIndex: 0 | 1 } | null = null;
  let chosenControlled: { followerId: string; toRegion: RegionId } | null = null;
  for (const otherPower of state.activePowers) {
    if (otherPower === power) continue;
    for (const follower of state.powers[otherPower]!.followers) {
      if (follower.regionId === null) continue;
      if ((follower.controlledBy ?? follower.power) !== power) continue;
      const currentRegion = follower.regionId;
      const hasKillingGround = state.regions[currentRegion]!.chaosCards.some(
        c => c?.cardId === 'xarm_carnage_trap',
      );
      if (hasKillingGround && power !== 'xarm') continue;

      const movableRegions = legalPlacementRegions(state, power, follower.id);
      for (const regionId of movableRegions) {
        if (regionId === currentRegion) continue;
        const cost = getFollowerCost(state, power, follower.class, follower.id, regionId);
        if (p.powerPoints < cost) continue;
        count += 1;
        if (rng() * count < 1) {
          chosenGroup = null; chosenCard = null;
          chosenControlled = { followerId: follower.id, toRegion: regionId };
        }
      }
    }
  }

  // Card plays — skip uniqueOnPlayChoice bundling; engine pauses via
  // pendingAction and the rollout picks up the follow-up next ply.
  const uniqueCards = new Set(p.hand);
  for (const cardId of uniqueCards) {
    if (!CARD_BY_ID[cardId]) continue;
    for (const regionId of REGION_ORDER) {
      const region = state.regions[regionId]!;
      if (isRuined(region)) continue;
      if (cardSlotsAvailable(state, regionId) === 0) continue;
      if (!isCardPlayableInRegion(state, power, cardId, regionId)) continue;
      const cost = getCardCost(state, power, cardId, regionId);
      if (p.powerPoints < cost) continue;
      const slotIndex: 0 | 1 | -1 =
        region.chaosCards[0] === null ? 0 :
        region.chaosCards[1] === null ? 1 : -1;
      if (slotIndex === -1) continue;
      count += 1;
      if (rng() * count < 1) {
        chosenGroup = null; chosenControlled = null;
        chosenCard = { cardId, toRegion: regionId, slotIndex };
      }
    }
  }

  // Materialize the chosen action.
  if (count === 0) return pass;
  const useNonPass = rng() < preferNonPassProb || rng() * (count + 1) >= 1;
  if (!useNonPass) return pass;

  if (chosenGroup && chosenRegion) {
    const pickId = chosenGroup.ids[Math.floor(rng() * chosenGroup.ids.length)]!;
    return { kind: 'summoning_summon_figure', power, followerId: pickId, toRegion: chosenRegion };
  }
  if (chosenControlled) {
    return { kind: 'summoning_summon_figure', power, followerId: chosenControlled.followerId, toRegion: chosenControlled.toRegion };
  }
  if (chosenCard) {
    return { kind: 'summoning_play_card', power, cardId: chosenCard.cardId, toRegion: chosenCard.toRegion, slotIndex: chosenCard.slotIndex };
  }
  return pass;
}

/**
 * For on-play-choice cards, returns the unique legal choice if there's only
 * one valid option, else null. Used by getLegalActions to bundle the choice
 * into the play-card action so the resolver can skip the pendingAction pause.
 */
function uniqueOnPlayChoice(
  state: GameState,
  cardId: string,
  power: Power,
  regionId: RegionId,
): Record<string, unknown> | null {
  switch (cardId) {
    case 'tenzen_the_meddling_of_rats': {
      const opponents = state.activePowers.filter(p =>
        p !== power && followersInRegion(state, regionId, p).length > 0,
      );
      return opponents.length === 1 ? { targetPower: opponents[0] } : null;
    }
    case 'tenzen_fate_shield': {
      const ownFigures = followersInRegion(state, regionId, power);
      return ownFigures.length === 1 ? { followerId: ownFigures[0]!.id } : null;
    }
    case 'lasha_narcotic_musk': {
      // Target an enemy cultist in the region
      const targets = followersInRegion(state, regionId).filter(f =>
        f.class === 'cultist' && (f.controlledBy ?? f.power) !== 'lasha',
      );
      return targets.length === 1 ? { followerId: targets[0]!.id } : null;
    }
    default:
      return null;
  }
}

/**
 * Returns false when a card has an on-play condition that isn't satisfied in the given region,
 * making it pointless (or impossible) to play there.
 */
function isCardPlayableInRegion(
  state: GameState,
  power: Power,
  cardId: string,
  regionId: RegionId,
): boolean {
  switch (cardId) {
    case 'xarm_call_to_war':
      // Requires own (non-musked) figures in at least one other region to move here
      return state.powers[power]!.followers.some(f =>
        f.regionId !== null && f.regionId !== regionId && (!f.controlledBy || f.controlledBy === power)
      );
    case 'tenzen_teleport':
      // Requires a cultist or warrior already in the region
      return followersInRegion(state, regionId).some(f => f.class === 'cultist' || f.class === 'warrior');
    case 'tenzen_the_meddling_of_rats':
      // Requires an opponent with figures AND cards in hand in this region
      return state.activePowers.some(p =>
        p !== power &&
        (state.powers[p]?.hand.length ?? 0) > 0 &&
        followersInRegion(state, regionId, p).length > 0
      );
    case 'tenzen_fate_shield':
      // Playable in any region — on-play choice falls back to any own figure on board
      return true;
    case 'lasha_narcotic_musk':
      // Requires an opponent cultist in the region
      return followersInRegion(state, regionId).some(f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== power);
    case 'lasha_hidden_influence':
      // Requires a movable token in the region
      return state.regions[regionId]!.tokens.some(t => t === 'peasant' || t === 'hero' || t === 'noble');
    default:
      return true;
  }
}

// ─── Tenzen discard actions ───────────────────────────────────────────────────

// Cards tenzen should never discard — their defensive/utility value is too
// high and too hard for the value head to assess at discard time.
const TENZEN_KEEP_CARDS = new Set([
  'tenzen_stasis_web',        // +2 cost for opponents in region
  'tenzen_teleport',          // move enemy attacker out
  'tenzen_changer_of_fate',   // nullify War Cry / War Frenzy
  'tenzen_fate_shield',       // protect a figure from death
]);

function getTenzenDiscardActions(state: GameState): TenzenDiscardAction[] {
  const hand = state.powers['tenzen']!.hand;
  const actions: TenzenDiscardAction[] = [
    { kind: 'tenzen_discard', power: 'tenzen', cardId: null }, // keep hand
  ];
  for (const cardId of new Set(hand)) {
    if (TENZEN_KEEP_CARDS.has(cardId)) continue; // never discard these
    actions.push({ kind: 'tenzen_discard', power: 'tenzen', cardId });
  }
  return actions;
}

// ─── Upgrade choice actions ───────────────────────────────────────────────────

function getUpgradeChoiceActions(state: GameState, power: Power): UpgradeChoiceAction[] {
  return state.powers[power]!.availableUpgradeIds.map(upgradeCardId => ({
    kind: 'upgrade_choice' as const,
    power,
    upgradeCardId,
  }));
}

// ─── Corruption's Harvest choice actions ─────────────────────────────────────

function getCorruptionHarvestActions(
  state: GameState,
  _power: Power,
): CorruptionHarvestChoiceAction[] {
  const ctx = state.pendingAction!.context as { regionId: string; maxKills: number };
  const regionId = ctx['regionId'] as import('./types.js').RegionId;
  const maxKills = ctx['maxKills'] as number;

  const targets = followersInRegion(state, regionId).filter(f => {
    const ctrl = f.controlledBy ?? f.power;
    return ctrl !== 'gormen' && (f.class === 'cultist' || f.class === 'warrior');
  });

  // Must kill exactly min(maxKills, targets). Only choice is WHICH targets.
  const killCount = Math.min(maxKills, targets.length);
  if (killCount === 0) {
    return [{
      kind: 'corruption_harvest_choice',
      power: 'gormen',
      regionId,
      followerIds: [],
    }];
  }

  // If killCount === targets.length, no choice — must kill all
  if (killCount >= targets.length) {
    return [{
      kind: 'corruption_harvest_choice',
      power: 'gormen',
      regionId,
      followerIds: targets.map(f => f.id),
    }];
  }

  // Generate all C(targets, killCount) combinations
  const actions: import('./types.js').CorruptionHarvestChoiceAction[] = [];
  function combo(start: number, chosen: string[]) {
    if (chosen.length === killCount) {
      actions.push({
        kind: 'corruption_harvest_choice',
        power: 'gormen',
        regionId,
        followerIds: [...chosen],
      });
      return;
    }
    for (let i = start; i < targets.length; i++) {
      combo(i + 1, [...chosen, targets[i]!.id]);
    }
  }
  combo(0, []);

  return actions;
}

// ─── Card on-play choice actions ──────────────────────────────────────────────

function getCardOnPlayChoiceActions(
  state: GameState,
  power: Power,
): CardOnPlayChoiceAction[] {
  const ctx = state.pendingAction!.context as { cardId: string; regionId: RegionId };
  const cardId = ctx['cardId'];
  const regionId = ctx['regionId'];
  const actions: CardOnPlayChoiceAction[] = [];

  const base = { kind: 'card_on_play_choice' as const, power, cardId, regionId };

  switch (cardId) {
    case 'xarm_call_to_war': {
      // Each own figure on board in a different (adjacent-connected) region
      const moveable = state.powers[power]!.followers.filter(
        f => f.regionId !== null && f.regionId !== regionId
      );
      // Return all subsets of up to 2 figures (simplified: individual + pairs)
      for (const f of moveable) {
        actions.push({ ...base, choices: { followerIds: [f.id] } });
      }
      for (let i = 0; i < moveable.length; i++) {
        for (let j = i + 1; j < moveable.length; j++) {
          actions.push({ ...base, choices: { followerIds: [moveable[i]!.id, moveable[j]!.id] } });
        }
      }
      if (actions.length === 0) actions.push({ ...base, choices: { followerIds: [] } });
      break;
    }

    case 'tenzen_teleport': {
      const moveable = followersInRegion(state, regionId).filter(
        f => f.class === 'cultist' || f.class === 'warrior'
      );
      for (const f of moveable) {
        for (const dest of REGION_ORDER) {
          if (dest !== regionId) {
            actions.push({ ...base, choices: { followerId: f.id, toRegion: dest } });
          }
        }
      }
      break;
    }

    case 'tenzen_the_meddling_of_rats': {
      // Per card text: must target an opponent WITH FIGURES IN THIS REGION.
      const opponents = state.activePowers.filter(p =>
        p !== power && followersInRegion(state, regionId, p).length > 0,
      );
      for (const targetPower of opponents) {
        actions.push({ ...base, choices: { targetPower } });
      }
      break;
    }

    case 'tenzen_fate_shield': {
      const ownFigures = followersInRegion(state, regionId, power);
      for (const f of ownFigures) {
        actions.push({ ...base, choices: { followerId: f.id } });
      }
      // Fallback: protect first own figure anywhere on board
      if (actions.length === 0) {
        const anyOwn = state.powers[power]!.followers.find(f => f.regionId !== null);
        if (anyOwn) actions.push({ ...base, choices: { followerId: anyOwn.id } });
      }
      break;
    }

    case 'lasha_hidden_influence': {
      const hiddenRegion = state.regions[regionId]!;
      const moveable = (['peasant', 'hero', 'noble'] as TokenType[]).filter(
        t => hiddenRegion.tokens.includes(t)
      );
      for (const token of moveable) {
        for (const dest of REGION_ORDER) {
          if (dest !== regionId) {
            actions.push({ ...base, choices: { token, fromRegion: regionId, toRegion: dest } });
          }
        }
      }
      break;
    }

    case 'lasha_narcotic_musk': {
      const targets = followersInRegion(state, regionId).filter(
        f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== power
      );
      for (const f of targets) {
        actions.push({ ...base, choices: { followerId: f.id } });
      }
      break;
    }
  }

  // Universal fallback: if no valid targets, submit a no-op (engine silently skips)
  if (actions.length === 0) {
    actions.push({ ...base, choices: {} });
  }

  return actions;
}

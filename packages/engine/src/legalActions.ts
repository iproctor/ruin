import type {
  GameState, Power, Action, RegionId,
  SummonFigureAction, PlayCardAction, SummoningPassAction,
  TenzenDiscardAction, WorldChoiceAction, CorruptionHarvestChoiceAction,
  UpgradeChoiceAction, CardOnPlayChoiceAction, TokenType, BattleHitAssignmentAction,
  DialPlaceTokenAction, DialRemoveCorruptionAction, DialRemoveWorldTokenAction,
  HeroRemovalAction,
} from './types.js';
import { REGION_ORDER, CARD_BY_ID, UPGRADES, ADJACENCY, FOLLOWERS } from './constants.js';
import {
  legalPlacementRegions, cardSlotsAvailable, isRuined, isWorldCardActive,
} from './helpers.js';
import { getWorldChoiceRegions } from './phases/world.js';

const WORLD_TWO_REGION_CARDS = new Set(['peasant_prosperity', 'ratmen_incursion', 'chaos_storm']);
const WORLD_PAIR_CHOICE_CARDS = new Set(['northern_heir', 'heroes_of_order']);

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
      const required = Math.min(ps.pendingForcedDiscards, ps.hand.length);
      const hand = ps.hand.filter(c => c !== '?');
      // Return one canonical action per card as a selection hint; client enforces count
      return hand.map(cardId => ({
        kind: 'forced_discard' as const,
        power,
        cardIds: [cardId],
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

    case 'dial_remove_corruption': {
      const queue = state.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'remove_corruption') return [];
      return REGION_ORDER
        .filter(r => state.regions[r]!.corruptionTokens[power] > 0)
        .map(regionId => ({ kind: 'dial_remove_corruption' as const, power, regionId } satisfies DialRemoveCorruptionAction));
    }

    case 'dial_remove_world_token': {
      const queue = state.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'remove_world_tokens') return [];
      const actions: DialRemoveWorldTokenAction[] = [];
      for (const regionId of REGION_ORDER) {
        const tokens = state.regions[regionId]!.tokens.filter(t => t !== 'chaos_stone');
        for (const tokenType of new Set(tokens)) {
          actions.push({ kind: 'dial_remove_world_token' as const, power, regionId, tokenType } satisfies DialRemoveWorldTokenAction);
        }
      }
      return actions;
    }

    case 'battle_hit_assignment': {
      const ctx = state.pendingAction!.context;
      const regionId = ctx['regionId'] as RegionId;
      const hitsRemaining = ctx['hitsRemaining'] as number;
      const peasantsAvailable = (ctx['peasantsAvailable'] as number | undefined) ?? 0;
      const region = state.regions[regionId]!;
      const enemies = region.placements.filter(f => {
        const ctrl = f.controlledBy ?? f.power;
        return ctrl !== power && !f.tipped && !f.protected;
      });

      // Annotate each enemy with stats (base values — good enough for AI)
      type Annotated = { f: typeof enemies[0]; def: number; atk: number };
      const annotated: Annotated[] = enemies.map(f => {
        const stats = FOLLOWERS[f.power as import('./types.js').Power]?.[f.class]?.base;
        return { f, def: stats?.defense ?? 1, atk: stats?.attack ?? 0 };
      });

      /** Greedy kill selection given a sorted priority list. */
      function greedyKill(sorted: Annotated[]): string[] {
        const ids: string[] = [];
        let spent = 0;
        for (const { f, def } of sorted) {
          if (spent + def <= hitsRemaining) { ids.push(f.id); spent += def; }
        }
        return ids;
      }

      const seen = new Set<string>();
      const makeAction = (ids: string[], peasants = 0): BattleHitAssignmentAction => peasants > 0
        ? { kind: 'battle_hit_assignment', power, regionId, followerIds: ids, peasantsToTake: peasants }
        : { kind: 'battle_hit_assignment', power, regionId, followerIds: ids };

      function add(ids: string[], peasants = 0) {
        const key = [...ids].sort().join(',') + '|' + peasants;
        if (seen.has(key)) return;
        seen.add(key);
        actions.push(makeAction(ids, peasants));
      }

      const actions: BattleHitAssignmentAction[] = [];

      // ── Strategy 1: Reduce corruption power — kill cultists first (cheapest def first)
      const cultistFirst = [...annotated]
        .filter(a => a.f.class === 'cultist')
        .sort((a, b) => a.def - b.def);
      const cultistKills = greedyKill(cultistFirst);
      if (cultistKills.length > 0) add(cultistKills);

      // ── Strategy 2: Reduce attack power — kill highest-attack figures first
      const attackFirst = [...annotated].sort((a, b) => b.atk - a.atk || a.def - b.def);
      const attackKills = greedyKill(attackFirst);
      if (attackKills.length > 0) add(attackKills);

      // ── Strategy 3: Reduce domination — kill as many figures as possible (cheapest def first)
      const countFirst = [...annotated].sort((a, b) => a.def - b.def);
      const countKills = greedyKill(countFirst);
      if (countKills.length > 0) {
        const leftover = hitsRemaining - countKills.reduce((s, id) => {
          const a = annotated.find(x => x.f.id === id)!;
          return s + a.def;
        }, 0);
        const peasants = Math.min(leftover, peasantsAvailable);
        add(countKills, peasants);
      }

      // Peasants are only claimed with leftover hits after kills — no standalone peasant actions

      // ── Fallback: pass (no kills, no peasants)
      if (actions.length === 0) {
        actions.push(makeAction([]));
      }

      return actions;
    }

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

      // grand_muster: choose regions for peasants, nobles, and ratmen (2 each)
      if (cardId === 'grand_muster') {
        // Simple strategy: split regions across the three types
        const r = regions;
        const peasantRegions = r.slice(0, 2);
        const nobleRegions = r.slice(2, 4);
        const ratmenRegions = r.slice(4, 6);
        return [{ kind: 'world_choice' as const, power, cardId, choices: { peasantRegions, nobleRegions, ratmenRegions } }];
      }

      // {regions: [r1, r2]} cards
      if (WORLD_TWO_REGION_CARDS.has(cardId)) {
        const actions: WorldChoiceAction[] = [];
        for (let i = 0; i < regions.length; i++) {
          for (let j = i + 1; j < regions.length; j++) {
            actions.push({ kind: 'world_choice', power, cardId, choices: { regions: [regions[i], regions[j]] } });
          }
        }
        if (regions.length === 1) {
          actions.push({ kind: 'world_choice', power, cardId, choices: { regions: [regions[0]] } });
        }
        return actions.length > 0 ? actions : [{ kind: 'world_choice', power, cardId, choices: { regions: [] } }];
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
      const region = state.regions[regionId];
      if (!region) return [];
      return region.placements
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

// ─── Summoning actions ────────────────────────────────────────────────────────

function getSummoningActions(state: GameState, power: Power): Action[] {
  const actions: Action[] = [];
  const p = state.powers[power]!;

  if (p.powerPoints === 0 || p.passedSummoning) {
    return [{ kind: 'summoning_pass', power }];
  }

  // Summon figure actions
  const legalRegions = legalPlacementRegions(state, power);
  for (const follower of p.followers) {
    if (follower.regionId !== null) continue; // only reserve figures
    for (const regionId of legalRegions) {
      const region = state.regions[regionId]!;
      if (isRuined(region)) continue;
      actions.push({
        kind: 'summoning_summon_figure',
        power,
        followerId: follower.id,
        toRegion: regionId,
      } satisfies SummonFigureAction);
    }
  }

  // Move figures already on board (re-summon to different region)
  for (const follower of p.followers) {
    if (follower.regionId === null) continue; // skip reserve
    // Killing Ground: cannot move non-Xarm figures away from a region with this card
    const currentRegion = follower.regionId;
    if (currentRegion !== null) {
      const hasKillingGround = state.regions[currentRegion]!.chaosCards.some(
        c => c?.cardId === 'xarm_carnage_trap'
      );
      if (hasKillingGround && (follower.controlledBy ?? follower.power) !== 'xarm') continue;
    }
    const legalRegionsForMove = legalPlacementRegions(state, power, follower.id);
    for (const regionId of legalRegionsForMove) {
      if (regionId === follower.regionId) continue; // skip same region
      const region = state.regions[regionId]!;
      if (isRuined(region)) continue;
      actions.push({
        kind: 'summoning_summon_figure',
        power,
        followerId: follower.id,
        toRegion: regionId,
      } satisfies SummonFigureAction);
    }
  }

  // Play card actions
  for (const cardId of p.hand) {
    const def = CARD_BY_ID[cardId];
    if (!def) continue;
    const cost = getCardCostForLegal(state, power, cardId);
    if (p.powerPoints < cost) continue;

    for (const regionId of REGION_ORDER) {
      const region = state.regions[regionId]!;
      if (isRuined(region)) continue;
      const available = cardSlotsAvailable(state, regionId);
      if (available === 0) continue;
      if (!isCardPlayableInRegion(state, power, cardId, regionId)) continue;

      for (let slot = 0; slot <= 1; slot++) {
        if (region.chaosCards[slot as 0 | 1] !== null) continue;
        actions.push({
          kind: 'summoning_play_card',
          power,
          cardId,
          toRegion: regionId,
          slotIndex: slot as 0 | 1,
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
 * Returns false when a card has an on-play condition that isn't satisfied in the given region,
 * making it pointless (or impossible) to play there.
 */
function isCardPlayableInRegion(
  state: GameState,
  power: Power,
  cardId: string,
  regionId: RegionId,
): boolean {
  const region = state.regions[regionId]!;
  switch (cardId) {
    case 'xarm_call_to_war':
      // Requires own figures in at least one other region to move here
      return state.powers[power]!.followers.some(f => f.regionId !== null && f.regionId !== regionId);
    case 'tenzen_teleport':
      // Requires a cultist or warrior already in the region
      return region.placements.some(f => f.class === 'cultist' || f.class === 'warrior');
    case 'tenzen_the_meddling_of_rats':
      // Requires an opponent with figures AND cards in hand in this region
      return state.activePowers.some(p =>
        p !== power &&
        (state.powers[p]?.hand.length ?? 0) > 0 &&
        region.placements.some(f => (f.controlledBy ?? f.power) === p)
      );
    case 'tenzen_fate_shield':
      // Requires own figure in the region
      return region.placements.some(f => (f.controlledBy ?? f.power) === power);
    case 'lasha_narcotic_musk':
      // Requires an opponent cultist in the region
      return region.placements.some(f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== power);
    case 'lasha_hidden_influence':
      // Requires a movable token in the region
      return region.tokens.some(t => t === 'peasant' || t === 'hero' || t === 'noble');
    default:
      return true;
  }
}

/** Card cost approximation for legal action generation (mirrors summoning.ts logic). */
function getCardCostForLegal(state: GameState, power: Power, cardId: string): number {
  const def = CARD_BY_ID[cardId]!;
  let cost = def.cost;

  if (cardId === 'lasha_debauched_royalty') {
    const totalCorr = Object.values(
      state.regions[REGION_ORDER[0]!]!.corruptionTokens
    ).reduce((a, b) => a + b, 0); // simplified — region not yet chosen
    if (totalCorr >= 3) cost = Math.max(0, cost - 3);
  }

  // Stasis Web in some region — simplified check (any region may have it)
  // Full cost validation is done in applySummonFigure/applyPlayCard
  return cost;
}

// ─── Tenzen discard actions ───────────────────────────────────────────────────

function getTenzenDiscardActions(state: GameState): TenzenDiscardAction[] {
  const hand = state.powers['tenzen']!.hand;
  const actions: TenzenDiscardAction[] = [
    { kind: 'tenzen_discard', power: 'tenzen', cardId: null }, // keep hand
  ];
  for (const cardId of hand) {
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

  const targets = state.regions[regionId]!.placements.filter(f => {
    const ctrl = f.controlledBy ?? f.power;
    return ctrl !== 'gormen' && (f.class === 'cultist' || f.class === 'warrior');
  });

  // Generate all subsets of size up to maxKills — simplified: return max kill action only
  // Full enumeration of subsets is expensive; for AI the full list is needed
  // For UI, the client will present choices; here we just return the max option
  const chosen = targets.slice(0, maxKills).map(f => f.id);
  if (chosen.length === 0) {
    return [{
      kind: 'corruption_harvest_choice',
      power: 'gormen',
      regionId,
      followerIds: [],
    }];
  }

  return [{
    kind: 'corruption_harvest_choice',
    power: 'gormen',
    regionId,
    followerIds: chosen,
  }];
}

// ─── Card on-play choice actions ──────────────────────────────────────────────

function getCardOnPlayChoiceActions(
  state: GameState,
  power: Power,
): CardOnPlayChoiceAction[] {
  const ctx = state.pendingAction!.context as { cardId: string; regionId: RegionId };
  const cardId = ctx['cardId'];
  const regionId = ctx['regionId'];
  const region = state.regions[regionId]!;
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
      const moveable = region.placements.filter(
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
      // Target any opponent with cards; if none, target any opponent (engine no-ops)
      const opponents = state.activePowers.filter(p => p !== power);
      for (const targetPower of opponents) {
        actions.push({ ...base, choices: { targetPower } });
      }
      break;
    }

    case 'tenzen_fate_shield': {
      const ownFigures = region.placements.filter(f => (f.controlledBy ?? f.power) === power);
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
      const moveable = (['peasant', 'hero', 'noble'] as TokenType[]).filter(
        t => region.tokens.includes(t)
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
      const targets = region.placements.filter(
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

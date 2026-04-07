import type {
  GameState, Power, Action, RegionId,
  SummonFigureAction, PlayCardAction, SummoningPassAction,
  TenzenDiscardAction, WorldChoiceAction, CorruptionHarvestChoiceAction,
  UpgradeChoiceAction, CardOnPlayChoiceAction, TokenType, BattleHitAssignmentAction,
  DialPlaceTokenAction, DialRemoveCorruptionAction, DialRemoveWorldTokenAction,
} from './types.js';
import { REGION_ORDER, CARD_BY_ID, UPGRADES, ADJACENCY } from './constants.js';
import {
  legalPlacementRegions, cardSlotsAvailable, isRuined, isWorldCardActive,
} from './helpers.js';

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
      const region = state.regions[regionId]!;
      const enemies = region.placements.filter(f => {
        const ctrl = f.controlledBy ?? f.power;
        return ctrl !== power && !f.tipped && !f.protected;
      });
      // Return each individual figure as a valid action (player can select multiple)
      // The UI handles enforcing the defense constraint
      return enemies.map(f => ({
        kind: 'battle_hit_assignment' as const,
        power,
        regionId,
        followerIds: [f.id],
      } satisfies BattleHitAssignmentAction));
    }

    // world_choice, hero_removal, world_card_effect handled separately (they are
    // context-specific and validated by the phase resolvers rather than enumerated here)
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
        c => c?.cardId === 'xarm_killing_ground'
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

/** Card cost approximation for legal action generation (mirrors summoning.ts logic). */
function getCardCostForLegal(state: GameState, power: Power, cardId: string): number {
  const def = CARD_BY_ID[cardId]!;
  let cost = def.cost;

  if (cardId === 'lasha_debauched_court') {
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
    case 'xarm_war_march': {
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

    case 'tenzen_phase_shift': {
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

    case 'tenzen_stolen_thoughts': {
      const opponents = state.activePowers.filter(
        p => p !== power && state.powers[p]!.hand.length > 0
      );
      for (const targetPower of opponents) {
        actions.push({ ...base, choices: { targetPower } });
      }
      break;
    }

    case 'tenzen_fates_aegis': {
      const ownFigures = region.placements.filter(f => (f.controlledBy ?? f.power) === power);
      for (const f of ownFigures) {
        actions.push({ ...base, choices: { followerId: f.id } });
      }
      break;
    }

    case 'lasha_invisible_hand': {
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

    case 'lasha_enthrallment': {
      const targets = region.placements.filter(
        f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== power
      );
      for (const f of targets) {
        actions.push({ ...base, choices: { followerId: f.id } });
      }
      break;
    }
  }

  return actions;
}

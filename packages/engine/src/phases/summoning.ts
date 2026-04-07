import type {
  GameState, Power, RegionId,
  SummonFigureAction, PlayCardAction, SummoningPassAction,
} from '../types.js';
import { CARD_BY_ID, FOLLOWERS, UPGRADES } from '../constants.js';
import {
  updatePower, updateRegion, legalPlacementRegions,
  cardSlotsAvailable, isRuined, followersInRegion, isWorldCardActive,
  scoreVP, addTokenToRegion,
} from '../helpers.js';

// ─── Summon a figure ──────────────────────────────────────────────────────────

export function applySummonFigure(
  state: GameState,
  action: SummonFigureAction,
): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s = state;
  const { power, followerId, toRegion } = action;
  const p = s.powers[power]!;

  const follower = p.followers.find(f => f.id === followerId);
  if (!follower) throw new Error(`Follower ${followerId} not found for ${power}`);

  const cost = getFollowerCost(s, power, follower.class, follower.id, toRegion);

  if (p.powerPoints < cost) throw new Error(`Not enough power points`);

  // Stasis Web: opponents pay +2 in this region
  const stasisActive = isWorldCardActive(s, 'tenzen_stasis_web') ||
    s.regions[toRegion]!.chaosCards.some(c => c?.cardId === 'tenzen_stasis_web');
  if (stasisActive && power !== 'tenzen') {
    // already accounted for in cost calculation below
  }

  // Killing Ground: non-Xarm figures cannot be moved away from a region with this card
  if (follower.regionId !== null) {
    const fromRegion = follower.regionId;
    const killingGround = s.regions[fromRegion]!.chaosCards.some(c => c?.cardId === 'xarm_carnage_trap');
    if (killingGround && (follower.controlledBy ?? follower.power) !== 'xarm') {
      throw new Error(`Killing Ground: ${power} figures cannot be moved away from ${fromRegion}`);
    }
  }

  // Remove from current region if on board
  if (follower.regionId !== null) {
    const fromRegion = follower.regionId;
    s = updateRegion(s, fromRegion, {
      placements: s.regions[fromRegion]!.placements.filter(f => f.id !== followerId),
    });
  }

  // Update follower
  const updatedFollower = { ...follower, regionId: toRegion };
  const updatedFollowers = p.followers.map(f => f.id === followerId ? updatedFollower : f);

  // Add to region placements
  s = updateRegion(s, toRegion, {
    placements: [...s.regions[toRegion]!.placements, updatedFollower],
  });

  // Deduct power points
  s = updatePower(s, power, {
    followers: updatedFollowers,
    powerPoints: p.powerPoints - cost,
  });

  // Gormen Plaguefather upgrade: place 2 corruption tokens on summon
  if (power === 'gormen' && follower.class === 'incarnation' &&
      s.powers['gormen']!.upgradesInPlay.includes('gormen_plaguefather_up')) {
    for (let i = 0; i < 2; i++) {
      s = updateRegion(s, toRegion, {
        corruptionTokens: {
          ...s.regions[toRegion]!.corruptionTokens,
          gormen: (s.regions[toRegion]!.corruptionTokens.gormen) + 1,
        },
      });
    }
    log.push(`Gormen Plaguefather places 2 corruption tokens in ${toRegion}.`);
  }

  // Tenzen Apprentice upgrade: carry Chaos Stone when moved from board
  if (power === 'tenzen' && follower.class === 'cultist' &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
      follower.regionId !== null) {
    const from = follower.regionId;
    if (s.regions[from]!.tokens.includes('chaos_stone') && s.tokenSupply.chaos_stone > 0) {
      s = updateRegion(s, from, {
        tokens: removeFirst(s.regions[from]!.tokens, 'chaos_stone'),
      });
      s = { ...s, tokenSupply: { ...s.tokenSupply, chaos_stone: s.tokenSupply.chaos_stone + 1 } };
      s = addTokenIfAvailable(s, toRegion, 'chaos_stone');
      log.push(`Tenzen Apprentice carries Chaos Stone from ${from} to ${toRegion}.`);
    }
  }

  log.push(`${power} summons ${follower.class} (${followerId}) to ${toRegion} (cost ${cost}).`);
  return { state: advanceSummoningTurn(s, power), log };
}

// ─── Play a chaos card ────────────────────────────────────────────────────────

export function applyPlayCard(
  state: GameState,
  action: PlayCardAction,
): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s = state;
  const { power, cardId, toRegion, slotIndex } = action;
  const p = s.powers[power]!;
  const cardDef = CARD_BY_ID[cardId];
  if (!cardDef) throw new Error(`Unknown card ${cardId}`);

  if (!p.hand.includes(cardId)) throw new Error(`Card ${cardId} not in hand`);
  if (cardSlotsAvailable(s, toRegion) === 0) throw new Error(`No card slots in ${toRegion}`);
  if (s.regions[toRegion]!.chaosCards[slotIndex] !== null) throw new Error(`Slot ${slotIndex} occupied`);
  if (isRuined(s.regions[toRegion]!)) throw new Error(`Cannot play cards to ruined region`);

  const cost = getCardCost(s, power, cardId, toRegion);
  if (p.powerPoints < cost) throw new Error(`Not enough power points`);

  // Remove from hand
  s = updatePower(s, power, {
    hand: p.hand.filter(id => id !== cardId),
    powerPoints: p.powerPoints - cost,
  });

  // Place on board
  const playedCard = { cardId, playedBy: power, slotIndex, persistNextRound: false };
  const newSlots = [...s.regions[toRegion]!.chaosCards] as [typeof playedCard | null, typeof playedCard | null];
  newSlots[slotIndex] = playedCard;
  s = updateRegion(s, toRegion, { chaosCards: newSlots });

  // Apply on_play effects
  s = applyOnPlayEffect(s, cardId, power, toRegion, log);

  // Tenzen Fractals upgrade: summon Fractal for free when playing magic symbol card
  if (power === 'tenzen' && cardDef.hasMagicSymbol &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_fractals_up')) {
    const reserve = s.powers['tenzen']!.followers.find(
      f => f.class === 'warrior' && f.regionId === null
    );
    if (reserve) {
      const updated = { ...reserve, regionId: toRegion };
      s = updatePower(s, 'tenzen', {
        followers: s.powers['tenzen']!.followers.map(f => f.id === reserve.id ? updated : f),
      });
      s = updateRegion(s, toRegion, {
        placements: [...s.regions[toRegion]!.placements, updated],
      });
      log.push(`Tenzen Fractals upgrade: free Fractal summoned to ${toRegion}.`);
    }
  }

  log.push(`${power} plays ${cardDef.name} to ${toRegion} (cost ${cost}).`);

  // Cards that require a follow-up choice pause summoning turn advancement
  if (needsOnPlayChoice(cardId)) {
    const hasValidTarget = hasOnPlayChoiceTarget(s, cardId, power, toRegion);
    if (hasValidTarget) {
      s = {
        ...s,
        pendingAction: {
          waitingFor: power,
          actionKind: 'card_on_play_choice',
          context: { cardId, regionId: toRegion },
        },
      };
      return { state: s, log };
    }
  }

  return { state: advanceSummoningTurn(s, power), log };
}

/** Returns false if there are no valid targets (skip the choice, advance turn). */
function hasOnPlayChoiceTarget(
  state: GameState,
  cardId: string,
  power: Power,
  regionId: RegionId,
): boolean {
  const region = state.regions[regionId]!;
  switch (cardId) {
    case 'xarm_call_to_war':
      // Any own figure on the board in a different region
      return state.powers[power]!.followers.some(f => f.regionId !== null && f.regionId !== regionId);
    case 'tenzen_teleport':
      return region.placements.some(f => f.class === 'cultist' || f.class === 'warrior');
    case 'tenzen_the_meddling_of_rats':
      return state.activePowers.some(p => p !== power && state.powers[p]!.hand.length > 0);
    case 'tenzen_fate_shield':
      return region.placements.some(f => (f.controlledBy ?? f.power) === power);
    case 'lasha_hidden_influence':
      return region.tokens.some(t => t === 'peasant' || t === 'hero' || t === 'noble');
    case 'lasha_narcotic_musk':
      return region.placements.some(f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== power);
    default:
      return false;
  }
}

// ─── Pass ─────────────────────────────────────────────────────────────────────

export function applySummoningPass(
  state: GameState,
  action: SummoningPassAction,
): { state: GameState; log: string[] } {
  const { power } = action;
  let s = updatePower(state, power, { powerPoints: 0, passedSummoning: true });
  const log = [`${power} passes summoning.`];
  return { state: advanceSummoningTurn(s, power), log };
}

// ─── Turn advancement ─────────────────────────────────────────────────────────

export function advanceSummoningTurn(state: GameState, _justActed: Power): GameState {
  const activePowers = state.summoningOrder;

  // Check if all are done (power points = 0 or passedSummoning)
  const allDone = activePowers.every(p => {
    const ps = state.powers[p]!;
    return ps.powerPoints === 0 || ps.passedSummoning;
  });

  if (allDone) {
    return {
      ...state,
      phase: 'battle',
      pendingAction: null,
      summoningIndex: 0,
    };
  }

  // Advance to next power with power points remaining
  let next = (state.summoningIndex + 1) % activePowers.length;
  let iterations = 0;
  while (iterations < activePowers.length) {
    const candidate = activePowers[next]!;
    const ps = state.powers[candidate]!;
    if (ps.powerPoints > 0 && !ps.passedSummoning) break;
    next = (next + 1) % activePowers.length;
    iterations++;
  }

  const nextPower = activePowers[next]!;
  const nextPs = state.powers[nextPower]!;

  // If the next player has queued forced discards, handle them
  if (nextPs.pendingForcedDiscards > 0) {
    const required = Math.min(nextPs.pendingForcedDiscards, nextPs.hand.length);

    // If they have more cards than required, they must choose — show the panel
    if (nextPs.hand.length > required) {
      return {
        ...state,
        summoningIndex: next,
        pendingAction: {
          waitingFor: nextPower,
          actionKind: 'forced_discard',
          context: { count: required },
        },
      };
    }

    // Otherwise auto-discard all (0 or <= required cards — no meaningful choice)
    const toDiscard = nextPs.hand.slice(0, required);
    const autoState = {
      ...state,
      powers: {
        ...state.powers,
        [nextPower]: {
          ...nextPs,
          hand: nextPs.hand.slice(required),
          discardIds: [...nextPs.discardIds, ...toDiscard],
          pendingForcedDiscards: 0,
        },
      },
    };
    return {
      ...autoState,
      summoningIndex: next,
      pendingAction: {
        waitingFor: nextPower,
        actionKind: 'summoning_action',
        context: {},
      },
    };
  }

  const clearedState = state;

  return {
    ...clearedState,
    summoningIndex: next,
    pendingAction: {
      waitingFor: nextPower,
      actionKind: 'summoning_action',
      context: {},
    },
  };
}

// ─── Cost calculations ────────────────────────────────────────────────────────

function getFollowerCost(
  state: GameState,
  power: Power,
  cls: 'cultist' | 'warrior' | 'incarnation',
  followerId: string,
  toRegion: RegionId,
): number {
  const def = FOLLOWERS[power]![cls]!;
  let cost = state.powers[power]!.upgradesInPlay.some(u =>
    UPGRADES.find(up => up.id === u)?.upgradeType === cls
  ) ? (def.upgraded.cost) : def.base.cost;

  // Gormen free Plaguecarrier in empty region
  if (power === 'gormen' && cls === 'cultist' &&
      state.powers['gormen']!.upgradesInPlay.includes('gormen_plaguecarriers_up')) {
    const hasOtherFigures = state.regions[toRegion]!.placements.some(
      f => f.power === 'gormen' && f.id !== followerId
    );
    if (!hasOtherFigures) cost = 0;
  }

  // Stasis Web: +2 for non-Tenzen in regions with Stasis Web card
  const region = state.regions[toRegion]!;
  if (power !== 'tenzen' && region.chaosCards.some(c => c?.cardId === 'tenzen_stasis_web')) {
    cost += 2;
  }

  return cost;
}

function getCardCost(state: GameState, power: Power, cardId: string, toRegion: RegionId): number {
  const def = CARD_BY_ID[cardId]!;
  let cost = def.cost;

  // Lasha Debauched Court: -3 if region has 3+ corruption tokens
  if (cardId === 'lasha_debauched_royalty') {
    const totalCorr = Object.values(state.regions[toRegion]!.corruptionTokens).reduce((a, b) => a + b, 0);
    if (totalCorr >= 3) cost = Math.max(0, cost - 3);
  }

  // Stasis Web: +2 for non-Tenzen
  if (power !== 'tenzen' && state.regions[toRegion]!.chaosCards.some(c => c?.cardId === 'tenzen_stasis_web')) {
    cost += 2;
  }

  return cost;
}

// ─── On-play card effects ─────────────────────────────────────────────────────

/** Cards whose on-play effect requires a follow-up player choice (card_on_play_choice action). */
const NEEDS_PLAY_CHOICE = new Set([
  'xarm_call_to_war',
  'tenzen_teleport',
  'tenzen_the_meddling_of_rats',
  'tenzen_fate_shield',
  'lasha_hidden_influence',
  'lasha_narcotic_musk',
]);

export function needsOnPlayChoice(cardId: string): boolean {
  return NEEDS_PLAY_CHOICE.has(cardId);
}

function applyOnPlayEffect(
  state: GameState,
  cardId: string,
  power: Power,
  regionId: RegionId,
  log: string[],
): GameState {
  let s = state;
  switch (cardId) {
    case 'xarm_call_to_war':
    case 'tenzen_teleport':
    case 'tenzen_the_meddling_of_rats':
    case 'tenzen_fate_shield':
    case 'lasha_hidden_influence':
    case 'lasha_narcotic_musk': {
      // These require a follow-up card_on_play_choice action.
      // pendingAction is set by applyPlayCard after calling this function.
      break;
    }
    case 'gormen_decay': {
      // Remove one corruption token from any player in this region
      const region = s.regions[regionId]!;
      for (const p of s.activePowers) {
        if (region.corruptionTokens[p] > 0) {
          s = updateRegion(s, regionId, {
            corruptionTokens: { ...region.corruptionTokens, [p]: region.corruptionTokens[p] - 1 },
          });
          log.push(`Gormen Entropy removes 1 ${p} corruption token from ${regionId}.`);
          break;
        }
      }
      break;
    }
    case 'gormen_vile_consumption':
      // No on-play effect. Effect fires at end of corruption phase (after corruption
      // placement, before ruination check) — handled in resolveCorruption.
      break;
    case 'tenzen_siphon_power': {
      const region = s.regions[regionId]!;
      let gained = 0;
      for (const p of s.activePowers) {
        if (p === power) continue;
        if (region.placements.some(f => (f.controlledBy ?? f.power) === p && f.class === 'cultist')) {
          const pp = s.powers[p]!.powerPoints;
          s = updatePower(s, p, { powerPoints: Math.max(0, pp - 1) });
          gained = 1;
        }
      }
      if (gained) {
        s = updatePower(s, power, { powerPoints: s.powers[power]!.powerPoints + 1 });
        log.push(`Tenzen Arcane Siphon: gained 1 PP.`);
      }
      break;
    }
    case 'lasha_depraved_infiltration': {
      s = updateRegion(s, regionId, {
        corruptionTokens: {
          ...s.regions[regionId]!.corruptionTokens,
          lasha: s.regions[regionId]!.corruptionTokens.lasha + 1,
        },
      });
      log.push(`Lasha Silent Taint: 1 corruption token placed in ${regionId} (no dial trigger).`);
      break;
    }
    case 'lasha_debauched_royalty': {
      // Cost reduction applied above; no additional effect on play
      break;
    }
  }
  return s;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function removeFirst<T>(arr: T[], item: T): T[] {
  const idx = arr.indexOf(item);
  if (idx === -1) return arr;
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

function addTokenIfAvailable(state: GameState, regionId: RegionId, token: 'chaos_stone'): GameState {
  if (state.tokenSupply[token] <= 0) return state;
  const s = addTokenToRegion(state, regionId, token);
  return { ...s, tokenSupply: { ...s.tokenSupply, [token]: s.tokenSupply[token] - 1 } };
}

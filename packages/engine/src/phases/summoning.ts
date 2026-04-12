import type {
  GameState, Power, RegionId,
  SummonFigureAction, PlayCardAction, SummoningPassAction,
  TenzenApprenticeChoiceAction,
} from '../types.js';
import { CARD_BY_ID, FOLLOWERS, UPGRADES, UPGRADE_BY_ID } from '../constants.js';
import { GameLog } from '../gameLog.js';
import {
  updatePower, updateRegion, legalPlacementRegions,
  cardSlotsAvailable, isRuined, followersInRegion, isWorldCardActive,
  scoreVP, addTokenToRegion,
} from '../helpers.js';

// ─── Summon a figure ──────────────────────────────────────────────────────────

export function applySummonFigure(
  state: GameState,
  action: SummonFigureAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s = state;
  const { power, followerId, toRegion } = action;
  const p = s.powers[power]!;

  // Look in acting power's followers first, then check other powers for controlled figures
  let follower = p.followers.find(f => f.id === followerId);
  let ownerPower = power;
  if (!follower) {
    for (const op of s.activePowers) {
      if (op === power) continue;
      const f = s.powers[op]!.followers.find(f => f.id === followerId && f.controlledBy === power);
      if (f) { follower = f; ownerPower = op; break; }
    }
  }
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
  const updatedFollower = { ...follower, regionId: toRegion, placedAt: s.actionCount };

  // Add to region placements
  s = updateRegion(s, toRegion, {
    placements: [...s.regions[toRegion]!.placements, updatedFollower],
  });

  // Update the follower in its owner's array (may differ from acting power for controlled figures)
  s = updatePower(s, ownerPower, {
    followers: s.powers[ownerPower]!.followers.map(f => f.id === followerId ? updatedFollower : f),
  });

  // Deduct power points from the acting power
  s = updatePower(s, power, {
    powerPoints: s.powers[power]!.powerPoints - cost,
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
    log.emit({ type: 'card_effect', subtype: 'plaguefather_corruption', power, regionId: toRegion, tokens: 2 });
  }

  // Reject carry: true if conditions aren't met
  if (action.carry === true) {
    const canCarry = power === 'tenzen' && follower.class === 'cultist' &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
      follower.regionId !== null &&
      s.regions[follower.regionId]!.tokens.includes('chaos_stone');
    if (!canCarry) throw new Error('Cannot carry: no chaos stone in source region or conditions not met');
  }

  // Tenzen Apprentice upgrade: carry Chaos Stone when moved from board.
  // If `carry` is provided in the action, apply it inline. If not (legacy/AI
  // without the field), fall back to pausing with a pending action.
  if (power === 'tenzen' && follower.class === 'cultist' &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
      follower.regionId !== null) {
    const from = follower.regionId;
    if (s.regions[from]!.tokens.includes('chaos_stone')) {
      log.emit({ type: 'summon_figure', power, followerId, followerClass: follower.class, toRegion, fromRegion: follower.regionId, cost });

      if (action.carry !== undefined) {
        // Carry decision bundled into the summon action
        if (action.carry) {
          s = updateRegion(s, from, {
            tokens: removeFirst(s.regions[from]!.tokens, 'chaos_stone'),
          });
          s = { ...s, tokenSupply: { ...s.tokenSupply, chaos_stone: s.tokenSupply.chaos_stone + 1 } };
          s = addTokenIfAvailable(s, toRegion, 'chaos_stone');
          log.emit({ type: 'apprentice_choice', followerId, fromRegion: from, toRegion, carry: true });
        } else {
          log.emit({ type: 'apprentice_choice', followerId, fromRegion: from, toRegion, carry: false });
        }
        return { state: advanceSummoningTurn(s, power, log), log };
      }

      // Legacy fallback: pause for separate choice action
      s = {
        ...s,
        pendingAction: {
          waitingFor: 'tenzen',
          actionKind: 'tenzen_apprentice_choice',
          context: { followerId, fromRegion: from, toRegion },
        },
      };
      log.emit({ type: 'awaiting_action', power: 'tenzen', actionKind: 'tenzen_apprentice_choice', context: { followerId, fromRegion: from, toRegion }, description: `Tenzen apprentice: carry Chaos Stone from ${from}?` });
      return { state: s, log };
    }
  }

  log.emit({ type: 'summon_figure', power, followerId, followerClass: follower.class, toRegion, fromRegion: follower.regionId, cost });
  return { state: advanceSummoningTurn(s, power, log), log };
}

// ─── Play a chaos card ────────────────────────────────────────────────────────

export function applyPlayCard(
  state: GameState,
  action: PlayCardAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
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

  // Remove one copy from hand
  const handIdx = p.hand.indexOf(cardId);
  if (handIdx === -1) throw new Error(`Card ${cardId} not in ${power}'s hand`);
  const newHand = [...p.hand.slice(0, handIdx), ...p.hand.slice(handIdx + 1)];
  s = updatePower(s, power, {
    hand: newHand,
    powerPoints: p.powerPoints - cost,
  });

  // Place on board
  const playedCard = { cardId, playedBy: power, slotIndex, persistNextRound: false, placedAt: s.actionCount };
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
      const updated = { ...reserve, regionId: toRegion, placedAt: s.actionCount };
      s = updatePower(s, 'tenzen', {
        followers: s.powers['tenzen']!.followers.map(f => f.id === reserve.id ? updated : f),
      });
      s = updateRegion(s, toRegion, {
        placements: [...s.regions[toRegion]!.placements, updated],
      });
      log.emit({ type: 'card_effect', subtype: 'fractals_summon', regionId: toRegion, followerName: FOLLOWERS.tenzen.warrior.name.replace(/s$/, '') });
    }
  }

  log.emit({ type: 'play_card', power, cardId, cardName: cardDef.name, toRegion, slotIndex, cost });

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
      log.emit({ type: 'awaiting_action', power, actionKind: 'card_on_play_choice', context: { cardId, regionId: toRegion }, description: `${power} must choose for ${cardDef.name}.` });
      return { state: s, log };
    }
  }

  return { state: advanceSummoningTurn(s, power, log), log };
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
): { state: GameState; log: GameLog } {
  const { power } = action;
  let s = updatePower(state, power, { powerPoints: 0, passedSummoning: true });
  const log = new GameLog();
  log.emit({ type: 'summoning_pass', power });
  return { state: advanceSummoningTurn(s, power, log), log };
}

// ─── Tenzen Apprentices: chaos stone carry choice ────────────────────────────

export function applyTenzenApprenticeChoice(
  state: GameState,
  action: TenzenApprenticeChoiceAction,
): { state: GameState; log: GameLog } {
  let s = state;
  const log = new GameLog();
  if (action.carry) {
    const fromRegion = s.regions[action.fromRegion];
    if (fromRegion && fromRegion.tokens.includes('chaos_stone') && s.tokenSupply.chaos_stone >= 0) {
      // Move the chaos stone from origin to destination.
      s = updateRegion(s, action.fromRegion, {
        tokens: removeFirst(fromRegion.tokens, 'chaos_stone'),
      });
      // Return to supply briefly so addTokenIfAvailable will use it.
      s = { ...s, tokenSupply: { ...s.tokenSupply, chaos_stone: s.tokenSupply.chaos_stone + 1 } };
      s = addTokenIfAvailable(s, action.toRegion, 'chaos_stone');
      log.emit({ type: 'apprentice_choice', followerId: action.followerId, fromRegion: action.fromRegion, toRegion: action.toRegion, carry: true });
    }
  } else {
    log.emit({ type: 'apprentice_choice', followerId: action.followerId, fromRegion: action.fromRegion, toRegion: action.toRegion, carry: false });
  }
  // Clear the pending action and resume the summoning turn order.
  s = { ...s, pendingAction: null };
  return { state: advanceSummoningTurn(s, 'tenzen', log), log };
}

// ─── Turn advancement ─────────────────────────────────────────────────────────

export function advanceSummoningTurn(state: GameState, justActed: Power, log?: GameLog): GameState {
  // Record when this power's turn ended, so next time it's their turn
  // the client can highlight everything placed since this point.
  let base = updatePower(state, justActed, { lastSummonTurnAt: state.actionCount });
  const activePowers = base.summoningOrder;

  // Check if all are done (power points = 0 or passedSummoning)
  const allDone = activePowers.every(p => {
    const ps = base.powers[p]!;
    return ps.powerPoints === 0 || ps.passedSummoning;
  });

  if (allDone) {
    return {
      ...base,
      phase: 'battle',
      pendingAction: null,
      summoningIndex: 0,
    };
  }

  // Advance to next power with power points remaining
  let next = (base.summoningIndex + 1) % activePowers.length;
  let iterations = 0;
  while (iterations < activePowers.length) {
    const candidate = activePowers[next]!;
    const ps = base.powers[candidate]!;
    if (ps.powerPoints > 0 && !ps.passedSummoning) break;
    next = (next + 1) % activePowers.length;
    iterations++;
  }

  const nextPower = activePowers[next]!;
  const nextPs = base.powers[nextPower]!;

  // If the next player has queued forced discards, handle them
  if (nextPs.pendingForcedDiscards > 0) {
    const required = Math.min(nextPs.pendingForcedDiscards, nextPs.hand.length);

    // If they have more cards than required, they must choose — show the panel
    if (nextPs.hand.length > required) {
      log?.emit({ type: 'awaiting_action', power: nextPower, actionKind: 'forced_discard', context: { count: required }, description: `${nextPower} must discard ${required} card(s).` });
      return {
        ...base,
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
    log?.emit({ type: 'awaiting_action', power: nextPower, actionKind: 'summoning_action', context: {}, description: `${nextPower}'s turn to summon.` });
    return {
      ...base,
      powers: {
        ...base.powers,
        [nextPower]: {
          ...nextPs,
          hand: nextPs.hand.slice(required),
          discardIds: [...nextPs.discardIds, ...toDiscard],
          pendingForcedDiscards: 0,
        },
      },
      summoningIndex: next,
      pendingAction: {
        waitingFor: nextPower,
        actionKind: 'summoning_action',
        context: {},
      },
    };
  }

  log?.emit({ type: 'awaiting_action', power: nextPower, actionKind: 'summoning_action', context: {}, description: `${nextPower}'s turn to summon.` });
  return {
    ...base,
    summoningIndex: next,
    pendingAction: {
      waitingFor: nextPower,
      actionKind: 'summoning_action',
      context: {},
    },
  };
}

// ─── Cost calculations ────────────────────────────────────────────────────────

export function getFollowerCost(
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

export function getCardCost(state: GameState, power: Power, cardId: string, toRegion: RegionId): number {
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
  log: GameLog,
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
          log.emit({ type: 'card_effect', subtype: 'decay', power: p, regionId });
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
        log.emit({ type: 'card_effect', subtype: 'siphon_power', power });
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
      log.emit({ type: 'card_effect', subtype: 'depraved_infiltration', regionId });
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

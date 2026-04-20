import type {
  GameState, Power, RegionId, TokenType,
  SummonFigureAction, PlayCardAction, SummoningPassAction,
  TenzenApprenticeChoiceAction, CardOnPlayChoiceAction,
} from '../types.js';
import { CARD_BY_ID, FOLLOWERS, UPGRADES, UPGRADE_BY_ID } from '../constants.js';
import { GameLog } from '../gameLog.js';
import {
  updatePower, legalPlacementRegions,
  cardSlotsAvailable, isRuined, followersInRegion, isWorldCardActive,
  addTokenToRegion,
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

  // Gormen Plaguefather upgrade: place 2 corruption tokens on summon
  const plaguefatherActive = power === 'gormen' && follower.class === 'incarnation' &&
      s.powers['gormen']!.upgradesInPlay.includes('gormen_plaguefather_up');

  // Reject carry: true if conditions aren't met
  if (action.carry === true) {
    const canCarry = power === 'tenzen' && follower.class === 'cultist' &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
      follower.regionId !== null &&
      s.regions[follower.regionId]!.tokens.includes('chaos_stone');
    if (!canCarry) throw new Error('Cannot carry: no chaos stone in source region or conditions not met');
  }

  // Capture fromRegion before the summon event moves the figure
  const fromRegion = follower.regionId;

  // Apply summon via event
  s = log.apply(s, { type: 'summon_figure', power, followerId, followerClass: follower.class, toRegion, fromRegion, cost });

  // Plaguefather corruption after summon
  if (plaguefatherActive) {
    s = log.apply(s, { type: 'card_effect', subtype: 'plaguefather_corruption', power, regionId: toRegion, tokens: 2 });
  }

  // Tenzen Apprentice upgrade: carry Chaos Stone when moved from board.
  if (power === 'tenzen' && follower.class === 'cultist' &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
      fromRegion !== null) {
    if (s.regions[fromRegion]!.tokens.includes('chaos_stone')) {
      if (action.carry !== undefined) {
        // Carry decision bundled into the summon action
        s = log.apply(s, { type: 'apprentice_choice', followerId, fromRegion, toRegion, carry: action.carry });
        return { state: advanceSummoningTurn(s, power, log), log };
      }

      // Legacy fallback: pause for separate choice action
      s = {
        ...s,
        pendingAction: {
          waitingFor: 'tenzen',
          actionKind: 'tenzen_apprentice_choice',
          context: { followerId, fromRegion, toRegion },
        },
      };
      log.emit({ type: 'awaiting_action', power: 'tenzen', actionKind: 'tenzen_apprentice_choice', context: { followerId, fromRegion, toRegion }, description: `Tenzen apprentice: carry Chaos Stone from ${fromRegion}?` });
      return { state: s, log };
    }
  }

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

  // Free-play humans have a masked hand ('?' entries). They pick any card;
  // the '?' slot is consumed when the play_card event is applied.
  const freePlay = s.companionOptions?.humanPlaysFree && p.playerType === 'human';
  if (!p.hand.includes(cardId) && !(freePlay && p.hand.includes('?'))) {
    throw new Error(`Card ${cardId} not in hand`);
  }
  if (cardSlotsAvailable(s, toRegion) === 0) throw new Error(`No card slots in ${toRegion}`);
  if (s.regions[toRegion]!.chaosCards[slotIndex] !== null) throw new Error(`Slot ${slotIndex} occupied`);
  if (isRuined(s.regions[toRegion]!)) throw new Error(`Cannot play cards to ruined region`);

  const cost = getCardCost(s, power, cardId, toRegion);
  if (p.powerPoints < cost) throw new Error(`Not enough power points`);

  // Apply play_card event (removes from hand, places on board, deducts PP)
  s = log.apply(s, { type: 'play_card', power, cardId, cardName: cardDef.name, toRegion, slotIndex, cost });

  // Apply on_play effects
  s = applyOnPlayEffect(s, cardId, power, toRegion, log);

  // Tenzen Fractals upgrade: summon Fractal for free when playing magic symbol card
  if (power === 'tenzen' && cardDef.hasMagicSymbol &&
      s.powers['tenzen']!.upgradesInPlay.includes('tenzen_fractals_up')) {
    const reserve = s.powers['tenzen']!.followers.find(
      f => f.class === 'warrior' && f.regionId === null
    );
    if (reserve) {
      s = log.apply(s, { type: 'card_effect', subtype: 'fractals_summon', regionId: toRegion, followerName: FOLLOWERS.tenzen.warrior.name.replace(/s$/, ''), followerId: reserve.id });
    }
  }

  // Cards that require a follow-up choice pause summoning turn advancement
  if (needsOnPlayChoice(cardId)) {
    const hasValidTarget = hasOnPlayChoiceTarget(s, cardId, power, toRegion);
    if (hasValidTarget) {
      // If the play-card action bundles the choice (because there was only
      // one legal option), resolve it immediately instead of pausing.
      if (action.onPlayChoice) {
        const result = applyCardOnPlayChoice(s, {
          kind: 'card_on_play_choice',
          power,
          cardId,
          regionId: toRegion,
          choices: action.onPlayChoice,
        });
        log.absorb(result.log);
        return { state: result.state, log };
      }
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
      return followersInRegion(state, regionId).some(f => f.class === 'cultist' || f.class === 'warrior');
    case 'tenzen_the_meddling_of_rats':
      // Per card text: must target an opponent with figures in THIS region.
      return state.activePowers.some(p =>
        p !== power &&
        state.powers[p]!.hand.length > 0 &&
        followersInRegion(state, regionId, p).length > 0,
      );
    case 'tenzen_fate_shield':
      return followersInRegion(state, regionId, power).length > 0;
    case 'lasha_hidden_influence':
      return region.tokens.some(t => t === 'peasant' || t === 'hero' || t === 'noble');
    case 'lasha_narcotic_musk':
      return followersInRegion(state, regionId).some(f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== power);
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
  const log = new GameLog();
  let s = log.apply(state, { type: 'summoning_pass', power });
  return { state: advanceSummoningTurn(s, power, log), log };
}

// ─── Tenzen Apprentices: chaos stone carry choice ────────────────────────────

export function applyTenzenApprenticeChoice(
  state: GameState,
  action: TenzenApprenticeChoiceAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };
  s = log.apply(s, { type: 'apprentice_choice', followerId: action.followerId, fromRegion: action.fromRegion, toRegion: action.toRegion, carry: action.carry });
  return { state: advanceSummoningTurn(s, 'tenzen', log), log };
}

// ─── Turn advancement ─────────────────────────────────────────────────────────

export function advanceSummoningTurn(state: GameState, justActed: Power, log: GameLog): GameState {
  let base = state;
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

  log.emit({ type: 'awaiting_action', power: nextPower, actionKind: 'summoning_action', context: {}, description: `${nextPower}'s turn to summon.` });
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

  // Gormen free Plaguecarrier in empty region (once per figure per round)
  if (power === 'gormen' && cls === 'cultist' &&
      state.powers['gormen']!.upgradesInPlay.includes('gormen_plaguecarriers_up')) {
    const gp = state.powers['gormen']!;
    const hasOtherFigures = gp.followers.some(
      f => f.regionId === toRegion && f.id !== followerId
    );
    const alreadyUsedFree = (gp.freeRedeployIds ?? []).includes(followerId);
    if (!hasOtherFigures && !alreadyUsedFree) cost = 0;
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
          s = log.apply(s, { type: 'card_effect', subtype: 'decay', power: p, regionId });
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
      const stolenFrom: Power[] = [];
      for (const p of s.activePowers) {
        if (p === power) continue;
        if (followersInRegion(s, regionId, p).some(f => f.class === 'cultist')) {
          if (s.powers[p]!.powerPoints > 0) {
            stolenFrom.push(p);
          }
        }
      }
      if (stolenFrom.length > 0) {
        s = log.apply(s, { type: 'card_effect', subtype: 'siphon_power', power, regionId, stolenFrom });
      }
      break;
    }
    case 'lasha_depraved_infiltration': {
      s = log.apply(s, { type: 'card_effect', subtype: 'depraved_infiltration', regionId });
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

// ─── On-play card choices ─────────────────────────────────────────────────────

export function applyCardOnPlayChoice(
  state: GameState,
  action: CardOnPlayChoiceAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };
  const { power, cardId, regionId, choices } = action;

  switch (cardId) {
    // ── Xarm: War March ───────────────────────────────────────────────────────
    // Move up to 2 own figures from any adjacent region into this region
    case 'xarm_call_to_war': {
      const followerIds = (choices['followerIds'] as string[] | undefined) ?? [];
      for (const fId of followerIds.slice(0, 2)) {
        const figure = findFigureAnywhere(s, fId);
        if (!figure || figure.power !== power || (figure.controlledBy && figure.controlledBy !== power)) continue;
        const fromRegion = figure.regionId;
        if (fromRegion === null || fromRegion === regionId) continue;

        s = log.apply(s, { type: 'card_effect', subtype: 'call_to_war', power, followerId: fId, fromRegion, toRegion: regionId });
      }
      break;
    }

    // ── Tenzen: Phase Shift ───────────────────────────────────────────────────
    // Move a Cultist or Warrior in this region to any other region
    case 'tenzen_teleport': {
      const followerId = choices['followerId'] as string;
      const toRegion = choices['toRegion'] as RegionId;
      const carry = choices['carry'] as boolean | undefined;
      const figure = followersInRegion(s, regionId).find(f => f.id === followerId);
      if (figure && (figure.class === 'cultist' || figure.class === 'warrior') && toRegion !== regionId) {
        s = log.apply(s, { type: 'card_effect', subtype: 'teleport', power, followerId, followerClass: figure.class, fromRegion: regionId, toRegion });

        // Tenzen Apprentice upgrade: carry chaos stone when teleporting a cultist
        if (carry !== undefined && figure.power === 'tenzen' && figure.class === 'cultist' &&
            s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
            s.regions[regionId]!.tokens.includes('chaos_stone')) {
          s = log.apply(s, { type: 'apprentice_choice', followerId, fromRegion: regionId, toRegion, carry });
        }
      }
      break;
    }

    // ── Tenzen: Meddling of Rats ───────────────────────────────────────────────
    // Target must immediately discard 2 cards.
    // Per card text: target must have figures in the region where it was played.
    case 'tenzen_the_meddling_of_rats': {
      const targetPower = choices['targetPower'] as Power;
      const targetHasFigures = followersInRegion(s, regionId, targetPower).length > 0;
      if (!targetHasFigures) break; // invalid target — card fizzles
      const targetPs = s.powers[targetPower]!;
      const required = Math.min(2, targetPs.hand.length);
      log.emit({ type: 'card_effect', subtype: 'meddling_of_rats', targetPower });

      // Free-play humans have a masked hand — the physical player picks which
      // cards to discard off-board. Auto-drop the right count of '?' slots.
      const targetFreePlay = !!s.companionOptions?.humanPlaysFree && targetPs.playerType === 'human';

      if (!targetFreePlay && required > 0 && targetPs.hand.length > required) {
        // Target must choose which cards to discard
        s = {
          ...s,
          pendingAction: {
            waitingFor: targetPower,
            actionKind: 'forced_discard',
            context: { count: required, returnTo: power },
          },
        };
        log.emit({ type: 'awaiting_action', power: targetPower, actionKind: 'forced_discard', context: { count: required, returnTo: power }, description: `${targetPower} must discard ${required} card(s).` });
        return { state: s, log };
      } else if (required > 0) {
        // Auto-discard: first N entries from the masked or real hand.
        const toDiscard = targetPs.hand.slice(0, required);
        s = log.apply(s, { type: 'forced_discard', power: targetPower, count: toDiscard.length, cardIds: toDiscard });
      }
      break;
    }

    // ── Tenzen: Fate's Aegis ─────────────────────────────────────────────────
    // Chosen figure cannot be killed in battle this round
    case 'tenzen_fate_shield': {
      const followerId = choices['followerId'] as string;
      const figure = followersInRegion(s, regionId).find(f => f.id === followerId);
      if (figure) {
        s = log.apply(s, { type: 'card_effect', subtype: 'fate_shield', followerId });
      }
      break;
    }

    // ── Lasha: Invisible Hand ─────────────────────────────────────────────────
    // Move a Peasant, Hero, or Noble token from this region to any other region
    case 'lasha_hidden_influence': {
      const token = choices['token'] as TokenType;
      const fromRegion = (choices['fromRegion'] as RegionId | undefined) ?? regionId;
      const toRegion = choices['toRegion'] as RegionId;
      if (['peasant', 'hero', 'noble'].includes(token) && fromRegion !== toRegion) {
        const srcTokens = s.regions[fromRegion]!.tokens;
        if (srcTokens.includes(token)) {
          s = log.apply(s, { type: 'card_effect', subtype: 'hidden_influence', tokenType: token, fromRegion, toRegion });
        }
      }
      break;
    }

    // ── Lasha: Enthrallment ───────────────────────────────────────────────────
    // Choose one enemy Cultist in this region; Lasha controls it
    case 'lasha_narcotic_musk': {
      const followerId = choices['followerId'] as string;
      const figure = followersInRegion(s, regionId).find(f =>
        f.id === followerId && f.class === 'cultist' &&
        (f.controlledBy ?? f.power) !== 'lasha'
      );
      if (figure) {
        s = log.apply(s, { type: 'card_effect', subtype: 'narcotic_musk', power: figure.power as Power, followerId });
      }
      break;
    }
  }

  return { state: advanceSummoningTurn(s, power, log), log };
}

function findFigureAnywhere(state: GameState, followerId: string) {
  for (const power of state.activePowers) {
    const f = state.powers[power]!.followers.find(f => f.id === followerId);
    if (f) return f;
  }
  return null;
}

import type { GameState, Power, RegionId, DialPendingReward } from '../types.js';
import { GameLog } from '../gameLog.js';
import {
  CARD_BY_ID, REGION_ORDER, RUINATION_CARDS, THREAT_DIALS, UPGRADES, WORLD_CARD_BY_ID,
} from '../constants.js';
import {
  updatePower, updateRegion, isWorldCardActive, lowestThreatPower,
  highestThreatPower, isRuined, followersInRegion,
} from '../helpers.js';
import { checkVictory } from '../victory.js';

// ─── Entry point ─────────────────────────────────────────────────────────────

export function resolveEndPhase(
  state: GameState,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s = state;

  // If we're mid-way through draining dial reward choices, continue from here.
  if (s.pendingDialRewards !== null) {
    return drainDialRewards(s, log);
  }

  // Step 1: Remove Chaos cards from board (persistent cards handled below)
  ({ state: s } = removeChaosCards(s, log));

  // Step 2: Resolve Hero tokens (End Phase)
  ({ state: s } = resolveHeroTokens(s, log));

  // Step 3: Resolve World Cards persistent effects
  ({ state: s } = resolveWorldCardEffects(s, log));

  // Step 4: Score ruined regions (for cards placed this round = still faceup ruination cards)
  ({ state: s } = scoreRuinedRegions(s, log));

  // Step 5: Advance threat dials (interactive rewards queued in pendingDialRewards)
  ({ state: s } = advanceThreatDials(s, log));

  // Check for victory immediately — dial may have scored VP or triggered a win condition
  // before any interactive rewards are processed.
  {
    const victory = checkVictory(s);
    if (victory) {
      s = { ...s, phase: 'completed', winners: victory.winners, winCondition: victory.condition };
      log.emit({ type: 'game_over', winners: victory.winners, condition: victory.condition });
      return { state: s, log };
    }
  }

  // If dial advancement produced rewards requiring choices, pause here.
  if (s.pendingDialRewards && s.pendingDialRewards.length > 0) {
    return drainDialRewards(s, log);
  }

  return finalizeEndPhase(s, log);
}

/**
 * Set pendingAction for the next queued dial reward, or finalize the round.
 *
 * Multi-pick reward contexts carry both `count` (total picks the reward
 * grants) and `remaining` (picks still required). Each pick decrements
 * `remaining`, and the next drain re-emits awaiting_action so clients always
 * see the current reduced state — this makes partial batches durable: if a
 * client only submits some of the picks, the next awaiting_action tells them
 * how many are still owed.
 */
function drainDialRewards(
  state: GameState,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const queue = s.pendingDialRewards ?? [];

  if (queue.length === 0) {
    s = { ...s, pendingDialRewards: null };
    return finalizeEndPhase(s, log);
  }

  const next = queue[0]!;
  switch (next.kind) {
    case 'upgrade_choice':
      s = {
        ...s,
        pendingAction: { waitingFor: next.power, actionKind: 'upgrade_choice', context: {} },
      };
      log.emit({ type: 'awaiting_action', power: next.power, actionKind: 'upgrade_choice', context: {}, description: `${next.power} chooses an upgrade.` });
      break;
    case 'place_token': {
      const context = { tokenType: next.tokenType, remaining: next.remaining, count: next.count };
      s = {
        ...s,
        pendingAction: { waitingFor: next.power, actionKind: 'dial_place_token', context },
      };
      log.emit({ type: 'awaiting_action', power: next.power, actionKind: 'dial_place_token', context, description: `${next.power} places ${next.tokenType} token(s) (${next.remaining}/${next.count}).` });
      break;
    }
    case 'remove_corruption': {
      // Skip if there's no corruption anywhere to remove
      const hasAnyCorruption = REGION_ORDER.some(r =>
        Object.values(s.regions[r]!.corruptionTokens).some(v => v > 0)
      );
      if (!hasAnyCorruption) {
        s = { ...s, pendingDialRewards: queue.slice(1) };
        return drainDialRewards(s, log);
      }
      const context = { remaining: next.remaining, count: next.count };
      s = {
        ...s,
        pendingAction: { waitingFor: next.power, actionKind: 'dial_remove_corruption', context },
      };
      log.emit({ type: 'awaiting_action', power: next.power, actionKind: 'dial_remove_corruption', context, description: `${next.power} removes corruption (${next.remaining}/${next.count}).` });
      break;
    }
    case 'remove_world_tokens': {
      const context = { remaining: next.remaining, count: next.count };
      s = {
        ...s,
        pendingAction: { waitingFor: next.power, actionKind: 'dial_remove_world_token', context },
      };
      log.emit({ type: 'awaiting_action', power: next.power, actionKind: 'dial_remove_world_token', context, description: `${next.power} removes world token (${next.remaining}/${next.count}).` });
      break;
    }
  }

  return { state: s, log };
}

function finalizeEndPhase(
  state: GameState,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;

  // Check for victory
  const victory = checkVictory(s);
  if (victory) {
    s = {
      ...s,
      phase: 'completed',
      winners: victory.winners,
      winCondition: victory.condition,
    };
    log.emit({ type: 'game_over', winners: victory.winners, condition: victory.condition });
    return { state: s, log };
  }

  // Advance to next round
  s = {
    ...s,
    round: s.round + 1,
    phase: 'world',
    pendingAction: null,
  };
  log.emit({ type: 'round_start', round: s.round });
  return { state: s, log };
}

// ─── Step 1: Remove Chaos cards ───────────────────────────────────────────────

function removeChaosCards(
  state: GameState,
  log: GameLog,
): { state: GameState } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;
    const newSlots: [typeof region.chaosCards[0], typeof region.chaosCards[0]] = [null, null];

    for (const [i, slot] of region.chaosCards.entries()) {
      if (slot === null || slot === undefined) continue;

      // Recursive Pattern: if Tenzen killed in this region, keep it
      if (slot.cardId === 'tenzen_persistence_matrix' && slot.persistNextRound) {
        newSlots[i as 0 | 1] = { ...slot, persistNextRound: false };
        continue;
      }

      // Enthrallment: when discarded, release the controlled cultist
      if (slot.cardId === 'lasha_narcotic_musk') {
        // Find a lasha-controlled enemy cultist in this region and release it
        const controlled = followersInRegion(s, regionId).find(
          f => f.controlledBy === 'lasha' && f.power !== 'lasha' && f.class === 'cultist'
        );
        if (controlled) {
          s = log.apply(s, { type: 'narcotic_release', power: controlled.power as Power, followerId: controlled.id });
        }
      }

      s = log.apply(s, { type: 'chaos_card_discarded', regionId, slotIndex: i, cardId: slot.cardId, playedBy: slot.playedBy });
    }

    // Update the slots to keep only persistent cards (Recursive Pattern)
    s = updateRegion(s, regionId, { chaosCards: newSlots });
  }

  return { state: s };
}

// ─── Step 2: Resolve Hero tokens ─────────────────────────────────────────────

function resolveHeroTokens(
  state: GameState,
  log: GameLog,
): { state: GameState } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;
    const heroCount = region.tokens.filter(t => t === 'hero').length;
    if (heroCount === 0) continue;

    // One removal per hero token
    for (let h = 0; h < heroCount; h++) {
      // Power with greatest Threat who has figures in this region
      const candidates = s.activePowers.filter(p =>
        followersInRegion(s, regionId, p).length > 0
      );
      if (candidates.length === 0) break;

      const target = candidates.reduce((maxP, p) =>
        s.powers[p]!.threatValue > s.powers[maxP]!.threatValue ? p : maxP
      );

      const figures = followersInRegion(s, regionId, target);
      if (figures.length === 0) break;

      // Remove weakest figure (lowest defense)
      const toRemove = figures.sort((a, b) => classRank(a.class) - classRank(b.class))[0]!;
      s = log.apply(s, { type: 'hero_removal', regionId, power: target, followerClass: toRemove.class, followerId: toRemove.id });
    }
  }

  return { state: s };
}

// ─── Step 3: Resolve World Card persistent effects ────────────────────────────

function resolveWorldCardEffects(
  state: GameState,
  log: GameLog,
): { state: GameState } {
  let s = state;

  // Process slot1 first, then slot2
  for (const slotCard of [s.worldTrack.slot1, s.worldTrack.slot2]) {
    if (!slotCard) continue;
    ({ state: s } = applyWorldCardPersistentEffect(s, slotCard, log));
  }

  return { state: s };
}

function applyWorldCardPersistentEffect(
  state: GameState,
  cardId: string,
  log: GameLog,
): { state: GameState } {
  let s = state;
  const lowest = lowestThreatPower(s);
  const highest = highestThreatPower(s);

  switch (cardId) {
    case 'normagne_heir': {
      // Each player with 1+ figures on Normagne discards a chaos card
      for (const power of s.activePowers) {
        const hasFigures = followersInRegion(s, 'normagne', power).length > 0;
        if (hasFigures && s.powers[power]!.hand.length > 0) {
          // Auto-discard: discard last card in hand (TODO: interactive)
          const card = s.powers[power]!.hand[s.powers[power]!.hand.length - 1]!;
          s = log.apply(s, { type: 'world_card_effect', subtype: 'normagne_heir_discard', power, cardId: card });
        }
      }
      break;
    }

    case 'northern_heir': {
      // Lowest threat player places a Noble on a region already containing a Noble
      const nobleRegions = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('noble')
      );
      if (nobleRegions.length > 0) {
        const target = nobleRegions[0]!;
        s = log.apply(s, { type: 'world_card_effect', subtype: 'northern_heir', power: lowest, regionId: target });
      }
      break;
    }

    case 'diplomatic_envoy': {
      // Lowest threat removes 1 Noble token
      const nobleRegions = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('noble')
      );
      if (nobleRegions.length > 0) {
        const target = nobleRegions[0]!;
        s = log.apply(s, { type: 'world_card_effect', subtype: 'diplomatic_envoy', power: lowest, regionId: target });
      }
      break;
    }

    case 'chaos_countermeasures': {
      // Lowest threat places a Hero on any region with 1+ Chaos Stone
      const eligible = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('chaos_stone')
      );
      if (eligible.length > 0) {
        const target = eligible[0]!;
        s = log.apply(s, { type: 'world_card_effect', subtype: 'chaos_countermeasures', power: lowest, regionId: target });
      }
      break;
    }

    case 'great_exorcism': {
      // Remove all figures from regions with Event tokens;
      // then move all Event tokens to region with most corruption
      const eventRegions = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('event')
      );
      for (const regionId of eventRegions) {
        const figures = followersInRegion(s, regionId);
        if (figures.length > 0) {
          s = log.apply(s, { type: 'world_card_effect', subtype: 'great_exorcism_figures', regionId });
        }
      }

      // Move all event tokens to region with most corruption
      const mostCorrupt = REGION_ORDER.reduce((best, r) => {
        const c = Object.values(s.regions[r]!.corruptionTokens).reduce((a, b) => a + b, 0);
        const bc = Object.values(s.regions[best]!.corruptionTokens).reduce((a, b) => a + b, 0);
        return c > bc ? r : best;
      });

      const totalEvents = eventRegions.reduce(
        (sum, r) => sum + s.regions[r]!.tokens.filter(t => t === 'event').length, 0
      );

      for (const regionId of eventRegions) {
        const count = s.regions[regionId]!.tokens.filter(t => t === 'event').length;
        for (let i = 0; i < count; i++) {
          s = log.apply(s, { type: 'token_removed', regionId, tokenType: 'event' });
        }
      }
      if (totalEvents > 0) {
        for (let i = 0; i < totalEvents; i++) {
          s = log.apply(s, { type: 'token_placed', regionId: mostCorrupt, tokenType: 'event' });
        }
        log.emit({ type: 'world_card_effect', subtype: 'great_exorcism_events', regionId: mostCorrupt, eventsMoved: totalEvents });
      }
      break;
    }

    case 'central_overpopulation': {
      // Remove 1 Peasant from each region with an Event token
      for (const regionId of REGION_ORDER) {
        const region = s.regions[regionId]!;
        if (!region.tokens.includes('event') || !region.tokens.includes('peasant')) continue;
        s = log.apply(s, { type: 'token_removed', regionId, tokenType: 'peasant' });
        log.emit({ type: 'world_card_effect', subtype: 'central_overpopulation', regionId });
      }
      break;
    }

    case 'cleansing_wave': {
      // Remove all corruption tokens from each region with an Event token
      for (const regionId of REGION_ORDER) {
        if (!s.regions[regionId]!.tokens.includes('event')) continue;
        s = log.apply(s, { type: 'world_card_effect', subtype: 'cleansing_wave', regionId });
      }
      break;
    }

    case 'noble_scrutiny': {
      // In each region with a Noble token, player with most VP removes 1 of their corruption tokens
      for (const regionId of REGION_ORDER) {
        if (!s.regions[regionId]!.tokens.includes('noble')) continue;
        const withTokens = s.activePowers
          .filter(p => s.regions[regionId]!.corruptionTokens[p] > 0)
          .sort((a, b) => s.powers[b]!.victoryPoints - s.powers[a]!.victoryPoints);
        if (withTokens.length === 0) continue;
        const richest = withTokens[0]!;
        s = log.apply(s, { type: 'world_card_effect', subtype: 'noble_scrutiny', power: richest, regionId });
      }
      break;
    }

    case 'the_exchange': {
      // Each player with 1+ figure on a region with Chaos Stone draws 1 card
      for (const power of s.activePowers) {
        const hasChaosStoneRegion = REGION_ORDER.some(r =>
          s.regions[r]!.tokens.includes('chaos_stone') &&
          followersInRegion(s, r, power).length > 0
        );
        if (hasChaosStoneRegion) {
          s = drawOneCard(s, power, log, 'The Exchange');
        }
      }
      break;
    }

    default:
      // Other persistent cards have no "resolve world cards" effect
      break;
  }

  return { state: s };
}

// ─── Step 4: Score ruined regions ────────────────────────────────────────────

function scoreRuinedRegions(
  state: GameState,
  log: GameLog,
): { state: GameState } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;
    if (region.ruinationCardIndex === null) continue;

    // Only score faceup cards (index tracked, assume all placed this round are scoreable)
    // The game tracks ruinationCardIndex; we score the corresponding card's end-phase values
    const card = RUINATION_CARDS[region.ruinationCardIndex - 1];
    if (!card) continue;

    const regionVP = card.endPhaseVP[regionId];
    if (!regionVP) continue;

    // Sort powers by corruption tokens descending
    const tokens = s.regions[regionId]!.corruptionTokens;
    const sorted = s.activePowers
      .filter(p => tokens[p] > 0)
      .sort((a, b) => tokens[b] - tokens[a]);

    if (sorted.length === 0) continue;

    const maxTokens = tokens[sorted[0]!]!;
    const firstPlayers = sorted.filter(p => tokens[p] === maxTokens);

    if (firstPlayers.length >= 2) {
      // Tie for first: split (first + second) / count, round down
      const secondVP = sorted.length > firstPlayers.length ? regionVP.second : 0;
      const shared = Math.floor((regionVP.first + secondVP) / firstPlayers.length);
      s = log.apply(s, { type: 'ruination_scoring', regionId, cardIndex: region.ruinationCardIndex!, first: firstPlayers, firstVP: shared, second: [], secondVP: 0 });
    } else {
      let secondPlayers: Power[] = [];
      let secondShared = 0;
      if (sorted.length >= 2) {
        const secondTokens = tokens[sorted[1]!]!;
        secondPlayers = sorted.slice(1).filter(p => tokens[p] === secondTokens);
        secondShared = Math.floor(regionVP.second / secondPlayers.length);
      }
      s = log.apply(s, { type: 'ruination_scoring', regionId, cardIndex: region.ruinationCardIndex!, first: firstPlayers, firstVP: regionVP.first, second: secondPlayers, secondVP: secondShared });
    }
  }

  return { state: s };
}

// ─── Step 5: Advance threat dials ────────────────────────────────────────────

function advanceThreatDials(
  state: GameState,
  log: GameLog,
): { state: GameState } {
  let s = state;
  const queuedRewards: DialPendingReward[] = [];

  // Powers with 1+ counters advance once
  const counters = s.activePowers.map(p => ({
    power: p,
    count: s.powers[p]!.dialCounters,
  }));

  const powersWithCounters = counters.filter(c => c.count > 0).map(c => c.power);
  const maxCount = Math.max(0, ...counters.map(c => c.count));
  const mostCounters = counters.filter(c => c.count === maxCount && c.count > 0);

  for (const power of powersWithCounters) {
    const result = advanceDial(s, power, log);
    s = result.state;
    queuedRewards.push(...result.rewards);
  }

  // Additional advance for most-counter holder (if unique)
  if (mostCounters.length === 1) {
    const result = advanceDial(s, mostCounters[0]!.power, log);
    s = result.state;
    queuedRewards.push(...result.rewards);
  }

  // Reset all counters
  s = log.apply(s, { type: 'battle_cleanup', clearedWarFrenzyHits: [], resetDialCounters: true });

  if (queuedRewards.length > 0) {
    s = { ...s, pendingDialRewards: queuedRewards };
  }

  return { state: s };
}

function advanceDial(
  state: GameState,
  power: Power,
  log: GameLog,
): { state: GameState; rewards: DialPendingReward[] } {
  let s = state;
  const rewards: DialPendingReward[] = [];
  const p = s.powers[power]!;
  const dial = THREAT_DIALS[power]!;
  const nextPos = p.dialPosition + 1;

  if (nextPos >= dial.length) return { state: s, rewards };

  const entry = dial[nextPos]!;
  const newThreat = entry.threat === 'victory' ? p.threatValue : entry.threat;

  s = log.apply(s, { type: 'dial_advance', power, position: nextPos, threat: entry.threat });

  // Apply dial instruction — automatic rewards run now; interactive ones get queued.
  switch (entry.instruction.type) {
    case 'score_vp':
      s = log.apply(s, { type: 'dial_vp', power, vp: entry.instruction.amount });
      break;

    case 'upgrade_card': {
      const available = s.powers[power]!.availableUpgradeIds;
      if (available.length > 0) {
        rewards.push({ kind: 'upgrade_choice', power });
      }
      break;
    }

    case 'draw_chaos_cards':
      for (let i = 0; i < entry.instruction.amount; i++) {
        s = drawOneCard(s, power, log, 'dial');
      }
      break;

    case 'place_nobles':
      rewards.push({ kind: 'place_token', power, tokenType: 'noble', remaining: entry.instruction.amount, count: entry.instruction.amount });
      break;

    case 'place_chaos_stone':
      rewards.push({ kind: 'place_token', power, tokenType: 'chaos_stone', remaining: entry.instruction.amount, count: entry.instruction.amount });
      break;

    case 'remove_corruption': {
      // Only queue if there's any corruption anywhere — the dial reward can
      // remove any power's corruption, not just the rewarded power's own.
      const anyCorruption = REGION_ORDER.some(r => {
        const tokens = s.regions[r]!.corruptionTokens;
        return Object.values(tokens).some(v => v > 0);
      });
      if (anyCorruption) {
        rewards.push({ kind: 'remove_corruption', power, remaining: entry.instruction.amount, count: entry.instruction.amount });
      }
      break;
    }

    case 'remove_world_tokens': {
      const hasTokens = REGION_ORDER.some(r =>
        s.regions[r]!.tokens.some(t => t !== 'chaos_stone'),
      );
      if (hasTokens) {
        rewards.push({ kind: 'remove_world_tokens', power, remaining: entry.instruction.amount, count: entry.instruction.amount });
      }
      break;
    }

    case 'victory':
      s = log.apply(s, { type: 'dial_victory', power });
      break;

    case 'start':
      break;
  }

  return { state: s, rewards };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function drawOneCard(
  state: GameState,
  power: Power,
  log: GameLog,
  source: string,
): GameState {
  const p = state.powers[power]!;
  let { deckIds, discardIds } = p;

  if (deckIds.length === 0 && discardIds.length === 0) return state;

  if (deckIds.length === 0) {
    // Simple reshuffle (no RNG in end phase — use fixed seed offset)
    deckIds = [...discardIds].reverse();
    discardIds = [];
    // Update state with reshuffled deck before drawing
    state = updatePower(state, power, { deckIds, discardIds });
  }

  const drawn = deckIds[0]!;
  return log.apply(state, { type: 'card_drawn', power, cardId: drawn, source });
}

function classRank(cls: 'cultist' | 'warrior' | 'incarnation'): number {
  return cls === 'cultist' ? 0 : cls === 'warrior' ? 1 : 2;
}

import type { GameState, Power, RegionId, DialPendingReward } from '../types.js';
import {
  REGION_ORDER, RUINATION_CARDS, THREAT_DIALS, UPGRADES,
} from '../constants.js';
import {
  updatePower, updateRegion, scoreVP, isWorldCardActive, lowestThreatPower,
  highestThreatPower, isRuined,
} from '../helpers.js';
import { checkVictory } from '../victory.js';

// ─── Entry point ─────────────────────────────────────────────────────────────

export function resolveEndPhase(
  state: GameState,
): { state: GameState; log: string[] } {
  const log: string[] = [];
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
      log.push(`Game over! Winners: ${victory.winners.join(', ')} (${victory.condition}).`);
      return { state: s, log };
    }
  }

  // If dial advancement produced rewards requiring choices, pause here.
  if (s.pendingDialRewards && s.pendingDialRewards.length > 0) {
    return drainDialRewards(s, log);
  }

  return finalizeEndPhase(s, log);
}

/** Set pendingAction for the next queued dial reward, or finalize the round. */
function drainDialRewards(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
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
      break;
    case 'place_token':
      s = {
        ...s,
        pendingAction: {
          waitingFor: next.power,
          actionKind: 'dial_place_token',
          context: { tokenType: next.tokenType, remaining: next.remaining },
        },
      };
      break;
    case 'remove_corruption':
      s = {
        ...s,
        pendingAction: {
          waitingFor: next.power,
          actionKind: 'dial_remove_corruption',
          context: { remaining: next.remaining },
        },
      };
      break;
    case 'remove_world_tokens':
      s = {
        ...s,
        pendingAction: {
          waitingFor: next.power,
          actionKind: 'dial_remove_world_token',
          context: { remaining: next.remaining },
        },
      };
      break;
  }

  return { state: s, log };
}

function finalizeEndPhase(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
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
    log.push(`Game over! Winners: ${victory.winners.join(', ')} (${victory.condition}).`);
    return { state: s, log };
  }

  // Advance to next round
  s = {
    ...s,
    round: s.round + 1,
    phase: 'world',
    pendingAction: null,
  };
  log.push(`Round ${s.round} begins.`);
  return { state: s, log };
}

// ─── Step 1: Remove Chaos cards ───────────────────────────────────────────────

function removeChaosCards(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;
    const newSlots: [typeof region.chaosCards[0], typeof region.chaosCards[0]] = [null, null];
    const discarded: Record<Power, string[]> = { xarm: [], gormen: [], tenzen: [], lasha: [] };

    for (const [i, slot] of region.chaosCards.entries()) {
      if (slot === null || slot === undefined) continue;

      // Recursive Pattern: if Tenzen killed in this region, keep it
      if (slot.cardId === 'tenzen_recursive_pattern' && slot.persistNextRound) {
        newSlots[i as 0 | 1] = { ...slot, persistNextRound: false };
        continue;
      }

      // Enthrallment: when discarded, release the controlled cultist
      if (slot.cardId === 'lasha_enthrallment') {
        // Find a lasha-controlled enemy cultist in this region and release it
        const controlled = s.regions[regionId]!.placements.find(
          f => f.controlledBy === 'lasha' && f.power !== 'lasha' && f.class === 'cultist'
        );
        if (controlled) {
          s = updateRegion(s, regionId, {
            placements: s.regions[regionId]!.placements.map(f =>
              f.id === controlled.id ? { ...f, controlledBy: null } : f
            ),
          });
          s = updatePower(s, controlled.power as Power, {
            followers: s.powers[controlled.power as Power]!.followers.map(f =>
              f.id === controlled.id ? { ...f, controlledBy: null } : f
            ),
          });
          log.push(`Enthrallment discarded: ${controlled.power} ${controlled.id} released.`);
        }
      }

      discarded[slot.playedBy]!.push(slot.cardId);
    }

    s = updateRegion(s, regionId, { chaosCards: newSlots });

    // Move discarded cards to each power's discard pile
    for (const power of s.activePowers) {
      const cards = discarded[power] ?? [];
      if (cards.length === 0) continue;
      s = updatePower(s, power, {
        discardIds: [...s.powers[power]!.discardIds, ...cards],
      });
    }
  }

  return { state: s, log };
}

// ─── Step 2: Resolve Hero tokens ─────────────────────────────────────────────

function resolveHeroTokens(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;
    const heroCount = region.tokens.filter(t => t === 'hero').length;
    if (heroCount === 0) continue;

    // One removal per hero token
    for (let h = 0; h < heroCount; h++) {
      // Power with greatest Threat who has figures in this region
      const candidates = s.activePowers.filter(p =>
        s.regions[regionId]!.placements.some(f => (f.controlledBy ?? f.power) === p)
      );
      if (candidates.length === 0) break;

      const target = candidates.reduce((maxP, p) =>
        s.powers[p]!.threatValue > s.powers[maxP]!.threatValue ? p : maxP
      );

      const figures = s.regions[regionId]!.placements.filter(
        f => (f.controlledBy ?? f.power) === target
      );
      if (figures.length === 0) break;

      // Remove weakest figure (lowest defense)
      const toRemove = figures.sort((a, b) => classRank(a.class) - classRank(b.class))[0]!;
      s = updateRegion(s, regionId, {
        placements: s.regions[regionId]!.placements.filter(f => f.id !== toRemove.id),
      });
      s = updatePower(s, toRemove.power, {
        followers: s.powers[toRemove.power]!.followers.map(f =>
          f.id === toRemove.id ? { ...f, regionId: null, controlledBy: null } : f
        ),
      });
      log.push(`${regionId}: Hero token — ${target} removes ${toRemove.class} (${toRemove.id}).`);
    }
  }

  return { state: s, log };
}

// ─── Step 3: Resolve World Card persistent effects ────────────────────────────

function resolveWorldCardEffects(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;

  // Process slot1 first, then slot2
  for (const slotCard of [s.worldTrack.slot1, s.worldTrack.slot2]) {
    if (!slotCard) continue;
    ({ state: s } = applyWorldCardPersistentEffect(s, slotCard, log));
  }

  return { state: s, log };
}

function applyWorldCardPersistentEffect(
  state: GameState,
  cardId: string,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const lowest = lowestThreatPower(s);
  const highest = highestThreatPower(s);

  switch (cardId) {
    case 'strategic_vanguard': {
      // Each player with 1+ figures on Normagne discards a chaos card
      for (const power of s.activePowers) {
        const hasFigures = s.regions['normagne']!.placements.some(
          f => (f.controlledBy ?? f.power) === power
        );
        if (hasFigures && s.powers[power]!.hand.length > 0) {
          // Auto-discard: discard last card in hand (TODO: interactive)
          const card = s.powers[power]!.hand[s.powers[power]!.hand.length - 1]!;
          s = updatePower(s, power, {
            hand: s.powers[power]!.hand.slice(0, -1),
            discardIds: [...s.powers[power]!.discardIds, card],
          });
          log.push(`Strategic Vanguard: ${power} discards ${card}.`);
        }
      }
      break;
    }

    case 'the_gambit': {
      // Lowest threat player places a Noble on a region already containing a Noble
      const nobleRegions = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('noble')
      );
      if (nobleRegions.length > 0) {
        // Auto-place on first noble region (TODO: interactive choice for lowest threat)
        const target = nobleRegions[0]!;
        s = updateRegion(s, target, {
          tokens: [...s.regions[target]!.tokens, 'noble'],
        });
        log.push(`The Gambit: ${lowest} places a Noble on ${target}.`);
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
        const tokens = [...s.regions[target]!.tokens];
        tokens.splice(tokens.indexOf('noble'), 1);
        s = updateRegion(s, target, { tokens });
        log.push(`Diplomatic Envoy: ${lowest} removes a Noble from ${target}.`);
      }
      break;
    }

    case 'the_hunt': {
      // Lowest threat places a Hero on any region with 1+ Chaos Stone
      const eligible = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('chaos_stone')
      );
      if (eligible.length > 0) {
        const target = eligible[0]!;
        s = updateRegion(s, target, {
          tokens: [...s.regions[target]!.tokens, 'hero'],
        });
        log.push(`The Hunt: ${lowest} places a Hero on ${target}.`);
      }
      break;
    }

    case 'the_exodus': {
      // Remove all figures from regions with Event tokens;
      // then move all Event tokens to region with most corruption
      const eventRegions = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('event')
      );
      for (const regionId of eventRegions) {
        const figures = [...s.regions[regionId]!.placements];
        for (const f of figures) {
          s = updateRegion(s, regionId, {
            placements: s.regions[regionId]!.placements.filter(x => x.id !== f.id),
          });
          s = updatePower(s, f.power, {
            followers: s.powers[f.power]!.followers.map(x =>
              x.id === f.id ? { ...x, regionId: null, controlledBy: null } : x
            ),
          });
        }
        if (figures.length > 0) {
          log.push(`The Exodus: removed all figures from ${regionId}.`);
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
        const tokens = s.regions[regionId]!.tokens.filter(t => t !== 'event');
        s = updateRegion(s, regionId, { tokens });
      }
      if (totalEvents > 0) {
        const existing = s.regions[mostCorrupt]!.tokens;
        s = updateRegion(s, mostCorrupt, {
          tokens: [...existing, ...Array(totalEvents).fill('event')],
        });
        log.push(`The Exodus: moved ${totalEvents} Event token(s) to ${mostCorrupt}.`);
      }
      break;
    }

    case 'misdirection': {
      // Remove 1 Peasant from each region with an Event token
      for (const regionId of REGION_ORDER) {
        const region = s.regions[regionId]!;
        if (!region.tokens.includes('event') || !region.tokens.includes('peasant')) continue;
        const tokens = [...region.tokens];
        tokens.splice(tokens.indexOf('peasant'), 1);
        s = updateRegion(s, regionId, { tokens });
        log.push(`Misdirection: Peasant removed from ${regionId}.`);
      }
      break;
    }

    case 'cleansing_wave': {
      // Remove all corruption tokens from each region with an Event token
      for (const regionId of REGION_ORDER) {
        if (!s.regions[regionId]!.tokens.includes('event')) continue;
        s = updateRegion(s, regionId, {
          corruptionTokens: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
        });
        log.push(`Cleansing Wave: all corruption tokens removed from ${regionId}.`);
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
        s = updateRegion(s, regionId, {
          corruptionTokens: {
            ...s.regions[regionId]!.corruptionTokens,
            [richest]: s.regions[regionId]!.corruptionTokens[richest] - 1,
          },
        });
        log.push(`Noble Scrutiny: ${richest} removes 1 corruption token from ${regionId}.`);
      }
      break;
    }

    case 'the_exchange': {
      // Each player with 1+ figure on a region with Chaos Stone draws 1 card
      for (const power of s.activePowers) {
        const hasChaosStoneRegion = REGION_ORDER.some(r =>
          s.regions[r]!.tokens.includes('chaos_stone') &&
          s.regions[r]!.placements.some(f => (f.controlledBy ?? f.power) === power)
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

  return { state: s, log };
}

// ─── Step 4: Score ruined regions ────────────────────────────────────────────

function scoreRuinedRegions(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
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
      for (const p of firstPlayers) {
        s = scoreVP(s, p, shared);
      }
      log.push(`${regionId}: Ruination scoring — ${firstPlayers.join('/')} each score ${shared} VP (tied first).`);
    } else {
      s = scoreVP(s, firstPlayers[0]!, regionVP.first);
      log.push(`${regionId}: Ruination scoring — ${firstPlayers[0]} scores ${regionVP.first} VP (first).`);

      if (sorted.length >= 2) {
        const secondTokens = tokens[sorted[1]!]!;
        const secondPlayers = sorted.slice(1).filter(p => tokens[p] === secondTokens);
        const shared = Math.floor(regionVP.second / secondPlayers.length);
        for (const p of secondPlayers) {
          s = scoreVP(s, p, shared);
        }
        log.push(`${regionId}: Ruination scoring — ${secondPlayers.join('/')} each score ${shared} VP (second).`);
      }
    }
  }

  return { state: s, log };
}

// ─── Step 5: Advance threat dials ────────────────────────────────────────────

function advanceThreatDials(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
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
  for (const power of s.activePowers) {
    s = updatePower(s, power, { dialCounters: 0 });
  }

  if (queuedRewards.length > 0) {
    s = { ...s, pendingDialRewards: queuedRewards };
  }

  return { state: s, log };
}

function advanceDial(
  state: GameState,
  power: Power,
  log: string[],
): { state: GameState; log: string[]; rewards: DialPendingReward[] } {
  let s = state;
  const rewards: DialPendingReward[] = [];
  const p = s.powers[power]!;
  const dial = THREAT_DIALS[power]!;
  const nextPos = p.dialPosition + 1;

  if (nextPos >= dial.length) return { state: s, log, rewards };

  const entry = dial[nextPos]!;
  const newThreat = entry.threat === 'victory' ? p.threatValue : entry.threat;

  s = updatePower(s, power, {
    dialPosition: nextPos,
    threatValue: typeof newThreat === 'number' ? newThreat : p.threatValue,
  });

  log.push(`${power} advances threat dial to position ${nextPos} (threat: ${entry.threat}).`);

  // Apply dial instruction — automatic rewards run now; interactive ones get queued.
  switch (entry.instruction.type) {
    case 'score_vp':
      s = scoreVP(s, power, entry.instruction.amount);
      log.push(`${power} scores ${entry.instruction.amount} VP from dial.`);
      break;

    case 'upgrade_card': {
      const available = s.powers[power]!.availableUpgradeIds;
      if (available.length > 0) {
        if (available.length === 1) {
          // Only one option — apply automatically.
          const upgradeId = available[0]!;
          s = updatePower(s, power, {
            upgradesInPlay: [...s.powers[power]!.upgradesInPlay, upgradeId],
            availableUpgradeIds: [],
          });
          log.push(`${power} gains upgrade: ${upgradeId}.`);
        } else {
          rewards.push({ kind: 'upgrade_choice', power });
        }
      }
      break;
    }

    case 'draw_chaos_cards':
      for (let i = 0; i < entry.instruction.amount; i++) {
        s = drawOneCard(s, power, log, 'dial');
      }
      break;

    case 'place_nobles':
      rewards.push({ kind: 'place_token', power, tokenType: 'noble', remaining: entry.instruction.amount });
      break;

    case 'place_chaos_stone':
      rewards.push({ kind: 'place_token', power, tokenType: 'chaos_stone', remaining: entry.instruction.amount });
      break;

    case 'remove_corruption': {
      // Only queue if there's actually something to remove.
      const hasOwn = REGION_ORDER.some(r => s.regions[r]!.corruptionTokens[power] > 0);
      if (hasOwn) {
        rewards.push({ kind: 'remove_corruption', power, remaining: entry.instruction.amount });
      }
      break;
    }

    case 'remove_world_tokens': {
      const hasTokens = REGION_ORDER.some(r =>
        s.regions[r]!.tokens.some(t => t !== 'chaos_stone'),
      );
      if (hasTokens) {
        rewards.push({ kind: 'remove_world_tokens', power, remaining: entry.instruction.amount });
      }
      break;
    }

    case 'victory':
      s = {
        ...s,
        winners: [power],
        winCondition: 'threat_dial',
      };
      log.push(`${power} reaches the victory position on their threat dial!`);
      break;

    case 'start':
      break;
  }

  return { state: s, log, rewards };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function drawOneCard(
  state: GameState,
  power: Power,
  log: string[],
  source: string,
): GameState {
  const p = state.powers[power]!;
  let { deckIds, discardIds, hand } = p;

  if (deckIds.length === 0 && discardIds.length === 0) return state;

  if (deckIds.length === 0) {
    // Simple reshuffle (no RNG in end phase — use fixed seed offset)
    deckIds = [...discardIds].reverse();
    discardIds = [];
  }

  const drawn = deckIds[0]!;
  log.push(`${power} draws ${drawn} (${source}).`);
  return updatePower(state, power, {
    hand: [...hand, drawn],
    deckIds: deckIds.slice(1),
    discardIds,
  });
}

function classRank(cls: 'cultist' | 'warrior' | 'incarnation'): number {
  return cls === 'cultist' ? 0 : cls === 'warrior' ? 1 : 2;
}

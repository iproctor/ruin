/**
 * Pure state reducer: apply a single GameEvent to produce a new GameState.
 *
 * Shared by server (after decide) and client (after receiving broadcast).
 * Every state-mutating event type has a handler; informational events
 * (battle_roll, battle_hit_wait, phase_start banners, etc.) return state unchanged.
 *
 * This is the "single source of truth" for what each event does to state.
 */

import type { GameState, GameEvent, Power, RegionId } from './types.js';

export function applyEvent(state: GameState, event: GameEvent): GameState {
  const next = applyEventInner(state, event);
  // Invariant: `pendingAction` only persists between `awaiting_action` events.
  // Any other event means the engine is mid-resolution (autonomous phases,
  // events flowing from a resolver that has already cleared pendingAction
  // server-side) — reflect that on the client by clearing it. Without this
  // the UI thinks the prior pauser is still acting through the whole batch
  // until the final awaiting_action lands.
  if (event.type === 'awaiting_action') return next;
  return next.pendingAction !== null ? { ...next, pendingAction: null } : next;
}

function applyEventInner(state: GameState, event: GameEvent): GameState {
  switch (event.type) {
    // ── Lifecycle ─────────────────────────────────────────────────────────
    case 'phase_start':
      return { ...state, phase: event.phase };
    case 'round_start':
      return { ...state, round: event.round };
    case 'game_over':
      return { ...state, winners: event.winners, winCondition: event.condition, phase: 'completed' };
    case 'awaiting_action':
      return {
        ...state,
        pendingAction: {
          waitingFor: event.power,
          actionKind: event.actionKind,
          context: event.context,
        },
      };

    // ── Summoning ─────────────────────────────────────────────────────────
    // Turn advancement is handled by awaiting_action events, not here.
    case 'summon_figure': {
      let s = moveFigure(state, event.power, event.followerId, event.toRegion, event.fromRegion, event.cost);
      // Track Plaguecarrier free redeploy (once per figure per round)
      if (event.cost === 0 && event.power === 'gormen' && event.followerClass === 'cultist' &&
          s.powers['gormen']!.upgradesInPlay.includes('gormen_plaguecarriers_up')) {
        const gp = s.powers['gormen']!;
        s = patchPower(s, 'gormen', { freeRedeployIds: [...(gp.freeRedeployIds ?? []), event.followerId] });
      }
      // Tempo signal: cumulative non-pass summoning actions this game.
      const sp = s.powers[event.power]!;
      s = patchPower(s, event.power, { summoningTurnsTaken: sp.summoningTurnsTaken + 1 });
      return s;
    }
    case 'play_card': {
      let s = playCard(state, event.power, event.cardId, event.toRegion, event.slotIndex, event.cost);
      const sp = s.powers[event.power]!;
      s = patchPower(s, event.power, { summoningTurnsTaken: sp.summoningTurnsTaken + 1 });
      return s;
    }
    case 'summoning_pass':
      return patchPower(state, event.power, { passedSummoning: true, powerPoints: 0 });
    case 'apprentice_choice':
      return applyApprenticeChoice(state, event);

    // ── Card effects ──────────────────────────────────────────────────────
    case 'card_effect':
      return applyCardEffect(state, event);

    // ── Battle ────────────────────────────────────────────────────────────
    case 'battle_kill':
      // During battle, figures are tipped first. They're actually removed by
      // figure_removed events emitted when finalizeBattle runs.
      return tipFigure(state, event.targetId);
    case 'figure_removed':
      return killFigure(state, event.regionId, event.followerId);
    case 'protected_cleared': {
      let pc = state;
      for (const power of pc.activePowers) {
        const p = pc.powers[power]!;
        if (p.followers.some(f => event.followerIds.includes(f.id))) {
          pc = patchPower(pc, power, {
            followers: p.followers.map(f => event.followerIds.includes(f.id) ? { ...f, protected: false } : f),
          });
        }
      }
      return pc;
    }
    case 'control_released':
      return setControlledBy(state, event.followerId, null);
    case 'battle_cleanup': {
      let bc = state;
      // Clear warFrenzyHits
      for (const fid of event.clearedWarFrenzyHits) {
        for (const power of bc.activePowers) {
          const p = bc.powers[power]!;
          if (p.followers.some(f => f.id === fid)) {
            bc = patchPower(bc, power, {
              followers: p.followers.map(f => f.id === fid ? { ...f, warFrenzyHits: 0 } : f),
            });
            break;
          }
        }
      }
      // Reset dial counters
      if (event.resetDialCounters) {
        for (const power of bc.activePowers) {
          bc = patchPower(bc, power, { dialCounters: 0 });
        }
      }
      return bc;
    }
    case 'chaos_card_discarded': {
      const cdr = state.regions[event.regionId]!;
      const newSlots = [...cdr.chaosCards] as typeof cdr.chaosCards;
      newSlots[event.slotIndex as 0 | 1] = null;
      const owner = state.powers[event.playedBy];
      let s2 = { ...state, regions: { ...state.regions, [event.regionId]: { ...cdr, chaosCards: newSlots } } };
      if (owner) {
        s2 = patchPower(s2, event.playedBy, { discardIds: [...owner.discardIds, event.cardId] });
      }
      return s2;
    }
    case 'harvest_kill':
      return killFigure(state, event.regionId, event.followerId);
    case 'peasant_claimed':
      return claimPeasant(state, event.regionId, event.power);
    case 'rapture_control':
      return setControlledBy(state, event.targetId, 'lasha');
    case 'heartrippers_corruption':
      return addCorruption(state, event.regionId, 'xarm', event.tokens);
    case 'dial_counter':
      return patchPower(state, event.power, {
        dialCounters: state.powers[event.power]!.dialCounters + 1,
      });

    // ── Corruption ────────────────────────────────────────────────────────
    case 'domination_result':
      if (event.conquered && event.power) {
        return scoreVP(state, event.power, event.vp);
      }
      return state;
    case 'corruption_placement':
      return addCorruption(state, event.regionId, event.power, event.tokens);
    case 'deaths_perfume':
      return addCorruption(state, event.regionId, 'gormen', event.tokens);
    case 'war_cry_block':
    case 'domination_failed':
    case 'ruination_blocked':
      return state; // informational
    case 'vile_consumption':
      return applyVileConsumption(state, event.regionId, event.figuresRemoved, event.tokensPlaced);
    case 'ruination':
      return applyRuination(state, event.regionId, event.cardIndex, event.ruiners, event.ruinerVP);
    case 'provender_score':
      return scoreVP(state, event.power, event.vp);

    // ── End ───────────────────────────────────────────────────────────────
    case 'narcotic_release':
      return setControlledBy(state, event.followerId, null);
    case 'hero_removal':
      return removeFigure(state, event.regionId, event.followerId);
    case 'world_card_effect':
      return applyWorldCardEffect(state, event);
    case 'ruination_scoring':
      return applyRuinationScoring(state, event);
    case 'dial_advance':
      return patchPower(state, event.power, {
        dialPosition: event.position,
        threatValue: typeof event.threat === 'number' ? event.threat : state.powers[event.power]!.threatValue,
      });
    case 'dial_vp':
      return scoreVP(state, event.power, event.vp);
    case 'dial_victory':
      return { ...state, winners: [event.power], winCondition: 'threat_dial', phase: 'completed' };
    case 'card_drawn':
      return drawCard(state, event.power, event.cardId);

    // ── Reducers ──────────────────────────────────────────────────────────
    case 'forced_discard': {
      const fd = state.powers[event.power]!;
      // Remove discarded cards from hand. For masked hands ('?' entries),
      // fall back to removing the right number of '?' entries.
      let newHand = [...fd.hand];
      for (const cardId of event.cardIds) {
        let idx = newHand.indexOf(cardId);
        if (idx === -1) idx = newHand.indexOf('?');
        if (idx >= 0) newHand.splice(idx, 1);
      }
      return patchPower(state, event.power, {
        hand: newHand,
        discardIds: [...fd.discardIds, ...event.cardIds],
      });
    }
    case 'upgrade_taken': {
      const p = state.powers[event.power]!;
      return patchPower(state, event.power, {
        upgradesInPlay: [...p.upgradesInPlay, event.upgradeCardId],
        availableUpgradeIds: p.availableUpgradeIds.filter(id => id !== event.upgradeCardId),
        powerPoints: event.powerPoints,
        basePowerPoints: event.basePowerPoints,
      });
    }
    case 'dial_place_token':
      return addToken(state, event.regionId, event.tokenType);
    case 'dial_remove_corruption':
      return removeCorruption(state, event.regionId, event.targetPower, 1);
    case 'dial_remove_world_token':
      return removeToken(state, event.regionId, event.tokenType);
    case 'hero_forced_removal':
      return removeFigure(state, event.regionId, event.followerId);

    // ── Draw ──────────────────────────────────────────────────────────────
    case 'tenzen_discard':
      if (event.cardId !== null) {
        const t = state.powers['tenzen']!;
        let idx = t.hand.indexOf(event.cardId);
        if (idx === -1) idx = t.hand.indexOf('?');
        if (idx === -1) return state;
        return patchPower(state, 'tenzen', {
          hand: [...t.hand.slice(0, idx), ...t.hand.slice(idx + 1)],
          discardIds: [...t.discardIds, event.cardId],
        });
      }
      return state;
    case 'power_draw': {
      // Reset PP, add drawn cards, and sync deck/discard state.
      const dp = state.powers[event.power];
      if (!dp) return state;
      const newHand = [...dp.hand, ...event.drawnCardIds];
      return {
        ...state,
        powers: {
          ...state.powers,
          [event.power]: {
            ...dp,
            hand: newHand,
            powerPoints: event.powerPoints,
            basePowerPoints: event.basePowerPoints,
            passedSummoning: false,
            freeRedeployIds: [],
            deckIds: event.deckIds,
            discardIds: event.discardIds,
          },
        },
      };
    }

    // ── Token placement/removal (world phase, etc.) ────────────────────────
    case 'token_placed':
      return addToken(state, event.regionId, event.tokenType);
    case 'token_removed':
      return removeToken(state, event.regionId, event.tokenType);

    // ── Informational (no state change) ───────────────────────────────────
    case 'world_track_update':
      return { ...state, worldTrack: { ...state.worldTrack, slot1: event.slot1, slot2: event.slot2 } };

    case 'world_card_drawn':
    case 'comet_removed':
    case 'world_card_choice':
    case 'token_supply_exhausted':
    case 'battle_region_start':
      return state;
    case 'battle_roll':
      return state;
    case 'war_frenzy_partial': {
      // Accumulate partial hits on the figure
      for (const power of state.activePowers) {
        const p = state.powers[power]!;
        if (p.followers.some(f => f.id === event.followerId)) {
          return patchPower(state, power, {
            followers: p.followers.map(f =>
              f.id === event.followerId ? { ...f, warFrenzyHits: f.warFrenzyHits + event.hits } : f
            ),
          });
        }
      }
      return state;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function patchPower(state: GameState, power: Power, update: Partial<GameState['powers'][Power]>): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, ...update },
    },
  };
}

function scoreVP(state: GameState, power: Power, amount: number): GameState {
  if (amount === 0) return state;
  return patchPower(state, power, {
    victoryPoints: state.powers[power]!.victoryPoints + amount,
  });
}

function addCorruption(state: GameState, regionId: RegionId, power: Power, tokens: number): GameState {
  const region = state.regions[regionId]!;
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...region,
        corruptionTokens: {
          ...region.corruptionTokens,
          [power]: region.corruptionTokens[power] + tokens,
        },
      },
    },
  };
}

function removeCorruption(state: GameState, regionId: RegionId, power: Power, tokens: number): GameState {
  const region = state.regions[regionId]!;
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...region,
        corruptionTokens: {
          ...region.corruptionTokens,
          [power]: Math.max(0, region.corruptionTokens[power] - tokens),
        },
      },
    },
  };
}

function addToken(state: GameState, regionId: RegionId, tokenType: string): GameState {
  const region = state.regions[regionId]!;
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...region,
        tokens: [...region.tokens, tokenType as GameState['regions'][RegionId]['tokens'][number]],
      },
    },
  };
}

function removeToken(state: GameState, regionId: RegionId, tokenType: string): GameState {
  const region = state.regions[regionId]!;
  const idx = region.tokens.indexOf(tokenType as GameState['regions'][RegionId]['tokens'][number]);
  if (idx === -1) return state;
  const tokens = [...region.tokens];
  tokens.splice(idx, 1);
  return {
    ...state,
    regions: { ...state.regions, [regionId]: { ...region, tokens } },
  };
}

function moveFigure(
  state: GameState, power: Power, followerId: string,
  toRegion: RegionId, _fromRegion: RegionId | null, cost: number,
): GameState {
  // Find the figure — may be in the acting power's array or another power's
  // (controlled figures via Narcotic Musk)
  let ownerPower = power;
  let follower = state.powers[power]!.followers.find(f => f.id === followerId);
  if (!follower) {
    for (const p of state.activePowers) {
      const f = state.powers[p]!.followers.find(f => f.id === followerId);
      if (f) { follower = f; ownerPower = p; break; }
    }
  }
  if (!follower) return state;

  const updated = { ...follower, regionId: toRegion };
  let s = patchPower(state, ownerPower, {
    followers: state.powers[ownerPower]!.followers.map(f => f.id === followerId ? updated : f),
  });
  // Deduct cost from the acting power
  if (cost > 0) {
    s = patchPower(s, power, { powerPoints: s.powers[power]!.powerPoints - cost });
  }
  return s;
}

function playCard(
  state: GameState, power: Power, cardId: string,
  toRegion: RegionId, slotIndex: 0 | 1, cost: number,
): GameState {
  const p = state.powers[power]!;
  // Try exact match first; fall back to removing a masked '?' entry
  // (other players' hands are masked by maskStateForViewer)
  let idx = p.hand.indexOf(cardId);
  if (idx === -1) idx = p.hand.indexOf('?');
  if (idx === -1) return state;

  const newHand = [...p.hand.slice(0, idx), ...p.hand.slice(idx + 1)];
  const region = state.regions[toRegion]!;
  const newSlots = [...region.chaosCards] as typeof region.chaosCards;
  newSlots[slotIndex] = { cardId, playedBy: power, slotIndex, persistNextRound: false, placedAt: 0 };

  return {
    ...state,
    powers: { ...state.powers, [power]: { ...p, hand: newHand, powerPoints: p.powerPoints - cost } },
    regions: { ...state.regions, [toRegion]: { ...region, chaosCards: newSlots } },
  };
}

function killFigure(state: GameState, _regionId: RegionId, followerId: string): GameState {
  // Find which power owns this figure
  for (const power of state.activePowers) {
    const fig = state.powers[power]!.followers.find(f => f.id === followerId);
    if (fig) {
      return patchPower(state, power, {
        followers: state.powers[power]!.followers.map(f =>
          f.id === followerId ? { ...f, regionId: null, controlledBy: null, tipped: false, warFrenzyHits: 0 } : f
        ),
      });
    }
  }
  return state;
}

function tipFigure(state: GameState, followerId: string): GameState {
  for (const power of state.activePowers) {
    const p = state.powers[power]!;
    if (p.followers.some(f => f.id === followerId)) {
      return patchPower(state, power, {
        followers: p.followers.map(f => f.id === followerId ? { ...f, tipped: true } : f),
      });
    }
  }
  return state;
}

function removeFigure(state: GameState, regionId: RegionId, followerId: string): GameState {
  return killFigure(state, regionId, followerId);
}

function claimPeasant(state: GameState, regionId: RegionId, power: Power): GameState {
  let s = removeToken(state, regionId, 'peasant');
  s = patchPower(s, power, { claimedPeasants: s.powers[power]!.claimedPeasants + 1 });
  return s;
}

function setControlledBy(state: GameState, followerId: string, controller: Power | null): GameState {
  // Find which power owns this figure and update followers
  for (const power of state.activePowers) {
    const p = state.powers[power]!;
    const fig = p.followers.find(f => f.id === followerId);
    if (fig) {
      return patchPower(state, power, {
        followers: p.followers.map(f => f.id === followerId ? { ...f, controlledBy: controller } : f),
      });
    }
  }
  return state;
}

function drawCard(state: GameState, power: Power, cardId: string): GameState {
  const p = state.powers[power]!;
  // Add to hand. Remove from deck if present; if deck is empty, clear discard
  // (the engine reshuffled it into deck, then drew — we just need to keep
  // deck/discard roughly in sync for the next power_draw to correct fully).
  let { deckIds, discardIds } = p;
  if (deckIds.length === 0 && discardIds.length > 0) {
    deckIds = discardIds;
    discardIds = [];
  }
  const idx = deckIds.indexOf(cardId);
  const newDeck = idx >= 0 ? [...deckIds.slice(0, idx), ...deckIds.slice(idx + 1)] : deckIds;
  return patchPower(state, power, {
    hand: [...p.hand, cardId],
    deckIds: newDeck,
    discardIds,
  });
}


function applyApprenticeChoice(
  state: GameState,
  event: Extract<GameEvent, { type: 'apprentice_choice' }>,
): GameState {
  if (!event.carry) return state;
  // Move chaos stone from fromRegion to toRegion
  let s = removeToken(state, event.fromRegion, 'chaos_stone');
  s = addToken(s, event.toRegion, 'chaos_stone');
  return s;
}

function applyCardEffect(
  state: GameState,
  event: Extract<GameEvent, { type: 'card_effect' }>,
): GameState {
  switch (event.subtype) {
    case 'plaguefather_corruption':
      return addCorruption(state, event.regionId, 'gormen', event.tokens);
    case 'fractals_summon': {
      const tp = state.powers['tenzen'];
      if (!tp) return state;
      return patchPower(state, 'tenzen', {
        followers: tp.followers.map(f => f.id === event.followerId ? { ...f, regionId: event.regionId } : f),
      });
    }
    case 'call_to_war':
      return moveFigure(state, event.power, event.followerId, event.toRegion, event.fromRegion, 0);
    case 'teleport': {
      // Find the figure's owner power
      for (const p of state.activePowers) {
        if (state.powers[p]!.followers.some(f => f.id === event.followerId)) {
          return moveFigure(state, p, event.followerId, event.toRegion, event.fromRegion, 0);
        }
      }
      return state;
    }
    case 'meddling_of_rats':
      // Discard is now immediate — handled by forced_discard event that follows
      return state;
    case 'fate_shield': {
      for (const power of state.activePowers) {
        const p = state.powers[power]!;
        const fig = p.followers.find(f => f.id === event.followerId);
        if (fig) {
          return patchPower(state, power, {
            followers: p.followers.map(f => f.id === event.followerId ? { ...f, protected: true } : f),
          });
        }
      }
      return state;
    }
    case 'hidden_influence': {
      let s = removeToken(state, event.fromRegion, event.tokenType);
      s = addToken(s, event.toRegion, event.tokenType);
      return s;
    }
    case 'narcotic_musk':
      return setControlledBy(state, event.followerId, 'lasha');
    case 'decay':
      return removeCorruption(state, event.regionId, event.power, 1);
    case 'siphon_power': {
      let s2 = state;
      for (const p of event.stolenFrom) {
        s2 = patchPower(s2, p, { powerPoints: s2.powers[p]!.powerPoints - 1 });
      }
      if (event.stolenFrom.length > 0) {
        s2 = patchPower(s2, 'tenzen', { powerPoints: s2.powers['tenzen']!.powerPoints + 1 });
      }
      return s2;
    }
    case 'depraved_infiltration':
      return addCorruption(state, event.regionId, 'lasha', 1);
  }
}

function applyVileConsumption(
  state: GameState, regionId: RegionId,
  _figuresRemoved: number, tokensPlaced: number,
): GameState {
  let s = state;

  // Remove gormen figures from this region (set regionId to null)
  s = patchPower(s, 'gormen', {
    followers: s.powers['gormen']!.followers.map(f =>
      f.regionId === regionId ? { ...f, regionId: null } : f
    ),
  });

  // Add corruption
  if (tokensPlaced > 0) {
    s = addCorruption(s, regionId, 'gormen', tokensPlaced);
  }
  return s;
}

function applyRuination(
  state: GameState, regionId: RegionId,
  cardIndex: number, ruiners: Power[], ruinerVP: number,
): GameState {
  let s = {
    ...state,
    ruinationCardsUsed: state.ruinationCardsUsed + 1,
    regions: {
      ...state.regions,
      [regionId]: { ...state.regions[regionId]!, ruinationCardIndex: cardIndex },
    },
  };
  for (const power of ruiners) {
    s = scoreVP(s, power, ruinerVP);
  }
  return s;
}

function applyRuinationScoring(
  state: GameState,
  event: Extract<GameEvent, { type: 'ruination_scoring' }>,
): GameState {
  let s = state;
  for (const p of event.first) {
    s = scoreVP(s, p, event.firstVP);
  }
  for (const p of event.second) {
    s = scoreVP(s, p, event.secondVP);
  }
  // Clear corruption tokens after scoring
  s = {
    ...s,
    regions: {
      ...s.regions,
      [event.regionId]: {
        ...s.regions[event.regionId]!,
        corruptionTokens: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
      },
    },
  };
  return s;
}

function applyWorldCardEffect(
  state: GameState,
  event: Extract<GameEvent, { type: 'world_card_effect' }>,
): GameState {
  switch (event.subtype) {
    case 'normagne_heir_discard': {
      const p = state.powers[event.power]!;
      let idx = p.hand.indexOf(event.cardId);
      if (idx === -1) idx = p.hand.indexOf('?');
      if (idx === -1) return state;
      return patchPower(state, event.power, {
        hand: [...p.hand.slice(0, idx), ...p.hand.slice(idx + 1)],
        discardIds: [...p.discardIds, event.cardId],
      });
    }
    case 'northern_heir':
      return addToken(state, event.regionId, 'hero');
    case 'diplomatic_envoy':
      return removeToken(state, event.regionId, 'hero');
    case 'chaos_countermeasures':
      return addToken(state, event.regionId, 'ratmen');
    case 'great_exorcism_figures': {
      // Remove all Cultists from region
      let s = state;
      for (const power of s.activePowers) {
        const p = s.powers[power]!;
        const hasCultistInRegion = p.followers.some(f => f.regionId === event.regionId && f.class === 'cultist');
        if (hasCultistInRegion) {
          s = patchPower(s, power, {
            followers: p.followers.map(f =>
              f.regionId === event.regionId && f.class === 'cultist'
                ? { ...f, regionId: null, controlledBy: null }
                : f
            ),
          });
        }
      }
      return s;
    }
    case 'great_exorcism_events':
      // Actual token movement handled by preceding token_removed/token_placed events
      return state;
    case 'central_overpopulation':
      // Peasant removal handled by preceding token_removed event
      return state;
    case 'cleansing_wave':
      return {
        ...state,
        regions: {
          ...state.regions,
          [event.regionId]: {
            ...state.regions[event.regionId]!,
            corruptionTokens: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
          },
        },
      };
    case 'noble_scrutiny':
      return removeCorruption(state, event.regionId, event.power, 1);
    case 'eastern_armistice':
      return removeFigure(state, event.regionId, event.followerId);
    case 'peasant_harvest':
      return scoreVP(state, event.power, event.vp);
    case 'accelerating_doom':
    case 'forward_scouts_empty':
      return state;
  }
}

/**
 * After a summoning action (summon, play card, pass), advance to the next
 * power's turn. Mirrors the logic in summoning.ts:advanceSummoningTurn.
 */
function advanceSummoning(state: GameState, justActed: Power): GameState {
  if (state.phase !== 'summoning') return state;
  const order = state.summoningOrder;
  if (order.length === 0) return state;

  // Check if all powers are done (PP=0 or passed)
  const allDone = order.every(p => {
    const ps = state.powers[p]!;
    return ps.powerPoints <= 0 || ps.passedSummoning;
  });
  if (allDone) {
    return { ...state, phase: 'battle', pendingAction: null, summoningIndex: 0 };
  }

  // Advance to next power with PP remaining
  let next = (state.summoningIndex + 1) % order.length;
  let iterations = 0;
  while (iterations < order.length) {
    const candidate = order[next]!;
    const ps = state.powers[candidate]!;
    if (ps.powerPoints > 0 && !ps.passedSummoning) break;
    next = (next + 1) % order.length;
    iterations++;
  }

  const nextPower = order[next]!;
  return {
    ...state,
    summoningIndex: next,
    pendingAction: {
      waitingFor: nextPower,
      actionKind: 'summoning_action',
      context: {},
    },
  };
}

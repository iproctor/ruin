/**
 * Handlers for on-play chaos card effects that require a player choice.
 * Called from reducers.ts when a 'card_on_play_choice' action is received.
 */
import type {
  GameState, Power, RegionId, TokenType, CardOnPlayChoiceAction,
} from '../types.js';
import { REGION_ORDER } from '../constants.js';
import { updatePower, updateRegion } from '../helpers.js';
import { advanceSummoningTurn } from './summoning.js';

export function applyCardOnPlayChoice(
  state: GameState,
  action: CardOnPlayChoiceAction,
): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s: GameState = { ...state, pendingAction: null };
  const { power, cardId, regionId, choices } = action;

  switch (cardId) {
    // ── Xarm: War March ───────────────────────────────────────────────────────
    // Move up to 2 own figures from any adjacent region into this region
    case 'xarm_war_march': {
      const followerIds = (choices['followerIds'] as string[] | undefined) ?? [];
      for (const fId of followerIds.slice(0, 2)) {
        const figure = findFigureAnywhere(s, fId);
        if (!figure || figure.power !== power) continue;
        const fromRegion = figure.regionId;
        if (fromRegion === null || fromRegion === regionId) continue;

        // Remove from old region
        s = updateRegion(s, fromRegion, {
          placements: s.regions[fromRegion]!.placements.filter(f => f.id !== fId),
        });
        // Add to target region
        const moved = { ...figure, regionId };
        s = updateRegion(s, regionId, {
          placements: [...s.regions[regionId]!.placements, moved],
        });
        // Update follower record
        s = updatePower(s, power, {
          followers: s.powers[power]!.followers.map(f => f.id === fId ? moved : f),
        });
        log.push(`War March: ${power} moves ${fId} from ${fromRegion} to ${regionId}.`);
      }
      break;
    }

    // ── Tenzen: Phase Shift ───────────────────────────────────────────────────
    // Move a Cultist or Warrior in this region to any other region
    case 'tenzen_phase_shift': {
      const followerId = choices['followerId'] as string;
      const toRegion = choices['toRegion'] as RegionId;
      const figure = s.regions[regionId]!.placements.find(f => f.id === followerId);
      if (figure && (figure.class === 'cultist' || figure.class === 'warrior') && toRegion !== regionId) {
        s = updateRegion(s, regionId, {
          placements: s.regions[regionId]!.placements.filter(f => f.id !== followerId),
        });
        const moved = { ...figure, regionId: toRegion };
        s = updateRegion(s, toRegion, {
          placements: [...s.regions[toRegion]!.placements, moved],
        });
        s = updatePower(s, figure.power as Power, {
          followers: s.powers[figure.power as Power]!.followers.map(f => f.id === followerId ? moved : f),
        });
        log.push(`Phase Shift: ${figure.power} ${figure.class} moved from ${regionId} to ${toRegion}.`);
      }
      break;
    }

    // ── Tenzen: Stolen Thoughts ───────────────────────────────────────────────
    // Target opponent discards 2 chaos cards (auto: discard last 2 in hand)
    case 'tenzen_stolen_thoughts': {
      const targetPower = choices['targetPower'] as Power;
      const tp = s.powers[targetPower]!;
      const toDiscard = tp.hand.slice(-2);
      s = updatePower(s, targetPower, {
        hand: tp.hand.slice(0, -toDiscard.length),
        discardIds: [...tp.discardIds, ...toDiscard],
      });
      log.push(`Stolen Thoughts: ${targetPower} discards ${toDiscard.length} card(s).`);
      break;
    }

    // ── Tenzen: Fate's Aegis ─────────────────────────────────────────────────
    // Chosen figure cannot be killed in battle this round
    case 'tenzen_fates_aegis': {
      const followerId = choices['followerId'] as string;
      const figure = s.regions[regionId]!.placements.find(f => f.id === followerId);
      if (figure) {
        s = updateRegion(s, regionId, {
          placements: s.regions[regionId]!.placements.map(f =>
            f.id === followerId ? { ...f, protected: true } : f
          ),
        });
        s = updatePower(s, figure.power as Power, {
          followers: s.powers[figure.power as Power]!.followers.map(f =>
            f.id === followerId ? { ...f, protected: true } : f
          ),
        });
        log.push(`Fate's Aegis: ${followerId} is protected from death this round.`);
      }
      break;
    }

    // ── Lasha: Invisible Hand ─────────────────────────────────────────────────
    // Move a Peasant, Hero, or Noble token from this region to any other region
    case 'lasha_invisible_hand': {
      const token = choices['token'] as TokenType;
      const fromRegion = (choices['fromRegion'] as RegionId | undefined) ?? regionId;
      const toRegion = choices['toRegion'] as RegionId;
      if (['peasant', 'hero', 'noble'].includes(token) && fromRegion !== toRegion) {
        const srcTokens = [...s.regions[fromRegion]!.tokens];
        const idx = srcTokens.indexOf(token);
        if (idx !== -1) {
          srcTokens.splice(idx, 1);
          s = updateRegion(s, fromRegion, { tokens: srcTokens });
          s = updateRegion(s, toRegion, {
            tokens: [...s.regions[toRegion]!.tokens, token],
          });
          log.push(`Invisible Hand: ${token} moved from ${fromRegion} to ${toRegion}.`);
        }
      }
      break;
    }

    // ── Lasha: Enthrallment ───────────────────────────────────────────────────
    // Choose one enemy Cultist in this region; Lasha controls it
    case 'lasha_enthrallment': {
      const followerId = choices['followerId'] as string;
      const figure = s.regions[regionId]!.placements.find(f =>
        f.id === followerId && f.class === 'cultist' &&
        (f.controlledBy ?? f.power) !== 'lasha'
      );
      if (figure) {
        s = updateRegion(s, regionId, {
          placements: s.regions[regionId]!.placements.map(f =>
            f.id === followerId ? { ...f, controlledBy: 'lasha' } : f
          ),
        });
        s = updatePower(s, figure.power as Power, {
          followers: s.powers[figure.power as Power]!.followers.map(f =>
            f.id === followerId ? { ...f, controlledBy: 'lasha' } : f
          ),
        });
        log.push(`Enthrallment: Lasha controls ${figure.power} cultist ${followerId}.`);
      }
      break;
    }
  }

  return { state: advanceSummoningTurn(s, power), log };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findFigureAnywhere(state: GameState, followerId: string) {
  for (const power of state.activePowers) {
    const f = state.powers[power]!.followers.find(f => f.id === followerId);
    if (f) return f;
  }
  return null;
}

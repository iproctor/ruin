/**
 * Handlers for on-play chaos card effects that require a player choice.
 * Called from reducers.ts when a 'card_on_play_choice' action is received.
 */
import type {
  GameState, Power, RegionId, TokenType, CardOnPlayChoiceAction,
} from '../types.js';
import { GameLog } from '../gameLog.js';
import { updatePower, updateRegion } from '../helpers.js';
import { advanceSummoningTurn } from './summoning.js';

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
        if (!figure || figure.power !== power) continue;
        const fromRegion = figure.regionId;
        if (fromRegion === null || fromRegion === regionId) continue;

        // Remove from old region
        s = updateRegion(s, fromRegion, {
          placements: s.regions[fromRegion]!.placements.filter(f => f.id !== fId),
        });
        // Add to target region
        const moved = { ...figure, regionId, placedAt: s.actionCount };
        s = updateRegion(s, regionId, {
          placements: [...s.regions[regionId]!.placements, moved],
        });
        // Update follower record
        s = updatePower(s, power, {
          followers: s.powers[power]!.followers.map(f => f.id === fId ? moved : f),
        });
        log.emit({ type: 'card_effect', subtype: 'call_to_war', power, followerId: fId, fromRegion, toRegion: regionId });
      }
      break;
    }

    // ── Tenzen: Phase Shift ───────────────────────────────────────────────────
    // Move a Cultist or Warrior in this region to any other region
    case 'tenzen_teleport': {
      const followerId = choices['followerId'] as string;
      const toRegion = choices['toRegion'] as RegionId;
      const figure = s.regions[regionId]!.placements.find(f => f.id === followerId);
      if (figure && (figure.class === 'cultist' || figure.class === 'warrior') && toRegion !== regionId) {
        s = updateRegion(s, regionId, {
          placements: s.regions[regionId]!.placements.filter(f => f.id !== followerId),
        });
        const moved = { ...figure, regionId: toRegion, placedAt: s.actionCount };
        s = updateRegion(s, toRegion, {
          placements: [...s.regions[toRegion]!.placements, moved],
        });
        s = updatePower(s, figure.power as Power, {
          followers: s.powers[figure.power as Power]!.followers.map(f => f.id === followerId ? moved : f),
        });
        log.emit({ type: 'card_effect', subtype: 'teleport', power: figure.power as Power, followerClass: figure.class, fromRegion: regionId, toRegion });
      }
      break;
    }

    // ── Tenzen: Meddling of Rats ───────────────────────────────────────────────
    // Queue a forced discard on the target — they choose on their next summoning turn
    case 'tenzen_the_meddling_of_rats': {
      const targetPower = choices['targetPower'] as Power;
      const current = s.powers[targetPower]!.pendingForcedDiscards;
      s = updatePower(s, targetPower, { pendingForcedDiscards: current + 2 });
      log.emit({ type: 'card_effect', subtype: 'meddling_of_rats', targetPower });
      break;
    }

    // ── Tenzen: Fate's Aegis ─────────────────────────────────────────────────
    // Chosen figure cannot be killed in battle this round
    case 'tenzen_fate_shield': {
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
        log.emit({ type: 'card_effect', subtype: 'fate_shield', followerId });
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
        const srcTokens = [...s.regions[fromRegion]!.tokens];
        const idx = srcTokens.indexOf(token);
        if (idx !== -1) {
          srcTokens.splice(idx, 1);
          s = updateRegion(s, fromRegion, { tokens: srcTokens });
          s = updateRegion(s, toRegion, {
            tokens: [...s.regions[toRegion]!.tokens, token],
          });
          log.emit({ type: 'card_effect', subtype: 'hidden_influence', tokenType: token, fromRegion, toRegion });
        }
      }
      break;
    }

    // ── Lasha: Enthrallment ───────────────────────────────────────────────────
    // Choose one enemy Cultist in this region; Lasha controls it
    case 'lasha_narcotic_musk': {
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
        log.emit({ type: 'card_effect', subtype: 'narcotic_musk', power: figure.power as Power, followerId });
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

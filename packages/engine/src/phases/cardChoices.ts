/**
 * Handlers for on-play chaos card effects that require a player choice.
 * Called from reducers.ts when a 'card_on_play_choice' action is received.
 */
import type {
  GameState, Power, RegionId, TokenType, CardOnPlayChoiceAction,
} from '../types.js';
import { GameLog } from '../gameLog.js';
import { updatePower, updateRegion, followersInRegion } from '../helpers.js';
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
        if (!figure || figure.power !== power || (figure.controlledBy && figure.controlledBy !== power)) continue;
        const fromRegion = figure.regionId;
        if (fromRegion === null || fromRegion === regionId) continue;

        // Update follower record (move to target region)
        const moved = { ...figure, regionId, placedAt: s.actionCount };
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
      const carry = choices['carry'] as boolean | undefined;
      const figure = followersInRegion(s, regionId).find(f => f.id === followerId);
      if (figure && (figure.class === 'cultist' || figure.class === 'warrior') && toRegion !== regionId) {
        const moved = { ...figure, regionId: toRegion, placedAt: s.actionCount };
        s = updatePower(s, figure.power as Power, {
          followers: s.powers[figure.power as Power]!.followers.map(f => f.id === followerId ? moved : f),
        });
        log.emit({ type: 'card_effect', subtype: 'teleport', power: figure.power as Power, followerClass: figure.class, fromRegion: regionId, toRegion });

        // Tenzen Apprentice upgrade: carry chaos stone when teleporting a cultist
        if (carry !== undefined && figure.power === 'tenzen' && figure.class === 'cultist' &&
            s.powers['tenzen']!.upgradesInPlay.includes('tenzen_apprentices_up') &&
            s.regions[regionId]!.tokens.includes('chaos_stone')) {
          if (carry) {
            const tokens = [...s.regions[regionId]!.tokens];
            const stoneIdx = tokens.indexOf('chaos_stone');
            if (stoneIdx !== -1) {
              tokens.splice(stoneIdx, 1);
              s = updateRegion(s, regionId, { tokens });
              s = updateRegion(s, toRegion, { tokens: [...s.regions[toRegion]!.tokens, 'chaos_stone'] });
              log.emit({ type: 'apprentice_choice', followerId, fromRegion: regionId, toRegion, carry: true });
            }
          } else {
            log.emit({ type: 'apprentice_choice', followerId, fromRegion: regionId, toRegion, carry: false });
          }
        }
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
      const figure = followersInRegion(s, regionId).find(f => f.id === followerId);
      if (figure) {
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
      const figure = followersInRegion(s, regionId).find(f =>
        f.id === followerId && f.class === 'cultist' &&
        (f.controlledBy ?? f.power) !== 'lasha'
      );
      if (figure) {
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

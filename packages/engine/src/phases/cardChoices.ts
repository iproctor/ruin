/**
 * Handlers for on-play chaos card effects that require a player choice.
 * Called from reducers.ts when a 'card_on_play_choice' action is received.
 */
import type {
  GameState, Power, RegionId, TokenType, CardOnPlayChoiceAction,
} from '../types.js';
import { GameLog } from '../gameLog.js';
import { followersInRegion } from '../helpers.js';
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
        s = log.apply(s, { type: 'card_effect', subtype: 'teleport', power: figure.power as Power, followerId, followerClass: figure.class, fromRegion: regionId, toRegion });

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
    // Target must immediately discard 2 cards
    case 'tenzen_the_meddling_of_rats': {
      const targetPower = choices['targetPower'] as Power;
      const targetPs = s.powers[targetPower]!;
      const required = Math.min(2, targetPs.hand.length);
      log.emit({ type: 'card_effect', subtype: 'meddling_of_rats', targetPower });

      if (required > 0 && targetPs.hand.length > required) {
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
        // Auto-discard (hand <= required)
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

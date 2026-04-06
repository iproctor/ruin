import type { GameState, Action } from './types.js';
import { resolveWorldPhase, applyWorldChoice } from './phases/world.js';
import { beginDrawPhase, applyTenzenDiscard } from './phases/draw.js';
import { applySummonFigure, applyPlayCard, applySummoningPass } from './phases/summoning.js';
import { resolveBattlePhase, applyCorruptionHarvestChoice } from './phases/battle.js';
import { resolveCorruptionPhase } from './phases/corruption.js';
import { resolveEndPhase } from './phases/end.js';
import { applyCardOnPlayChoice } from './phases/cardChoices.js';
import { checkVictory } from './victory.js';

export interface ApplyResult {
  state: GameState;
  log: string[];
}

/**
 * Apply a player action or advance an autonomous phase.
 * Increments actionCount on every call for RNG determinism.
 */
export function applyAction(state: GameState, action: Action): ApplyResult {
  let s = { ...state, actionCount: state.actionCount + 1 };

  // Validate that the action is from the right power
  if (s.pendingAction && s.pendingAction.waitingFor !== action.power) {
    throw new Error(
      `Action from ${action.power} but waiting for ${s.pendingAction.waitingFor}`
    );
  }

  let result: ApplyResult;

  switch (action.kind) {
    case 'world_choice':
      result = applyWorldChoice(s, action);
      break;

    case 'tenzen_discard':
      result = applyTenzenDiscard(s, action);
      break;

    case 'summoning_summon_figure':
      result = applySummonFigure(s, action);
      break;

    case 'summoning_play_card':
      result = applyPlayCard(s, action);
      break;

    case 'summoning_pass':
      result = applySummoningPass(s, action);
      break;

    case 'corruption_harvest_choice':
      result = applyCorruptionHarvestChoice(s, action);
      break;

    case 'card_on_play_choice':
      result = applyCardOnPlayChoice(s, action);
      break;

    case 'upgrade_choice': {
      const p = s.powers[action.power]!;
      if (!p.availableUpgradeIds.includes(action.upgradeCardId)) {
        throw new Error(`Upgrade ${action.upgradeCardId} not available for ${action.power}`);
      }
      s = {
        ...s,
        pendingAction: null,
        powers: {
          ...s.powers,
          [action.power]: {
            ...p,
            upgradesInPlay: [...p.upgradesInPlay, action.upgradeCardId],
            availableUpgradeIds: p.availableUpgradeIds.filter(id => id !== action.upgradeCardId),
          },
        },
      };
      result = { state: s, log: [`${action.power} takes upgrade: ${action.upgradeCardId}.`] };
      break;
    }

    case 'hero_removal': {
      const region = s.regions[action.regionId]!;
      const figure = region.placements.find(f => f.id === action.followerId);
      if (!figure) throw new Error(`Figure ${action.followerId} not in ${action.regionId}`);
      s = {
        ...s,
        pendingAction: null,
        regions: {
          ...s.regions,
          [action.regionId]: {
            ...region,
            placements: region.placements.filter(f => f.id !== action.followerId),
          },
        },
        powers: {
          ...s.powers,
          [figure.power]: {
            ...s.powers[figure.power]!,
            followers: s.powers[figure.power]!.followers.map(f =>
              f.id === action.followerId ? { ...f, regionId: null, controlledBy: null } : f
            ),
          },
        },
      };
      result = {
        state: s,
        log: [`${action.power} removes ${figure.class} (${action.followerId}) due to Hero token.`],
      };
      break;
    }

    case 'world_card_effect':
      // Generic world card effect — currently no additional interactive world card effects
      result = { state: { ...s, pendingAction: null }, log: [] };
      break;

    default:
      throw new Error(`Unknown action kind: ${(action as Action).kind}`);
  }

  // After action, check if we should auto-advance autonomous phases
  result = autoAdvance(result);
  return result;
}

/**
 * Advance autonomous phases (world, battle start, corruption, end) that don't
 * require player input. Stops when pendingAction is set or game is complete.
 */
export function autoAdvance(result: ApplyResult): ApplyResult {
  let { state: s, log } = result;

  while (true) {
    // Stop if waiting for player input or game is over
    if (s.pendingAction !== null) break;
    if (s.winners !== null) break;
    if (s.phase === 'completed') break;

    // Check for autonomous phase transitions
    let next: ApplyResult;

    switch (s.phase) {
      case 'world': {
        const victory = checkVictory(s);
        if (victory) {
          s = { ...s, winners: victory.winners, winCondition: victory.condition, phase: 'completed' };
          log = [...log, `Game over: ${victory.winners.join(', ')} win by ${victory.condition}.`];
          return { state: s, log };
        }
        next = resolveWorldPhase(s);
        break;
      }

      case 'draw':
        next = beginDrawPhase(s);
        break;

      case 'battle':
        // Battle is only started by autoAdvance once (from summoning → battle transition)
        // After that, battle may require choices — handled by applyCorruptionHarvestChoice
        next = resolveBattlePhase(s);
        break;

      case 'corruption':
        next = resolveCorruptionPhase(s);
        break;

      case 'end':
        next = resolveEndPhase(s);
        break;

      default:
        // summoning, lobby, completed: no autonomous advance
        return { state: s, log };
    }

    log = [...log, ...next.log];
    s = next.state;
  }

  return { state: s, log };
}

import type { GameState, Action, Power, DialPendingReward } from './types.js';
import { resolveWorldPhase, applyWorldChoice, applyCompanionWorldPick } from './phases/world.js';
import { beginDrawPhase, applyTenzenDiscard, getBasePP } from './phases/draw.js';
import { applySummonFigure, applyPlayCard, applySummoningPass, applyTenzenApprenticeChoice, advanceSummoningTurn, applyCardOnPlayChoice } from './phases/summoning.js';
import { resolveBattlePhase, applyCorruptionHarvestChoice, applyBattleHitAssignment, applyCompanionDiceRoll, applyRaptureChoice } from './phases/battle.js';
import { resolveCorruptionPhase } from './phases/corruption.js';
import { resolveEndPhase, applyWorldCardEffectChoice } from './phases/end.js';
import { checkVictory } from './victory.js';
import { GameLog } from './gameLog.js';

export interface ApplyResult {
  state: GameState;
  log: GameLog;
}

/**
 * Apply a player action without auto-advancing autonomous phases.
 * Use this for client-side preview so the display doesn't race ahead through
 * battle/corruption/end phases before the action is submitted to the server.
 */
export function applyActionForPreview(state: GameState, action: Action): ApplyResult {
  let s = { ...state, actionCount: state.actionCount + 1 };
  if (s.pendingAction && s.pendingAction.waitingFor !== action.power) {
    throw new Error(`Action from ${action.power} but waiting for ${s.pendingAction.waitingFor}`);
  }
  // Emit at start so event replay can keep actionCount in sync without
  // inferring it from event count (events != actions; one action emits many).
  const result = applyActionSwitch(s, action);
  result.log.events.unshift({ type: 'action_applied', actionCount: s.actionCount });
  return result;
}


/** Remove the first item from the dial rewards queue; returns null when empty. */
function popDialReward(queue: DialPendingReward[] | null): DialPendingReward[] | null {
  if (!queue || queue.length <= 1) return [];  // empty array, not null — prevents end-phase re-run
  return queue.slice(1);
}

function applyActionSwitch(s: GameState, action: Action): ApplyResult {
  let result: ApplyResult;

  switch (action.kind) {
    case 'world_choice':
      result = applyWorldChoice(s, action);
      break;

    case 'companion_world_pick':
      result = applyCompanionWorldPick(s, action);
      break;

    case 'companion_dice_roll':
      result = applyCompanionDiceRoll(s, action);
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

    case 'battle_hit_assignment':
      result = applyBattleHitAssignment(s, action);
      break;

    case 'card_on_play_choice':
      result = applyCardOnPlayChoice(s, action);
      break;

    case 'tenzen_apprentice_choice':
      result = applyTenzenApprenticeChoice(s, action);
      break;

    case 'rapture_choice':
      result = applyRaptureChoice(s, action);
      break;

    case 'forced_discard': {
      const p = s.powers[action.power as Power]!;
      const ctx = s.pendingAction?.context ?? {};
      const required = (ctx['count'] as number) ?? Math.min(2, p.hand.length);
      const toDiscard = action.cardIds.filter(id => p.hand.includes(id)).slice(0, required);
      // Return to the power that played Meddling of Rats (stored in context)
      const returnTo = (ctx['returnTo'] as Power) ?? action.power as Power;
      const log = new GameLog();
      s = log.apply(s, { type: 'forced_discard', power: action.power as Power, count: toDiscard.length, cardIds: toDiscard });
      s = advanceSummoningTurn(s, returnTo, log);
      result = { state: s, log };
      break;
    }

    case 'upgrade_choice': {
      const p = s.powers[action.power]!;
      if (!p.availableUpgradeIds.includes(action.upgradeCardId)) {
        throw new Error(`Upgrade ${action.upgradeCardId} not available for ${action.power}`);
      }
      s = { ...s, pendingAction: null, pendingDialRewards: popDialReward(s.pendingDialRewards) };
      // Compute new PP values before emitting the fat event
      // Temporarily apply the upgrade to compute basePP
      const tempUpgrades = [...p.upgradesInPlay, action.upgradeCardId];
      const tempState = { ...s, powers: { ...s.powers, [action.power]: { ...p, upgradesInPlay: tempUpgrades } } };
      const newBase = getBasePP(tempState, action.power);
      const log = new GameLog();
      s = log.apply(s, { type: 'upgrade_taken', power: action.power, upgradeCardId: action.upgradeCardId, powerPoints: newBase, basePowerPoints: newBase });
      result = { state: s, log };
      break;
    }

    case 'dial_place_token': {
      const queue = s.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'place_token') throw new Error('No place_token reward pending');
      const region = s.regions[action.regionId];
      if (!region || region.ruinationCardIndex !== null) throw new Error(`Cannot place token on ${action.regionId}`);
      s = {
        ...s,
        pendingAction: null,
        pendingDialRewards: reward.remaining <= 1
          ? popDialReward(queue)
          : [{ ...reward, remaining: reward.remaining - 1 }, ...queue.slice(1)],
      };
      const log = new GameLog();
      s = log.apply(s, { type: 'dial_place_token', power: action.power as Power, regionId: action.regionId, tokenType: reward.tokenType });
      result = { state: s, log };
      break;
    }

    case 'dial_remove_corruption': {
      const queue = s.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'remove_corruption') throw new Error('No remove_corruption reward pending');
      const region = s.regions[action.regionId]!;
      const target = action.targetPower;
      const curr = region.corruptionTokens[target];
      if (curr <= 0) throw new Error(`No ${target} corruption in ${action.regionId}`);
      s = {
        ...s,
        pendingAction: null,
        pendingDialRewards: reward.remaining <= 1
          ? popDialReward(queue)
          : [{ ...reward, remaining: reward.remaining - 1 }, ...queue.slice(1)],
      };
      const log = new GameLog();
      s = log.apply(s, { type: 'dial_remove_corruption', power: action.power as Power, regionId: action.regionId, targetPower: target });
      result = { state: s, log };
      break;
    }

    case 'dial_remove_world_token': {
      const queue = s.pendingDialRewards ?? [];
      const reward = queue[0];
      if (!reward || reward.kind !== 'remove_world_tokens') throw new Error('No remove_world_tokens reward pending');
      const region = s.regions[action.regionId]!;
      const idx = region.tokens.lastIndexOf(action.tokenType);
      if (idx === -1) throw new Error(`No removable ${action.tokenType} in ${action.regionId}`);
      s = {
        ...s,
        pendingAction: null,
        pendingDialRewards: reward.remaining <= 1
          ? popDialReward(queue)
          : [{ ...reward, remaining: reward.remaining - 1 }, ...queue.slice(1)],
      };
      const log = new GameLog();
      s = log.apply(s, { type: 'dial_remove_world_token', power: action.power as Power, regionId: action.regionId, tokenType: action.tokenType });
      result = { state: s, log };
      break;
    }

    case 'hero_removal': {
      // Find figure in powers
      let figure: import('./types.js').FollowerInstance | undefined;
      for (const p of s.activePowers) {
        figure = s.powers[p]!.followers.find(f => f.id === action.followerId && f.regionId === action.regionId);
        if (figure) break;
      }
      if (!figure) throw new Error(`Figure ${action.followerId} not in ${action.regionId}`);
      s = { ...s, pendingAction: null };
      const log = new GameLog();
      s = log.apply(s, { type: 'hero_forced_removal', power: action.power as Power, regionId: action.regionId, followerClass: figure.class, followerId: action.followerId });
      result = { state: s, log };
      break;
    }

    case 'world_card_effect':
      result = applyWorldCardEffectChoice(s, action);
      break;

    default:
      throw new Error(`Unknown action kind: ${(action as Action).kind}`);
  }

  return result;
}

/**
 * Apply a player action or advance an autonomous phase.
 * Increments actionCount on every call for RNG determinism.
 */
export function applyAction(state: GameState, action: Action): ApplyResult {
  const result = applyActionForPreview(state, action);
  return autoAdvance(result);
}

/**
 * Advance autonomous phases (world, battle start, corruption, end) that don't
 * require player input. Stops when pendingAction is set or game is complete.
 */
export function autoAdvance(result: ApplyResult): ApplyResult {
  let { state: s, log } = result;
  let lastBannerPhase: string | null = null;

  while (true) {
    // Stop if waiting for player input or game is over
    if (s.pendingAction !== null) break;
    if (s.winners !== null) break;
    if (s.phase === 'completed') break;

    // Emit a phase-change banner on fresh entry to each phase.
    // Skip for end-phase re-entries while draining dial rewards (banner was already emitted).
    // Skip for mid-battle resume (battleState exists from prior pause).
    const isEndReEntry = s.phase === 'end' && s.pendingDialRewards !== null;
    const isBattleResume = s.phase === 'battle' && s.battleState !== null;
    if (s.phase !== lastBannerPhase && !isEndReEntry && !isBattleResume) {
      s = log.apply(s, { type: 'phase_start', phase: s.phase, round: s.round });
      lastBannerPhase = s.phase;
    }

    // Check for autonomous phase transitions
    let next: { state: GameState; log: GameLog };

    switch (s.phase) {
      case 'world': {
        const victory = checkVictory(s);
        if (victory) {
          s = log.apply(s, { type: 'game_over', winners: victory.winners, condition: victory.condition });
          return { state: s, log };
        }
        next = resolveWorldPhase(s);
        break;
      }

      case 'draw':
        next = beginDrawPhase(s);
        break;

      case 'battle':
        next = resolveBattlePhase(s);
        break;

      case 'corruption':
        next = resolveCorruptionPhase(s);
        break;

      case 'end':
        next = resolveEndPhase(s);
        break;

      default:
        return { state: s, log };
    }

    log.absorb(next.log);
    s = next.state;
  }

  return { state: s, log };
}

import type { GameState, GameEvent, Power, RegionId, FollowerClass } from './types.js';
import { applyEvent } from './applyEvent.js';
import {
  CARD_BY_ID,
  FOLLOWERS,
  REGIONS,
  UPGRADE_BY_ID,
  WORLD_CARD_BY_ID,
} from './constants.js';

// ─── Display helpers ────────────────────────────────────────────────────────

function P(power: Power | string): string {
  return power.charAt(0).toUpperCase() + power.slice(1);
}

function R(regionId: RegionId | string): string {
  const def = REGIONS[regionId as RegionId];
  return def ? def.name : regionId;
}

function F(power: Power | string, cls: FollowerClass | string): string {
  const p = power as Power;
  const defs = FOLLOWERS[p];
  if (!defs) return cls;
  const def = defs[cls as FollowerClass];
  return def ? def.name : cls;
}

function tokenName(t: string): string {
  switch (t) {
    case 'peasant': return 'Peasant';
    case 'noble': return 'Noble';
    case 'hero': return 'Hero';
    case 'event': return 'Event';
    case 'chaos_stone': return 'Chaos Stone';
    case 'ratmen': return 'Ratmen';
    default: return t;
  }
}

// ─── Standalone render ──────────────────────────────────────────────────────

/** Produce a human-readable log string for any GameEvent, or null to suppress. */
export function renderText(event: GameEvent): string | null {
  switch (event.type) {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    case 'phase_start':
      return `== Round ${event.round}: ${event.phase.toUpperCase()} ==`;
    case 'round_start':
      return `Round ${event.round} begins.`;
    case 'game_over':
      return `Game over! Winners: ${event.winners.map(P).join(', ')} (${event.condition}).`;
    case 'awaiting_action':
      return null;

    // ── World ─────────────────────────────────────────────────────────────
    case 'world_card_drawn':
      return `World card drawn: ${event.cardName}`;
    case 'comet_removed':
      return `Removed comet cards from track.`;
    case 'world_card_choice':
      return `${event.cardName}: ${event.description}`;
    case 'token_supply_exhausted':
      return `${tokenName(event.tokenType)} supply exhausted.`;
    case 'token_placed':
      return null;
    case 'token_removed':
      return null;
    case 'world_track_update':
      return null;
    case 'figure_removed':
      return null;
    case 'protected_cleared':
      return null;
    case 'control_released':
      return null;
    case 'chaos_card_discarded':
      return null;
    case 'battle_cleanup':
      return null;

    // ── Draw ──────────────────────────────────────────────────────────────
    case 'tenzen_discard': {
      if (event.cardId === null) return 'Tenzen keeps hand.';
      const discardDef = CARD_BY_ID[event.cardId];
      return `Tenzen discards ${discardDef?.name ?? event.cardId}.`;
    }
    case 'power_draw':
      return `${P(event.power)} draws ${event.drawn} card(s) (hand: ${event.handSize}).`;

    // ── Summoning ─────────────────────────────────────────────────────────
    case 'summon_figure': {
      const name = F(event.power, event.followerClass);
      const fromSuffix = event.fromRegion !== null ? ` from ${R(event.fromRegion)}` : '';
      return `${P(event.power)} summons ${name} to ${R(event.toRegion)}${fromSuffix} (cost ${event.cost}).`;
    }
    case 'play_card':
      return `${P(event.power)} plays ${event.cardName} in ${R(event.toRegion)} (cost ${event.cost}).`;
    case 'summoning_pass':
      return `${P(event.power)} passes.`;
    case 'apprentice_choice':
      return event.carry
        ? `${FOLLOWERS.tenzen.cultist.name} carries Chaos Stone from ${R(event.fromRegion)} to ${R(event.toRegion)}.`
        : `${FOLLOWERS.tenzen.cultist.name} leaves Chaos Stone in ${R(event.fromRegion)}.`;
    case 'card_effect':
      return renderCardEffect(event);

    // ── Battle ─────────────────────────────────────────────────────────────
    case 'battle_region_start':
      return `Battle begins in ${R(event.regionId)}.`;
    case 'battle_roll': {
      const label = event.kind === 'war_frenzy'
        ? `${CARD_BY_ID['xarm_war_frenzy']!.name} — Xarm`
        : event.kind === 'undying_fury'
          ? `${CARD_BY_ID['xarm_bloody_rebirth']!.name} — ${P(event.power)}`
          : P(event.power);
      return `${R(event.regionId)}: ${label} rolls ${event.dice.join(',')} → ${event.hits} hit(s).`;
    }
    case 'battle_kill':
      return `${R(event.regionId)}: ${P(event.attacker)} kills ${P(event.targetPower)} ${F(event.targetPower, event.targetClass)}.`;
    case 'peasant_claimed':
      return `${R(event.regionId)}: ${P(event.power)} claims a Peasant token (${event.total} total).`;
    case 'rapture_control':
      return `${R(event.regionId)}: ${UPGRADE_BY_ID['lasha_rapture_up']!.name} — Lasha controls ${P(event.targetPower)} ${F(event.targetPower, event.targetClass)}.`;
    case 'heartrippers_corruption':
      return `${R(event.regionId)}: ${FOLLOWERS.xarm.warrior.name} place ${event.tokens} corruption token(s).`;
    case 'war_frenzy_partial':
      return `${R(event.regionId)}: ${CARD_BY_ID['xarm_war_frenzy']!.name} — ${event.hits} hit(s) applied (not killed).`;

    // ── Corruption ─────────────────────────────────────────────────────────
    case 'domination_result':
      if (event.power === null) {
        return `${R(event.regionId)}: Tied domination (${event.value}) — no conquest.`;
      }
      if (event.conquered) {
        return `${R(event.regionId)}: ${P(event.power)} dominates (${event.value} vs resistance ${event.resistance}) — scores ${event.vp} VP.`;
      }
      return `${R(event.regionId)}: ${P(event.power)} leads domination (${event.value}) but does not exceed resistance (${event.resistance}).`;
    case 'domination_failed':
      return `${R(event.regionId)}: ${P(event.power)} leads domination (${event.value}) but does not exceed resistance (${event.resistance}).`;
    case 'corruption_placement':
      return `${R(event.regionId)}: ${P(event.power)} places ${event.tokens} corruption token(s).`;
    case 'war_cry_block':
      return `${R(event.regionId)}: ${CARD_BY_ID['xarm_war_cry']!.name} — no corruption tokens placed.`;
    case 'deaths_perfume':
      return `${R(event.regionId)}: ${CARD_BY_ID['gormen_deaths_perfume']!.name} — ${event.tokens} corruption token(s) placed.`;
    case 'vile_consumption':
      return `${R(event.regionId)}: ${CARD_BY_ID['gormen_vile_consumption']!.name} — ${event.figuresRemoved} figures removed, ${event.tokensPlaced} corruption token(s) placed.`;
    case 'ruination':
      return `${R(event.regionId)}: RUINED! Ruiners score ${event.ruinerVP} VP each.`;
    case 'ruination_blocked':
      return `${R(event.regionId)}: Would be ruined but no ruination cards remain.`;
    case 'dial_counter':
      return `${R(event.regionId)}: ${P(event.power)} earns a dial advancement counter.`;
    case 'provender_score':
      return `${UPGRADE_BY_ID['gormen_provender_of_rot']!.name}: ${P(event.power)} scores ${event.vp} VP.`;

    // ── End ────────────────────────────────────────────────────────────────
    case 'narcotic_release':
      return `${CARD_BY_ID['lasha_narcotic_musk']!.name} expires: controlled figure released.`;
    case 'hero_removal':
      return `${R(event.regionId)}: Hero removes ${P(event.power)} ${F(event.power, event.followerClass)}.`;
    case 'world_card_effect':
      return renderWorldCardEffect(event);
    case 'ruination_scoring': {
      const firstNames = event.first.map(P);
      if (event.first.length > 1) {
        let msg = `${R(event.regionId)}: Ruination scoring — ${firstNames.join('/')} each score ${event.firstVP} VP (tied first).`;
        if (event.second.length > 0) {
          msg += ` ${event.second.map(P).join('/')} each score ${event.secondVP} VP (second).`;
        }
        return msg;
      }
      let msg = `${R(event.regionId)}: Ruination scoring — ${firstNames[0]} scores ${event.firstVP} VP (first).`;
      if (event.second.length > 0) {
        msg += ` ${event.second.map(P).join('/')} each score ${event.secondVP} VP (second).`;
      }
      return msg;
    }
    case 'dial_advance':
      return `${P(event.power)} advances threat dial to position ${event.position} (threat: ${event.threat}).`;
    case 'dial_vp':
      return `${P(event.power)} scores ${event.vp} VP from dial.`;
    case 'dial_victory':
      return `${P(event.power)} reaches the victory position on their threat dial!`;
    case 'card_drawn':
      return `${P(event.power)} draws a card (${event.source}).`;

    // ── Reducers ──────────────────────────────────────────────────────────
    case 'forced_discard':
      return `${P(event.power)} discards ${event.count} card(s) (Meddling of Rats).`;
    case 'upgrade_taken':
      return `${P(event.power)} takes upgrade: ${UPGRADE_BY_ID[event.upgradeCardId]?.name ?? event.upgradeCardId}.`;
    case 'dial_place_token':
      return `${P(event.power)} places ${tokenName(event.tokenType)} in ${R(event.regionId)}.`;
    case 'dial_remove_corruption':
      return `${P(event.power)} removes 1 ${P(event.targetPower)} corruption from ${R(event.regionId)}.`;
    case 'dial_remove_world_token':
      return `${P(event.power)} removes ${tokenName(event.tokenType)} from ${R(event.regionId)}.`;
    case 'hero_forced_removal':
      return `${P(event.power)} removes ${F(event.power, event.followerClass)} due to Hero token.`;
    case 'harvest_kill':
      return `${R(event.regionId)}: ${CARD_BY_ID['gormen_inevitable_rot']!.name} kills ${P(event.targetPower)} ${F(event.targetPower, event.targetClass)}.`;
  }
}

// ─── Sub-renderers ──────────────────────────────────────────────────────────

function renderCardEffect(event: Extract<GameEvent, { type: 'card_effect' }>): string {
  switch (event.subtype) {
    case 'plaguefather_corruption':
      return `${FOLLOWERS.gormen.incarnation.name} places ${event.tokens} corruption token(s) in ${R(event.regionId)}.`;
    case 'fractals_summon':
      return `${UPGRADE_BY_ID['tenzen_fractals_up']!.name}: free ${event.followerName} summoned to ${R(event.regionId)}.`;
    case 'call_to_war':
      return `${CARD_BY_ID['xarm_call_to_war']!.name}: ${P(event.power)} moves a figure from ${R(event.fromRegion)} to ${R(event.toRegion)}.`;
    case 'teleport':
      return `${CARD_BY_ID['tenzen_teleport']!.name}: ${P(event.power)} ${F(event.power, event.followerClass)} moved from ${R(event.fromRegion)} to ${R(event.toRegion)}.`;
    case 'meddling_of_rats':
      return `${CARD_BY_ID['tenzen_the_meddling_of_rats']!.name}: ${P(event.targetPower)} must discard 2 cards.`;
    case 'fate_shield':
      return `${CARD_BY_ID['tenzen_fate_shield']!.name}: a figure is protected from death this round.`;
    case 'hidden_influence':
      return `${CARD_BY_ID['lasha_hidden_influence']!.name}: ${tokenName(event.tokenType)} moved from ${R(event.fromRegion)} to ${R(event.toRegion)}.`;
    case 'narcotic_musk':
      return `${CARD_BY_ID['lasha_narcotic_musk']!.name}: Lasha controls ${P(event.power)} ${F(event.power, 'cultist')}.`;
    case 'decay':
      return `${CARD_BY_ID['gormen_decay']!.name}: removes 1 ${P(event.power)} corruption from ${R(event.regionId)}.`;
    case 'siphon_power':
      return `${CARD_BY_ID['tenzen_siphon_power']!.name}: Tenzen gains 1 PP.`;
    case 'depraved_infiltration':
      return `${CARD_BY_ID['lasha_depraved_infiltration']!.name}: 1 corruption token placed in ${R(event.regionId)}.`;
  }
}

function renderWorldCardEffect(event: Extract<GameEvent, { type: 'world_card_effect' }>): string {
  switch (event.subtype) {
    case 'normagne_heir_discard':
      return `${WORLD_CARD_BY_ID['normagne_heir']!.name}: ${P(event.power)} discards a card.`;
    case 'northern_heir':
      return `${WORLD_CARD_BY_ID['northern_heir']!.name}: ${P(event.power)} places a Hero in ${R(event.regionId)}.`;
    case 'diplomatic_envoy':
      return `${WORLD_CARD_BY_ID['diplomatic_envoy']!.name}: ${P(event.power)} removes a Hero from ${R(event.regionId)}.`;
    case 'chaos_countermeasures':
      return `${WORLD_CARD_BY_ID['chaos_countermeasures']!.name}: ${P(event.power)} places a Ratmen in ${R(event.regionId)}.`;
    case 'great_exorcism_figures':
      return `${WORLD_CARD_BY_ID['great_exorcism']!.name}: all Cultists removed from ${R(event.regionId)}.`;
    case 'great_exorcism_events':
      return `${WORLD_CARD_BY_ID['great_exorcism']!.name}: ${event.eventsMoved} Event token(s) moved to ${R(event.regionId)}.`;
    case 'central_overpopulation':
      return `${WORLD_CARD_BY_ID['central_overpopulation']!.name}: Peasant removed from ${R(event.regionId)}.`;
    case 'cleansing_wave':
      return `${WORLD_CARD_BY_ID['cleansing_wave']!.name}: all corruption removed from ${R(event.regionId)}.`;
    case 'noble_scrutiny':
      return `${WORLD_CARD_BY_ID['noble_scrutiny']!.name}: ${P(event.power)} removes 1 corruption from ${R(event.regionId)}.`;
    case 'eastern_armistice':
      return `${WORLD_CARD_BY_ID['eastern_armistice']!.name}: ${P(event.power)} removes ${F(event.power, event.followerClass)}.`;
    case 'peasant_harvest':
      return `${P(event.power)} scores ${event.vp} VP from ${WORLD_CARD_BY_ID['peasant_harvest']!.name} (${event.claimed} Peasants).`;
    case 'accelerating_doom':
      return `${WORLD_CARD_BY_ID['accelerating_doom']!.name}: drawing another World card.`;
    case 'forward_scouts_empty':
      return `${WORLD_CARD_BY_ID['forward_scouts']!.name}: no Chaos Stones on board.`;
  }
}

// ─── GameLog class ──────────────────────────────────────────────────────────

/**
 * Collects both human-readable log strings and structured game events
 * during a single engine step (applyAction -> autoAdvance).
 *
 * Primary method is `emit(event)` which stores the structured event AND
 * auto-generates the text entry via `renderText()`.
 *
 * Legacy `push(msg)` is retained for call sites not yet migrated.
 */
export class GameLog {
  readonly entries: string[] = [];
  readonly events: GameEvent[] = [];

  /** Emit a structured event: stores it and auto-generates a text entry. */
  emit(event: GameEvent): void {
    this.events.push(event);
    const text = renderText(event);
    if (text !== null) this.entries.push(text);
  }

  /** Emit an event AND apply it to state. Single codepath for state changes. */
  apply(state: GameState, event: GameEvent): GameState {
    this.emit(event);
    return applyEvent(state, event);
  }

  /** Legacy: log a plain text message without a structured event. */
  push(msg: string): void {
    this.entries.push(msg);
  }

  /** Absorb all entries and events from another GameLog. */
  absorb(other: GameLog): void {
    this.entries.push(...other.entries);
    this.events.push(...other.events);
  }
}

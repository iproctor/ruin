import type { GameEvent } from './types.js';
import {
  CARD_BY_ID,
  FOLLOWERS,
  REGIONS,
  UPGRADE_BY_ID,
  WORLD_CARD_BY_ID,
} from './constants.js';

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
      return `Game over! Winners: ${event.winners.join(', ')} (${event.condition}).`;
    case 'awaiting_action':
      return null;

    // ── World ─────────────────────────────────────────────────────────────
    case 'world_card_drawn':
      return `World card drawn: ${event.cardName}`;
    case 'comet_removed':
      return `Removed comet cards from track: ${event.cardIds.join(', ')}`;
    case 'world_card_choice':
      return `${event.cardName} choice: ${event.description}`;
    case 'token_supply_exhausted':
      return `Token supply exhausted: ${event.tokenType}`;

    // ── Draw ──────────────────────────────────────────────────────────────
    case 'tenzen_discard':
      return event.cardId !== null
        ? `Tenzen discards ${event.cardId}.`
        : 'Tenzen keeps hand.';
    case 'power_draw':
      return `${event.power} draws ${event.drawn} card(s) (hand: ${event.handSize}).`;
    case 'summoning_banner':
      return `== Round ${event.round}: SUMMONING ==`;

    // ── Summoning ─────────────────────────────────────────────────────────
    case 'summon_figure': {
      const fromSuffix = event.fromRegion !== null ? ` from ${event.fromRegion}` : '';
      return `${event.power} summons ${event.followerClass} (${event.followerId}) to ${event.toRegion}${fromSuffix} (cost ${event.cost}).`;
    }
    case 'play_card':
      return `${event.power} plays ${event.cardName} to ${event.toRegion} (cost ${event.cost}).`;
    case 'summoning_pass':
      return `${event.power} passes summoning.`;
    case 'apprentice_choice':
      return event.carry
        ? `Tenzen ${FOLLOWERS.tenzen.cultist.name} carries Chaos Stone from ${event.fromRegion} to ${event.toRegion}.`
        : `Tenzen ${FOLLOWERS.tenzen.cultist.name} leaves Chaos Stone in ${event.fromRegion}.`;
    case 'card_effect':
      return renderCardEffect(event);

    // ── Battle ─────────────────────────────────────────────────────────────
    case 'battle_region_start':
      return `Battle begins in ${REGIONS[event.regionId].name} (${event.regionId}).`;
    case 'battle_roll': {
      const label = event.kind === 'war_frenzy'
        ? `${CARD_BY_ID['xarm_war_frenzy']!.name} — Xarm`
        : event.kind === 'undying_fury'
          ? `${CARD_BY_ID['xarm_bloody_rebirth']!.name} extra battle — ${event.power}`
          : event.power;
      return `${event.regionId}: ${label} rolls ${event.dice.join(',')} → ${event.hits} hit(s).`;
    }
    case 'battle_kill':
      return `${event.regionId}: ${event.attacker} kills ${event.targetPower} ${event.targetClass} (${event.targetId}).`;
    case 'peasant_claimed':
      return `${event.regionId}: ${event.power} claims a Peasant token (${event.total} total).`;
    case 'rapture_control':
      return `${event.regionId}: ${UPGRADE_BY_ID['lasha_rapture_up']!.name} — Lasha controls ${event.targetPower} ${event.targetClass} (${event.targetId}).`;
    case 'heartrippers_corruption':
      return `${event.regionId}: Xarm ${FOLLOWERS.xarm.warrior.name} place ${event.tokens} corruption token.`;
    case 'war_frenzy_partial':
      return `${event.regionId}: ${CARD_BY_ID['xarm_war_frenzy']!.name} — ${event.hits} hit(s) applied to ${event.followerId} (not killed).`;

    // ── Corruption ─────────────────────────────────────────────────────────
    case 'domination_result':
      if (event.power === null) {
        return `${event.regionId}: Tied domination (${event.value}) — no conquest.`;
      }
      if (event.conquered) {
        return `${event.regionId}: ${event.power} dominates (${event.value} vs resistance ${event.resistance}) — scores ${event.vp} VP.`;
      }
      return `${event.regionId}: ${event.power} has highest domination (${event.value}) but does not exceed resistance (${event.resistance}).`;
    case 'domination_failed':
      return `${event.regionId}: ${event.power} has highest domination (${event.value}) but does not exceed resistance (${event.resistance}).`;
    case 'corruption_placement':
      return `${event.regionId}: ${event.power} places ${event.tokens} corruption token(s).`;
    case 'war_cry_block':
      return `${event.regionId}: ${CARD_BY_ID['xarm_war_cry']!.name} — no corruption tokens placed.`;
    case 'deaths_perfume':
      return `${event.regionId}: Gormen ${CARD_BY_ID['gormen_deaths_perfume']!.name} — ${event.tokens} corruption tokens placed.`;
    case 'vile_consumption':
      return `${event.regionId}: ${CARD_BY_ID['gormen_vile_consumption']!.name} — ${event.figuresRemoved} Gormen figures removed, ${event.tokensPlaced} corruption token(s) placed.`;
    case 'ruination':
      return `${event.regionId}: RUINED (card ${event.cardIndex}). Ruiners score ${event.ruinerVP} VP each.`;
    case 'ruination_blocked':
      return `${event.regionId}: Would be ruined but no ruination cards remain.`;
    case 'dial_counter':
      return `${event.regionId}: ${event.power} earns a dial advancement counter.`;
    case 'provender_score':
      return `Gormen ${UPGRADE_BY_ID['gormen_provender_of_rot']!.name}: ${event.power} scores ${event.vp} VP.`;

    // ── End ────────────────────────────────────────────────────────────────
    case 'narcotic_release':
      return `${CARD_BY_ID['lasha_narcotic_musk']!.name} discarded: ${event.power} ${event.followerId} released.`;
    case 'hero_removal':
      return `${event.regionId}: Hero token — ${event.power} removes ${event.followerClass} (${event.followerId}).`;
    case 'world_card_effect':
      return renderWorldCardEffect(event);
    case 'ruination_scoring': {
      if (event.first.length > 1) {
        const shared = event.firstVP;
        let msg = `${event.regionId}: Ruination scoring — ${event.first.join('/')} each score ${shared} VP (tied first).`;
        if (event.second.length > 0) {
          msg += ` ${event.second.join('/')} each score ${event.secondVP} VP (second).`;
        }
        return msg;
      }
      let msg = `${event.regionId}: Ruination scoring — ${event.first[0]} scores ${event.firstVP} VP (first).`;
      if (event.second.length > 0) {
        msg += ` ${event.second.join('/')} each score ${event.secondVP} VP (second).`;
      }
      return msg;
    }
    case 'dial_advance':
      return `${event.power} advances threat dial to position ${event.position} (threat: ${event.threat}).`;
    case 'dial_vp':
      return `${event.power} scores ${event.vp} VP from dial.`;
    case 'dial_victory':
      return `${event.power} reaches the victory position on their threat dial!`;
    case 'card_drawn':
      return `${event.power} draws a card (${event.source}).`;

    // ── Reducers ──────────────────────────────────────────────────────────
    case 'forced_discard':
      return `${event.power} discards ${event.count} card(s) (Meddling of Rats).`;
    case 'upgrade_taken':
      return `${event.power} takes upgrade: ${event.upgradeCardId}.`;
    case 'dial_place_token':
      return `${event.power} (dial) places ${event.tokenType} on ${event.regionId}.`;
    case 'dial_remove_corruption':
      return `${event.power} (dial) removes 1 ${event.targetPower} corruption from ${event.regionId}.`;
    case 'dial_remove_world_token':
      return `${event.power} (dial) removes ${event.tokenType} from ${event.regionId}.`;
    case 'hero_forced_removal':
      return `${event.power} removes ${event.followerClass} (${event.followerId}) due to Hero token.`;
    case 'harvest_kill':
      return `${event.regionId}: ${CARD_BY_ID['gormen_inevitable_rot']!.name} kills ${event.targetPower} ${event.targetClass} (${event.followerId}).`;
  }
}

// ─── Sub-renderers ──────────────────────────────────────────────────────────

function renderCardEffect(event: Extract<GameEvent, { type: 'card_effect' }>): string {
  switch (event.subtype) {
    case 'plaguefather_corruption':
      return `Gormen ${FOLLOWERS.gormen.incarnation.name} places ${event.tokens} corruption tokens in ${event.regionId}.`;
    case 'fractals_summon':
      return `Tenzen ${UPGRADE_BY_ID['tenzen_fractals_up']!.name}: free ${event.followerName} summoned to ${event.regionId}.`;
    case 'call_to_war':
      return `${CARD_BY_ID['xarm_call_to_war']!.name}: ${event.power} moves ${event.followerId} from ${event.fromRegion} to ${event.toRegion}.`;
    case 'teleport':
      return `${CARD_BY_ID['tenzen_teleport']!.name}: ${event.power} ${event.followerClass} moved from ${event.fromRegion} to ${event.toRegion}.`;
    case 'meddling_of_rats':
      return `${CARD_BY_ID['tenzen_the_meddling_of_rats']!.name}: ${event.targetPower} must discard 2 cards on their next turn.`;
    case 'fate_shield':
      return `${CARD_BY_ID['tenzen_fate_shield']!.name}: ${event.followerId} is protected from death this round.`;
    case 'hidden_influence':
      return `${CARD_BY_ID['lasha_hidden_influence']!.name}: ${event.tokenType} moved from ${event.fromRegion} to ${event.toRegion}.`;
    case 'narcotic_musk':
      return `${CARD_BY_ID['lasha_narcotic_musk']!.name}: Lasha controls ${event.power} cultist ${event.followerId}.`;
    case 'decay':
      return `Gormen ${CARD_BY_ID['gormen_decay']!.name} removes 1 ${event.power} corruption token from ${event.regionId}.`;
    case 'siphon_power':
      return `Tenzen ${CARD_BY_ID['tenzen_siphon_power']!.name}: gained 1 PP.`;
    case 'depraved_infiltration':
      return `Lasha ${CARD_BY_ID['lasha_depraved_infiltration']!.name}: 1 corruption token placed in ${event.regionId} (no dial trigger).`;
  }
}

function renderWorldCardEffect(event: Extract<GameEvent, { type: 'world_card_effect' }>): string {
  switch (event.subtype) {
    case 'normagne_heir_discard':
      return `${WORLD_CARD_BY_ID['normagne_heir']!.name}: ${event.power} discards ${event.cardId}.`;
    case 'northern_heir':
      return `${WORLD_CARD_BY_ID['northern_heir']!.name}: ${event.power} places a Noble on ${event.regionId}.`;
    case 'diplomatic_envoy':
      return `${WORLD_CARD_BY_ID['diplomatic_envoy']!.name}: ${event.power} removes a Noble from ${event.regionId}.`;
    case 'chaos_countermeasures':
      return `${WORLD_CARD_BY_ID['chaos_countermeasures']!.name}: ${event.power} places a Hero on ${event.regionId}.`;
    case 'great_exorcism_figures':
      return `${WORLD_CARD_BY_ID['great_exorcism']!.name}: removed all figures from ${event.regionId}.`;
    case 'great_exorcism_events':
      return `${WORLD_CARD_BY_ID['great_exorcism']!.name}: moved ${event.eventsMoved} Event token(s) to ${event.regionId}.`;
    case 'central_overpopulation':
      return `${WORLD_CARD_BY_ID['central_overpopulation']!.name}: Peasant removed from ${event.regionId}.`;
    case 'cleansing_wave':
      return `${WORLD_CARD_BY_ID['cleansing_wave']!.name}: all corruption tokens removed from ${event.regionId}.`;
    case 'noble_scrutiny':
      return `${WORLD_CARD_BY_ID['noble_scrutiny']!.name}: ${event.power} removes 1 corruption token from ${event.regionId}.`;
    case 'eastern_armistice':
      return `${WORLD_CARD_BY_ID['eastern_armistice']!.name}: ${event.power} removes ${event.followerClass} (${event.followerId}).`;
    case 'peasant_harvest':
      return event.vp > 0
        ? `${event.power} scores ${event.vp} VP from ${WORLD_CARD_BY_ID['peasant_harvest']!.name} (${event.claimed} claimed Peasants).`
        : `${event.power} scores 0 VP from ${WORLD_CARD_BY_ID['peasant_harvest']!.name} (${event.claimed} claimed Peasants).`;
    case 'accelerating_doom':
      return `${WORLD_CARD_BY_ID['accelerating_doom']!.name}: drawing another World card.`;
    case 'forward_scouts_empty':
      return `${WORLD_CARD_BY_ID['forward_scouts']!.name}: no Chaos Stone tokens on board. No effect.`;
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

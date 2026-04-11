import type { GameEvent, GameState, RegionId, TokenType, WorldChoiceAction } from '../types.js';
import { WORLD_CARD_BY_ID, ADJACENCY, REGION_ORDER, REGIONS } from '../constants.js';
import { GameLog } from '../gameLog.js';
import {
  lowestThreatPower, addTokenToRegion, removeTokenFromRegion,
  isWorldCardActive, updateRegion, updatePower, scoreVP,
} from '../helpers.js';

/**
 * Returns the valid region options for a world card's regionId choice.
 * Used by the client to filter the region picker.
 */
export function getWorldChoiceRegions(state: GameState, cardId: string): RegionId[] {
  const notRuined = REGION_ORDER.filter(r => state.regions[r]!.ruinationCardIndex === null);

  switch (cardId) {
    case 'purchased_title':
      return notRuined.filter(r => state.regions[r]!.tokens.includes('peasant'));

    case 'normagne_heir':
      // Noble already placed on Normagne; choose any other region
      return notRuined.filter(r => r !== 'normagne');

    case 'mittelreich_diplomacy':
      // Event already placed on Mittelreich; choose any other region
      return notRuined.filter(r => r !== 'mittelreich');

    case 'cleansing_wave':
      // Event already placed on Normagne; choose an adjacent region
      return (ADJACENCY['normagne'] ?? []).filter(r => state.regions[r]?.ruinationCardIndex === null) as RegionId[];

    case 'forward_scouts':
      // Region with chaos_stone, or adjacent to one
      return notRuined.filter(r =>
        state.regions[r]!.tokens.includes('chaos_stone') ||
        (ADJACENCY[r] ?? []).some(adj => state.regions[adj]!.tokens.includes('chaos_stone'))
      );

    case 'northern_heir':
      // Persistent effect: Noble on region that already has a Noble
      return notRuined.filter(r => state.regions[r]!.tokens.includes('noble'));

    default:
      // the_exodus, the_exchange, diplomatic_envoy (first pick), etc. — any non-ruined region
      return notRuined;
  }
}

/** Draw the next world card and apply its immediate effects.
 *  If the card requires a player choice, sets pendingAction and returns early.
 *  Otherwise, fully resolves and advances to the draw phase. */
export function resolveWorldPhase(state: GameState): { state: GameState; log: GameLog } {
  const log = new GameLog();
  // Clear previous round's discard card
  let s: GameState = { ...state, worldTrack: { ...state.worldTrack, discardCard: null } };

  if (s.worldDeck.length === 0) {
    // Deck exhausted — end condition handled by victory checker
    return { state: { ...s, phase: 'draw' }, log };
  }

  const [cardId, ...remaining] = s.worldDeck;
  s = { ...s, worldDeck: remaining };
  log.emit({ type: 'world_card_drawn', cardId: cardId!, cardName: WORLD_CARD_BY_ID[cardId!]?.name ?? cardId! });

  const cardDef = WORLD_CARD_BY_ID[cardId!];
  if (!cardDef) return { state: s, log };

  // Remove comet-icon cards from track first
  if (cardDef.hasCometIcon) {
    const { slot1, slot2 } = s.worldTrack;
    let removed: string[] = [];
    if (slot1 && WORLD_CARD_BY_ID[slot1]?.hasCometIcon) {
      removed.push(slot1);
      s = { ...s, worldTrack: { ...s.worldTrack, slot1: null } };
    }
    if (slot2 && WORLD_CARD_BY_ID[slot2]?.hasCometIcon) {
      removed.push(slot2);
      s = { ...s, worldTrack: { ...s.worldTrack, slot2: null } };
    }
    if (removed.length) log.emit({ type: 'comet_removed', cardIds: removed });
  }

  // Apply immediate effects (non-choice ones first)
  const result = applyWorldCardImmediate(s, cardId!, log);
  s = result.state;

  if (result.needsChoice) {
    // Verify there are actually valid choices (regions may all be ruined).
    // If not, skip the choice and auto-resolve.
    const choiceRegions = getWorldChoiceRegions(s, cardId!);
    const isPairCard = cardId === 'northern_heir' || cardId === 'heroes_of_order';
    if (!isPairCard && choiceRegions.length === 0) {
      // No valid regions — skip choice, place card and move on
      s = placeOnTrackOrDiscard(s, cardId!);
      s = advanceToDrawPhase(s);
      return { state: s, log };
    }

    // Set pendingAction and wait — caller must submit a WorldChoiceAction
    const choicePower = lowestThreatPower(s);
    s = {
      ...s,
      pendingAction: {
        waitingFor: choicePower,
        actionKind: 'world_choice',
        context: { cardId },
      },
    };
    log.emit({ type: 'awaiting_action', power: choicePower, actionKind: 'world_choice', context: { cardId }, description: `${choicePower} must make a world card choice.` });
    return { state: s, log };
  }

  // Place card on track (or discard)
  s = placeOnTrackOrDiscard(s, cardId!);
  s = advanceToDrawPhase(s);
  return { state: s, log };
}

/** Apply a world choice action and continue. */
export function applyWorldChoice(state: GameState, action: WorldChoiceAction): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };
  const { cardId, choices } = action;

  const result = applyWorldCardChoice(s, cardId, choices, log);
  s = result.state;

  s = placeOnTrackOrDiscard(s, cardId);
  s = advanceToDrawPhase(s);
  return { state: s, log };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function placeOnTrackOrDiscard(state: GameState, cardId: string): GameState {
  const def = WORLD_CARD_BY_ID[cardId];
  if (!def || def.timing === 'discard') {
    return { ...state, worldTrack: { ...state.worldTrack, discardCard: cardId } };
  }

  // Shift slot1 → slot2, new card → slot1
  return {
    ...state,
    worldTrack: { ...state.worldTrack, slot1: cardId, slot2: state.worldTrack.slot1 },
  };
}

function advanceToDrawPhase(state: GameState): GameState {
  return { ...state, phase: 'draw', pendingAction: null };
}

/** Apply the deterministic part of a card's immediate effect.
 *  Returns needsChoice=true if a player decision is required. */
function applyWorldCardImmediate(
  state: GameState,
  cardId: string,
  log: GameLog,
): { state: GameState; needsChoice: boolean } {
  let s = state;

  switch (cardId) {
    case 'eastern_armistice': {
      // Place Event on Almerida, Normagne, Norrsund
      for (const r of ['almerida', 'normagne', 'norrsund'] as RegionId[]) {
        s = addTokenIfAvailable(s, r, 'event', log);
      }
      return { state: s, needsChoice: false };
    }

    case 'purchased_title': {
      // Find first Peasant on board and replace with Noble (no player choice for auto)
      // If multiple Peasants: lowest-threat player chooses — set needsChoice
      const peasantRegions = REGION_ORDER.filter(r => s.regions[r]!.tokens.includes('peasant'));
      if (peasantRegions.length === 0) return { state: s, needsChoice: false };
      if (peasantRegions.length === 1) {
        s = removeTokenFromRegion(s, peasantRegions[0]!, 'peasant');
        s = { ...s, tokenSupply: { ...s.tokenSupply, peasant: s.tokenSupply.peasant + 1 } };
        s = addTokenIfAvailable(s, peasantRegions[0]!, 'noble', log);
        return { state: s, needsChoice: false };
      }
      return { state: s, needsChoice: true };
    }

    case 'ratmen_incursion': {
      // Place Ratmen on 2 regions — lowest threat player chooses
      return { state: s, needsChoice: true };
    }

    case 'peasant_prosperity': {
      return { state: s, needsChoice: true }; // choose 2 regions for Peasant
    }

    case 'chaos_storm': {
      return { state: s, needsChoice: true }; // choose 2 regions for Chaos Stone
    }

    case 'grand_muster': {
      return { state: s, needsChoice: true }; // choose regions for all three token types
    }

    case 'accelerating_doom': {
      // Draw another card immediately — caller handles this by re-running resolveWorldPhase
      log.emit({ type: 'world_card_effect', subtype: 'accelerating_doom' });
      s = { ...s, phase: 'world' };
      return { state: s, needsChoice: false };
    }

    case 'raise_the_militia': {
      // Place Peasant on every region except The Barrens
      for (const r of REGION_ORDER.filter(id => id !== 'the_barrens')) {
        s = addTokenIfAvailable(s, r, 'peasant', log);
      }
      return { state: s, needsChoice: false };
    }

    case 'peasant_harvest': {
      // Score 1 VP per claimed Peasant; +3 VP for most
      let maxClaimed = 0;
      for (const p of s.activePowers) {
        maxClaimed = Math.max(maxClaimed, s.powers[p]!.claimedPeasants);
      }
      for (const p of s.activePowers) {
        const claimed = s.powers[p]!.claimedPeasants;
        let vp = claimed;
        if (claimed === maxClaimed && maxClaimed > 0) vp += 3;
        s = scoreVP(s, p, vp);
        if (vp > 0) log.emit({ type: 'world_card_effect', subtype: 'peasant_harvest', power: p, vp, claimed });
      }
      return { state: s, needsChoice: false };
    }

    case 'diplomatic_envoy': {
      // Place Noble on 3 different regions — choice required
      return { state: s, needsChoice: true };
    }

    case 'normagne_heir': {
      // Noble on Normagne + one other region
      s = addTokenIfAvailable(s, 'normagne', 'noble', log);
      return { state: s, needsChoice: true }; // choose the second region
    }

    case 'northern_heir': {
      // Noble on (Norrsund+Volensk) OR (Talvimaa+Mittelreich) — choice required
      return { state: s, needsChoice: true };
    }

    case 'mittelreich_diplomacy': {
      // Event on Mittelreich + one other — choice required
      s = addTokenIfAvailable(s, 'mittelreich', 'event', log);
      return { state: s, needsChoice: true };
    }

    case 'the_chokepoint': {
      for (const r of ['the_barrens', 'mittelreich', 'toscavar'] as RegionId[]) {
        s = addTokenIfAvailable(s, r, 'event', log);
      }
      return { state: s, needsChoice: false };
    }

    case 'central_overpopulation': {
      for (const r of ['normagne', 'mittelreich', 'toscavar'] as RegionId[]) {
        s = addTokenIfAvailable(s, r, 'event', log);
      }
      for (const r of REGION_ORDER) {
        s = addTokenIfAvailable(s, r, 'peasant', log);
      }
      return { state: s, needsChoice: false };
    }

    case 'great_exorcism': {
      return { state: s, needsChoice: true }; // choose which region gets Event token
    }

    case 'heroes_of_order': {
      return { state: s, needsChoice: true }; // choose pair: (Normagne+Mittelreich) or (Almerida+Toscavar)
    }

    case 'cleansing_wave': {
      // Event on Normagne + adjacent region — Normagne is fixed, adjacent choice needed
      s = addTokenIfAvailable(s, 'normagne', 'event', log);
      return { state: s, needsChoice: true };
    }

    case 'chaos_countermeasures': {
      for (const r of ['the_barrens', 'pelascos'] as RegionId[]) {
        s = addTokenIfAvailable(s, r, 'hero', log);
      }
      return { state: s, needsChoice: false };
    }

    case 'forward_scouts': {
      // Place Hero on a region (or adjacent) with Chaos Stone — auto-pick first match or choice
      const eligible = REGION_ORDER.filter(r =>
        s.regions[r]!.tokens.includes('chaos_stone') ||
        (ADJACENCY[r] ?? []).some(adj => s.regions[adj]!.tokens.includes('chaos_stone'))
      );
      if (eligible.length === 0) {
        log.emit({ type: 'world_card_effect', subtype: 'forward_scouts_empty' });
        return { state: s, needsChoice: false };
      }
      return { state: s, needsChoice: true };
    }

    case 'the_exchange': {
      return { state: s, needsChoice: true }; // choose region for 2 Chaos Stones
    }

    case 'noble_scrutiny': {
      for (const r of ['normagne', 'mittelreich', 'almerida'] as RegionId[]) {
        s = addTokenIfAvailable(s, r, 'noble', log);
      }
      return { state: s, needsChoice: false };
    }

    case 'kashnir_arms': // alias — same as noble_scrutiny placement
      return { state: s, needsChoice: false };

    default:
      return { state: s, needsChoice: false };
  }
}

/** Apply the player's choice for a world card immediate effect. */
function applyWorldCardChoice(
  state: GameState,
  cardId: string,
  choices: Record<string, unknown>,
  log: GameLog,
): { state: GameState } {
  let s = state;

  const cardName = WORLD_CARD_BY_ID[cardId]?.name ?? cardId;
  const rname = (r: RegionId) => REGIONS[r]?.name ?? r;
  const rlist = (rs: (RegionId | undefined)[]) => rs.filter(Boolean).map(r => rname(r as RegionId)).join(', ');
  const logChoice = (desc: string) => log.emit({ type: 'world_card_choice', cardId, cardName, description: desc });

  switch (cardId) {
    case 'purchased_title': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`replace Peasant with Noble in ${rname(regionId)}`);
      s = removeTokenFromRegion(s, regionId, 'peasant');
      s = { ...s, tokenSupply: { ...s.tokenSupply, peasant: s.tokenSupply.peasant + 1 } };
      s = addTokenIfAvailable(s, regionId, 'noble', log);
      break;
    }
    case 'ratmen_incursion': {
      const [r1, r2] = choices['regions'] as RegionId[];
      logChoice(`Ratmen → ${rlist([r1, r2])}`);
      if (r1) s = addTokenIfAvailable(s, r1, 'ratmen', log);
      if (r2) s = addTokenIfAvailable(s, r2, 'ratmen', log);
      break;
    }
    case 'peasant_prosperity': {
      const [r1, r2] = choices['regions'] as RegionId[];
      logChoice(`Peasants → ${rlist([r1, r2])}`);
      if (r1) s = addTokenIfAvailable(s, r1, 'peasant', log);
      if (r2) s = addTokenIfAvailable(s, r2, 'peasant', log);
      break;
    }
    case 'chaos_storm': {
      const [r1, r2] = choices['regions'] as RegionId[];
      logChoice(`Chaos Stones → ${rlist([r1, r2])}`);
      if (r1) s = addTokenIfAvailable(s, r1, 'chaos_stone', log);
      if (r2) s = addTokenIfAvailable(s, r2, 'chaos_stone', log);
      break;
    }
    case 'grand_muster': {
      const { peasantRegions, nobleRegions, ratmenRegions } = choices as Record<string, RegionId[]>;
      const parts: string[] = [];
      if (peasantRegions?.length) parts.push(`Peasants → ${rlist(peasantRegions)}`);
      if (nobleRegions?.length)   parts.push(`Nobles → ${rlist(nobleRegions)}`);
      if (ratmenRegions?.length)  parts.push(`Ratmen → ${rlist(ratmenRegions)}`);
      logChoice(parts.join('; '));
      for (const r of peasantRegions ?? []) s = addTokenIfAvailable(s, r, 'peasant', log);
      for (const r of nobleRegions ?? []) s = addTokenIfAvailable(s, r, 'noble', log);
      for (const r of ratmenRegions ?? []) s = addTokenIfAvailable(s, r, 'ratmen', log);
      break;
    }
    case 'normagne_heir': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`Noble → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'noble', log);
      break;
    }
    case 'northern_heir': {
      const pair = choices['pair'] as 'ab' | 'cd';
      const regions: RegionId[] = pair === 'ab' ? ['norrsund', 'volensk'] : ['talvimaa', 'mittelreich'];
      logChoice(`Nobles → ${rlist(regions)}`);
      for (const r of regions) s = addTokenIfAvailable(s, r, 'noble', log);
      break;
    }
    case 'mittelreich_diplomacy': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`Event → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'event', log);
      break;
    }
    case 'great_exorcism': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`Event → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'event', log);
      break;
    }
    case 'heroes_of_order': {
      const pair = choices['pair'] as 'ab' | 'cd';
      const regions: RegionId[] = pair === 'ab' ? ['normagne', 'mittelreich'] : ['almerida', 'toscavar'];
      logChoice(`Heroes → ${rlist(regions)}`);
      for (const r of regions) s = addTokenIfAvailable(s, r, 'hero', log);
      break;
    }
    case 'cleansing_wave': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`Event → ${rname(regionId)} (adjacent to Normagne)`);
      s = addTokenIfAvailable(s, regionId, 'event', log);
      break;
    }
    case 'forward_scouts': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`Hero → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'hero', log);
      break;
    }
    case 'the_exchange': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`2× Chaos Stone → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'chaos_stone', log);
      s = addTokenIfAvailable(s, regionId, 'chaos_stone', log);
      break;
    }
    case 'diplomatic_envoy': {
      const regions = choices['regions'] as RegionId[];
      logChoice(`Nobles → ${rlist(regions)}`);
      for (const r of regions) s = addTokenIfAvailable(s, r, 'noble', log);
      break;
    }
  }

  return { state: s };
}

function addTokenIfAvailable(state: GameState, regionId: RegionId, token: TokenType, log: GameLog): GameState {
  if (state.tokenSupply[token] <= 0) {
    log.emit({ type: 'token_supply_exhausted', tokenType: token });
    return state;
  }
  const s = addTokenToRegion(state, regionId, token);
  return { ...s, tokenSupply: { ...s.tokenSupply, [token]: s.tokenSupply[token] - 1 } };
}

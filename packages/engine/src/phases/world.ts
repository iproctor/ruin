import type { GameState, RegionId, TokenType, WorldChoiceAction, CompanionWorldPickAction, Power } from '../types.js';
import { WORLD_CARD_BY_ID, ADJACENCY, REGION_ORDER, REGIONS } from '../constants.js';
import { GameLog } from '../gameLog.js';
import {
  lowestThreatPower,
} from '../helpers.js';

/**
 * Returns the valid region options for a world card's regionId choice.
 * Used by the client to filter the region picker.
 */
export function getWorldChoiceRegions(state: GameState, cardId: string): RegionId[] {
  const notRuined = REGION_ORDER.filter(r => state.regions[r]!.ruinationCardIndex === null);

  switch (cardId) {
    case 'normagne_heir':
      // Hero already placed on Normagne; choose any other region
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
      // Persistent effect placement: Hero on a region that already has a Hero
      return notRuined;

    case 'diplomatic_envoy':
      // 3 different Populous regions
      return notRuined.filter(r => REGIONS[r].populous);

    default:
      // great_exorcism, the_exchange, etc. — any non-ruined region
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

  // Solo companion mode: let the human reveal the card from their physical deck.
  // Pause until they submit a `companion_world_pick` action with the card id.
  const picker = pickCompanionChooser(s);
  if (picker !== null) {
    s = {
      ...s,
      pendingAction: {
        waitingFor: picker,
        actionKind: 'companion_world_pick',
        context: {},
      },
    };
    log.emit({ type: 'awaiting_action', power: picker, actionKind: 'companion_world_pick', context: {}, description: `${picker} must reveal the next World card from the physical deck.` });
    return { state: s, log };
  }

  const [cardId, ...remaining] = s.worldDeck;
  s = { ...s, worldDeck: remaining };
  log.emit({ type: 'world_card_drawn', cardId: cardId!, cardName: WORLD_CARD_BY_ID[cardId!]?.name ?? cardId! });

  const cardDef = WORLD_CARD_BY_ID[cardId!];
  if (!cardDef) return { state: s, log };

  // Remove comet-icon cards (and their Event tokens) from track first
  if (cardDef.hasCometIcon) {
    s = clearOldCometCards(s, log);
  }

  // Apply immediate effects (non-choice ones first)
  const result = applyWorldCardImmediate(s, cardId!, log);
  s = result.state;

  if (result.needsChoice) {
    // Verify there are actually valid choices (regions may all be ruined).
    // If not, skip the choice and auto-resolve.
    const choiceRegions = getWorldChoiceRegions(s, cardId!);
    const isPairCard = cardId === 'northern_heir' || cardId === 'ratmens_price';
    if (!isPairCard && choiceRegions.length === 0) {
      // No valid regions — skip choice, place card and move on
      s = placeOnTrackOrDiscard(s, cardId!, log);
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
  s = placeOnTrackOrDiscard(s, cardId!, log);
  s = advanceToDrawPhase(s);
  return { state: s, log };
}

/** Pick the human power who reveals the next world card, or null if the
 *  companion option is off / no human is active. Uses the first human in
 *  turn order so the choice is deterministic across resumes. */
function pickCompanionChooser(state: GameState): Power | null {
  if (!state.companionOptions?.humanChoosesCard) return null;
  for (const p of state.activePowers) {
    if (state.powers[p]?.playerType === 'human') return p;
  }
  return null;
}

/** Apply a companion-mode world card pick: the human read a card from their
 *  physical deck and reported its id. Continue as if the engine drew it. */
export function applyCompanionWorldPick(
  state: GameState,
  action: CompanionWorldPickAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  const cardDef = WORLD_CARD_BY_ID[action.cardId];
  if (!cardDef) throw new Error(`Unknown world card: ${action.cardId}`);

  // Advance the digital deck by one so game-length tracking still ticks down.
  const remaining = state.worldDeck.slice(1);
  let s: GameState = { ...state, pendingAction: null, worldDeck: remaining };
  const cardId = action.cardId;
  log.emit({ type: 'world_card_drawn', cardId, cardName: cardDef.name });

  // Remove comet-icon cards (and their Event tokens) from track first
  if (cardDef.hasCometIcon) {
    s = clearOldCometCards(s, log);
  }

  const result = applyWorldCardImmediate(s, cardId, log);
  s = result.state;

  if (result.needsChoice) {
    const choiceRegions = getWorldChoiceRegions(s, cardId);
    const isPairCard = cardId === 'northern_heir' || cardId === 'ratmens_price';
    if (!isPairCard && choiceRegions.length === 0) {
      s = placeOnTrackOrDiscard(s, cardId, log);
      s = advanceToDrawPhase(s);
      return { state: s, log };
    }
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

  s = placeOnTrackOrDiscard(s, cardId, log);
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

  s = placeOnTrackOrDiscard(s, cardId, log);
  s = advanceToDrawPhase(s);
  return { state: s, log };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Remove any existing comet-icon cards from the world track, along with the
 *  Event tokens they placed on the map. Event tokens are only ever placed by
 *  comet cards, so clearing every Event on the board is correct. */
function clearOldCometCards(state: GameState, log: GameLog): GameState {
  let s = state;
  const { slot1, slot2 } = s.worldTrack;
  const removed: string[] = [];
  if (slot1 && WORLD_CARD_BY_ID[slot1]?.hasCometIcon) {
    removed.push(slot1);
    s = { ...s, worldTrack: { ...s.worldTrack, slot1: null } };
  }
  if (slot2 && WORLD_CARD_BY_ID[slot2]?.hasCometIcon) {
    removed.push(slot2);
    s = { ...s, worldTrack: { ...s.worldTrack, slot2: null } };
  }
  if (removed.length === 0) return s;

  log.emit({ type: 'comet_removed', cardIds: removed });
  for (const regionId of REGION_ORDER) {
    const count = s.regions[regionId]!.tokens.filter(t => t === 'event').length;
    for (let i = 0; i < count; i++) {
      s = log.apply(s, { type: 'token_removed', regionId, tokenType: 'event' });
    }
  }
  return s;
}

function placeOnTrackOrDiscard(state: GameState, cardId: string, log: GameLog): GameState {
  const def = WORLD_CARD_BY_ID[cardId];
  if (!def || def.timing === 'discard') {
    return { ...state, worldTrack: { ...state.worldTrack, discardCard: cardId } };
  }

  // Shift slot1 → slot2, new card → slot1
  const newTrack = { slot1: cardId, slot2: state.worldTrack.slot1, discardCard: state.worldTrack.discardCard };
  const s = log.apply(state, { type: 'world_track_update', slot1: newTrack.slot1, slot2: newTrack.slot2 });
  return s;
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

    case 'chaos_storm': {
      return { state: s, needsChoice: true }; // choose 3 regions for Chaos Stone
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
        if (vp > 0) {
          s = log.apply(s, { type: 'world_card_effect', subtype: 'peasant_harvest', power: p, vp, claimed });
        }
      }
      return { state: s, needsChoice: false };
    }

    case 'diplomatic_envoy': {
      // Place Noble on 3 different regions — choice required
      return { state: s, needsChoice: true };
    }

    case 'normagne_heir': {
      // Hero on Normagne + one other region
      s = addTokenIfAvailable(s, 'normagne', 'hero', log);
      return { state: s, needsChoice: true }; // choose the second region
    }

    case 'northern_heir': {
      // Hero on (Norrsund+Volensk) OR (Talvimaa+Mittelreich) — choice required
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

    case 'ratmens_price': {
      return { state: s, needsChoice: true }; // choose pair: (Normagne+Mittelreich) or (Almerida+Toscavar)
    }

    case 'cleansing_wave': {
      // Event on Normagne + adjacent region — Normagne is fixed, adjacent choice needed
      s = addTokenIfAvailable(s, 'normagne', 'event', log);
      return { state: s, needsChoice: true };
    }

    case 'chaos_countermeasures': {
      for (const r of ['the_barrens', 'pelascos'] as RegionId[]) {
        s = addTokenIfAvailable(s, r, 'ratmen', log);
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
        s = addTokenIfAvailable(s, r, 'hero', log);
      }
      return { state: s, needsChoice: false };
    }

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
    case 'chaos_storm': {
      const regs = (choices['regions'] as RegionId[]) ?? [];
      logChoice(`Chaos Stones → ${rlist(regs)}`);
      for (const r of regs) if (r) s = addTokenIfAvailable(s, r, 'chaos_stone', log);
      break;
    }
    case 'grand_muster': {
      const { peasantRegions, heroRegions, nobleRegions } = choices as Record<string, RegionId[]>;
      const parts: string[] = [];
      if (peasantRegions?.length) parts.push(`Peasants → ${rlist(peasantRegions)}`);
      if (heroRegions?.length)    parts.push(`Heroes → ${rlist(heroRegions)}`);
      if (nobleRegions?.length)   parts.push(`Nobles → ${rlist(nobleRegions)}`);
      logChoice(parts.join('; '));
      for (const r of peasantRegions ?? []) s = addTokenIfAvailable(s, r, 'peasant', log);
      for (const r of heroRegions ?? []) s = addTokenIfAvailable(s, r, 'hero', log);
      for (const r of nobleRegions ?? []) s = addTokenIfAvailable(s, r, 'noble', log);
      break;
    }
    case 'normagne_heir': {
      const regionId = choices['regionId'] as RegionId;
      logChoice(`Hero → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'hero', log);
      break;
    }
    case 'northern_heir': {
      const pair = choices['pair'] as 'ab' | 'cd';
      const regions: RegionId[] = pair === 'ab' ? ['norrsund', 'volensk'] : ['talvimaa', 'mittelreich'];
      logChoice(`Heroes → ${rlist(regions)}`);
      for (const r of regions) s = addTokenIfAvailable(s, r, 'hero', log);
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
    case 'ratmens_price': {
      const pair = choices['pair'] as 'ab' | 'cd';
      const regions: RegionId[] = pair === 'ab' ? ['normagne', 'mittelreich'] : ['almerida', 'toscavar'];
      logChoice(`Ratmen → ${rlist(regions)}`);
      for (const r of regions) s = addTokenIfAvailable(s, r, 'ratmen', log);
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
      logChoice(`Ratmen → ${rname(regionId)}`);
      s = addTokenIfAvailable(s, regionId, 'ratmen', log);
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
      logChoice(`Heroes → ${rlist(regions)}`);
      for (const r of regions) s = addTokenIfAvailable(s, r, 'hero', log);
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
  // applyEvent's addToken handler decrements tokenSupply — no manual decrement.
  return log.apply(state, { type: 'token_placed', regionId, tokenType: token });
}

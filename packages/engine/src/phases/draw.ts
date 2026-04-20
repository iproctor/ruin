import type { GameEvent, GameState, Power, TenzenDiscardAction } from '../types.js';
import { BASE_DRAW_AMOUNT, BASE_POWER_POINTS, UPGRADES, TENZEN_DRAW_TO } from '../constants.js';
import { GameLog } from '../gameLog.js';
import { updatePower, getBasePP } from '../helpers.js';
import { shuffle, makeRng } from '../dice.js';

/** Begin the draw phase. Sets pendingAction for Tenzen if needed, else resolves all draws. */
export function beginDrawPhase(state: GameState): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s = state;

  // Check if Tenzen is active and must make a discard choice
  if (s.activePowers.includes('tenzen')) {
    const tenzen = s.powers['tenzen']!;
    const drawTarget = getTenzenDrawTarget(s);
    if (tenzen.hand.length >= 1) {
      // Tenzen may want to discard first — always prompt if they have cards
      s = {
        ...s,
        pendingAction: {
          waitingFor: 'tenzen',
          actionKind: 'tenzen_discard',
          context: { drawTarget },
        },
      };
      log.emit({ type: 'awaiting_action', power: 'tenzen', actionKind: 'tenzen_discard', context: {}, description: 'Draw phase: waiting for Tenzen discard choice.' });
      return { state: s, log };
    }
  }

  // No Tenzen decision needed — resolve draws for all
  return resolveAllDraws(s, log);
}

/** Apply Tenzen's discard choice, then resolve all draws. */
export function applyTenzenDiscard(state: GameState, action: TenzenDiscardAction): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };

  if (action.cardId !== null) {
    const tenzen = s.powers['tenzen']!;
    const freePlay = s.companionOptions?.humanPlaysFree && tenzen.playerType === 'human';
    const inHand = tenzen.hand.indexOf(action.cardId) !== -1;
    const hasMask = tenzen.hand.indexOf('?') !== -1;
    if (!inHand && !(freePlay && hasMask)) {
      throw new Error(`Card ${action.cardId} not in Tenzen's hand`);
    }
  }
  // Free-play Tenzen: strip the cardId from the log so it doesn't reveal
  // which physical card was discarded.
  const tenzen = s.powers['tenzen']!;
  const maskDiscard = !!s.companionOptions?.humanPlaysFree && tenzen.playerType === 'human' && action.cardId !== null;
  const loggedCardId = maskDiscard ? '?' : action.cardId;
  s = log.apply(s, { type: 'tenzen_discard', cardId: loggedCardId });

  return resolveAllDraws(s, log);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function resolveAllDraws(state: GameState, log: GameLog): { state: GameState; log: GameLog } {
  let s = state;

  // Draw cards using drawForPower (which modifies state internally for deck reshuffles).
  // Collect the results, then apply via power_draw events which carry all final state.
  const drawResults: Array<{ power: Power; drawn: number; handSize: number; drawnCardIds: string[]; deckIds: string[]; discardIds: string[] }> = [];
  // Use a temporary state for computing draws (deck reshuffles need sequential state)
  let tempS = s;
  for (const power of s.activePowers) {
    const result = drawForPower(tempS, power);
    tempS = result.state;
    const ps = tempS.powers[power]!;
    drawResults.push({
      power,
      drawn: (result.event as any).drawn,
      handSize: (result.event as any).handSize,
      drawnCardIds: (result.event as any).drawnCardIds,
      deckIds: ps.deckIds,
      discardIds: ps.discardIds,
    });
  }

  // Compute the reset PP values from the post-draw state (upgrades may affect basePP)
  const ppValues: Record<Power, number> = {} as Record<Power, number>;
  for (const power of s.activePowers) {
    ppValues[power] = getBasePP(tempS, power);
  }

  // Apply power_draw events to the ORIGINAL state (not tempS) — the event handler
  // adds drawn cards to hand, sets PP, syncs deck/discard, and resets passedSummoning.
  for (const { power, drawn, handSize, drawnCardIds, deckIds, discardIds } of drawResults) {
    const pp = ppValues[power]!;
    s = log.apply(s, { type: 'power_draw', power, drawn, handSize, powerPoints: pp, basePowerPoints: pp, drawnCardIds, deckIds, discardIds });
  }

  const firstSummoner = s.summoningOrder[0]!;
  s = {
    ...s,
    phase: 'summoning',
    pendingAction: {
      waitingFor: firstSummoner,
      actionKind: 'summoning_action',
      context: {},
    },
    summoningIndex: 0,
  };
  // Emit phase_start here because autoAdvance can't — the phase transition +
  // pendingAction set happen in the same step, so autoAdvance breaks before
  // reaching its banner-emit branch.
  log.emit({ type: 'phase_start', phase: 'summoning', round: s.round });
  log.emit({ type: 'awaiting_action', power: firstSummoner, actionKind: 'summoning_action', context: {}, description: `${firstSummoner}'s turn to summon.` });

  return { state: s, log };
}

function drawForPower(state: GameState, power: Power): { state: GameState; event: GameEvent } {
  let s = state;
  const p = s.powers[power]!;

  let drawAmount: number;
  if (power === 'tenzen') {
    const target = getTenzenDrawTarget(s);
    drawAmount = Math.max(0, target - p.hand.length);
  } else {
    const base = BASE_DRAW_AMOUNT[power];
    drawAmount = typeof base === 'number' ? base : 2;
    // Extra draw from upgrades
    drawAmount += getExtraDraw(s, power);
  }

  const freePlay = !!s.companionOptions?.humanPlaysFree && p.playerType === 'human';
  let { hand, deckIds, discardIds } = p;
  const drawn: string[] = [];

  for (let i = 0; i < drawAmount; i++) {
    if (deckIds.length === 0) {
      // Reshuffle discard. For free-play humans, mask the reshuffled ids so
      // the engine never holds their "known next cards" — the physical deck
      // and hand stay private.
      const reshuffled = shuffle([...discardIds], makeLocalRng(state));
      deckIds = freePlay ? reshuffled.map(() => '?') : reshuffled;
      discardIds = [];
    }
    if (deckIds.length === 0) break;
    drawn.push(freePlay ? '?' : deckIds[0]!);
    deckIds = deckIds.slice(1);
  }

  hand = [...hand, ...drawn];
  s = updatePower(s, power, { hand, deckIds, discardIds });
  return { state: s, event: { type: 'power_draw' as const, power, drawn: drawn.length, handSize: hand.length, powerPoints: 0, basePowerPoints: 0, drawnCardIds: drawn, deckIds: [], discardIds: [] } };
}

function getTenzenDrawTarget(state: GameState): number {
  let target = TENZEN_DRAW_TO;
  const tenzen = state.powers['tenzen']!;
  for (const upId of tenzen.upgradesInPlay) {
    const up = UPGRADES.find(u => u.id === upId);
    if (up?.power === 'tenzen' && up.powerBonus?.extraDraw) {
      target += up.powerBonus.extraDraw;
    }
  }
  return target;
}

function getExtraDraw(state: GameState, power: Power): number {
  let extra = 0;
  for (const upId of state.powers[power]!.upgradesInPlay) {
    const up = UPGRADES.find(u => u.id === upId);
    if (up?.powerBonus?.extraDraw) extra += up.powerBonus.extraDraw;
  }
  return extra;
}

// getBasePP is in helpers.ts — re-export for backward compat
export { getBasePP } from '../helpers.js';

function makeLocalRng(state: GameState) {
  return makeRng(state.rngSeed ^ (state.actionCount * 2654435761));
}

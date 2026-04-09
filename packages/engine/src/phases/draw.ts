import type { GameState, Power, TenzenDiscardAction } from '../types.js';
import { BASE_DRAW_AMOUNT, BASE_POWER_POINTS, UPGRADES, TENZEN_DRAW_TO } from '../constants.js';
import { updatePower } from '../helpers.js';
import { shuffle, makeRng } from '../dice.js';

/** Begin the draw phase. Sets pendingAction for Tenzen if needed, else resolves all draws. */
export function beginDrawPhase(state: GameState): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s = state;

  // Check if Tenzen is active and must make a discard choice
  if (s.activePowers.includes('tenzen')) {
    const tenzen = s.powers['tenzen']!;
    const drawTarget = getTenzenDrawTarget(s);
    if (tenzen.hand.length > 0 && tenzen.hand.length >= drawTarget) {
      // Tenzen may want to discard first — always prompt if they have cards
      s = {
        ...s,
        pendingAction: {
          waitingFor: 'tenzen',
          actionKind: 'tenzen_discard',
          context: { drawTarget },
        },
      };
      return { state: s, log: ['Draw phase: waiting for Tenzen discard choice.'] };
    }
  }

  // No Tenzen decision needed — resolve draws for all
  return resolveAllDraws(s, log);
}

/** Apply Tenzen's discard choice, then resolve all draws. */
export function applyTenzenDiscard(state: GameState, action: TenzenDiscardAction): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s: GameState = { ...state, pendingAction: null };

  if (action.cardId !== null) {
    const tenzen = s.powers['tenzen']!;
    if (!tenzen.hand.includes(action.cardId)) {
      throw new Error(`Card ${action.cardId} not in Tenzen's hand`);
    }
    s = updatePower(s, 'tenzen', {
      hand: tenzen.hand.filter(id => id !== action.cardId),
      discardIds: [...tenzen.discardIds, action.cardId],
    });
    log.push(`Tenzen discards ${action.cardId}.`);
  } else {
    log.push('Tenzen keeps hand.');
  }

  return resolveAllDraws(s, log);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function resolveAllDraws(state: GameState, log: string[]): { state: GameState; log: string[] } {
  let s = state;

  for (const power of s.activePowers) {
    const result = drawForPower(s, power);
    s = result.state;
    log.push(result.entry);
  }

  // Reset power points and sync basePowerPoints so the UI reflects upgrades
  for (const power of s.activePowers) {
    const pp = getBasePP(s, power);
    s = updatePower(s, power, { powerPoints: pp, basePowerPoints: pp, passedSummoning: false });
  }

  s = {
    ...s,
    phase: 'summoning',
    pendingAction: {
      waitingFor: s.summoningOrder[0]!,
      actionKind: 'summoning_action',
      context: {},
    },
    summoningIndex: 0,
  };
  // Reset passed flags
  for (const power of s.activePowers) {
    s = updatePower(s, power, { passedSummoning: false });
  }

  // Emit the SUMMONING banner here. autoAdvance can't emit it because the
  // phase transition + pendingAction set happen in the same step, so
  // autoAdvance immediately breaks on pendingAction before reaching its
  // banner-emit branch.
  log = [...log, `== Round ${s.round}: SUMMONING ==`];

  return { state: s, log };
}

function drawForPower(state: GameState, power: Power): { state: GameState; entry: string } {
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

  let { hand, deckIds, discardIds } = p;
  const drawn: string[] = [];

  for (let i = 0; i < drawAmount; i++) {
    if (deckIds.length === 0) {
      // Reshuffle discard
      deckIds = shuffle([...discardIds], makeLocalRng(state));
      discardIds = [];
    }
    if (deckIds.length === 0) break;
    // Use slice (non-mutating) instead of shift() so shallow-copied state
    // objects (used during MCTS/greedyAction look-ahead) don't lose cards.
    drawn.push(deckIds[0]!);
    deckIds = deckIds.slice(1);
  }

  hand = [...hand, ...drawn];
  s = updatePower(s, power, { hand, deckIds, discardIds });
  return { state: s, entry: `${power} draws ${drawn.length} card(s) (hand: ${hand.length}).` };
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

export function getBasePP(state: GameState, power: Power): number {
  let base = BASE_POWER_POINTS[power]!;
  for (const upId of state.powers[power]!.upgradesInPlay) {
    const up = UPGRADES.find(u => u.id === upId);
    if (!up?.powerBonus?.extraPowerPoints) continue;
    // Lasha combined Power of Pain + Power of Pleasure
    if (power === 'lasha' && (upId === 'lasha_power_of_pain' || upId === 'lasha_power_of_pleasure')) {
      const hasBoth = state.powers['lasha']!.upgradesInPlay.includes('lasha_power_of_pain')
        && state.powers['lasha']!.upgradesInPlay.includes('lasha_power_of_pleasure');
      if (hasBoth) {
        // Combined = +3 total, not +1+1; handle once
        if (upId === 'lasha_power_of_pain') base += 3; // add 3 once
        // skip second card
        continue;
      }
    }
    base += up.powerBonus.extraPowerPoints;
  }
  return base;
}

function makeLocalRng(state: GameState) {
  return makeRng(state.rngSeed ^ (state.actionCount * 2654435761));
}

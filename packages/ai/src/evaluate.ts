import type { GameState, Power, RegionId } from '@ruin/engine';

// Region IDs for iterating over the board
const ALL_REGIONS: RegionId[] = [
  'norrsund',
  'talvimaa',
  'volensk',
  'mittelreich',
  'normagne',
  'almerida',
  'toscavar',
  'pelascos',
  'the_barrens',
];

// Maximum figures any power can field (cultists + warriors + incarnation).
// xarm: 4+6+1=11, gormen: 6+5+1=12, tenzen: 8+3+1=12, lasha: 6+3+1=10
const MAX_FIGURES: Record<Power, number> = {
  xarm:   11,
  gormen: 12,
  tenzen: 12,
  lasha:  10,
};

// Dial positions per power (lengths of THREAT_DIALS from constants).
// xarm: 8 positions, gormen: 8, tenzen: 8, lasha: 8 — conservative estimate.
const MAX_DIAL_POSITIONS = 8;

/**
 * Evaluate the game state from `power`'s perspective.
 * Returns a score in [0, 1] where 1 is best for `power`.
 *
 * Paranoid MCTS treats all other players as adversaries, so this score
 * is used directly: the AI maximises it, opponents minimise it.
 *
 * Weights:
 *   VP score        0.50
 *   Figures on board 0.20
 *   Threat dial      0.20
 *   Special bonus    0.10  (gormen: corruption in populous; tenzen: magic symbols)
 */
export function evaluateState(state: GameState, power: Power): number {
  // Terminal: immediate win/loss
  if (state.winners !== null) {
    return state.winners.includes(power) ? 1.0 : 0.0;
  }

  const ps = state.powers[power];
  if (ps === undefined) return 0.0;

  // ── VP component ─────────────────────────────────────────────────────────
  // Normalise against a reference maximum of 50 VP.
  const vpScore = Math.min(ps.victoryPoints / 50, 1.0);

  // ── Figures on board component ────────────────────────────────────────────
  const figuresOnBoard = ps.followers.filter(f => f.regionId !== null).length;
  const maxFigs = MAX_FIGURES[power];
  const figureScore = figuresOnBoard / maxFigs;

  // ── Threat dial component ─────────────────────────────────────────────────
  // Higher dial position is closer to a dial-victory — good for the AI.
  const dialScore = ps.dialPosition / MAX_DIAL_POSITIONS;

  // ── Special component ─────────────────────────────────────────────────────
  let specialScore = 0.0;

  if (power === 'gormen') {
    // Corruption tokens in populous regions signal strong board position.
    // Max plausible corruption across populous regions ~16 (generous upper bound).
    let corruptionInPopulous = 0;
    for (const regionId of ALL_REGIONS) {
      const region = state.regions[regionId];
      if (region === undefined) continue;
      if (!region.populous) continue;
      const tokens = region.corruptionTokens[power];
      if (tokens !== undefined) corruptionInPopulous += tokens;
    }
    specialScore = Math.min(corruptionInPopulous / 16, 1.0);
  } else if (power === 'tenzen') {
    // Magic symbols (chaos cards with hasMagicSymbol) on the board signal
    // Tenzen's card engine is running. Max plausible ~8 cards simultaneously.
    let magicSymbolCount = 0;
    for (const regionId of ALL_REGIONS) {
      const region = state.regions[regionId];
      if (region === undefined) continue;
      for (const card of region.chaosCards) {
        if (card !== null && card !== undefined && card.playedBy === power) {
          // We don't import CARD_BY_ID here to keep evaluate.ts lean.
          // Instead we rely on the card IDs containing known magic-symbol card names.
          // Tenzen magic-symbol cards: null_weave, stasis_web, recursive_pattern, kaleidoscope
          if (
            card.cardId === 'tenzen_null_weave' ||
            card.cardId === 'tenzen_stasis_web' ||
            card.cardId === 'tenzen_recursive_pattern' ||
            card.cardId === 'tenzen_kaleidoscope'
          ) {
            magicSymbolCount += 1;
          }
        }
      }
    }
    specialScore = Math.min(magicSymbolCount / 8, 1.0);
  }

  // ── Weighted sum ──────────────────────────────────────────────────────────
  const raw =
    0.5 * vpScore +
    0.2 * figureScore +
    0.2 * dialScore +
    0.1 * specialScore;

  // Clamp to [0, 1]
  return Math.max(0.0, Math.min(1.0, raw));
}

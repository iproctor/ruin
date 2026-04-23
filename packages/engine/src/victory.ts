import type { GameState, Power, WinResult } from './types.js';
import { VP_WIN_THRESHOLD } from './constants.js';

/** Check for game-over conditions. Returns null if game continues. */
export function checkVictory(state: GameState): WinResult | null {
  // Already determined
  if (state.winners !== null) {
    return { winners: state.winners, condition: state.winCondition! };
  }

  // VP threshold: any power at or above 50 VP
  const vpLeaders = state.activePowers.filter(
    p => state.powers[p]!.victoryPoints >= VP_WIN_THRESHOLD
  );
  if (vpLeaders.length > 0) {
    return { winners: breakTies(state, vpLeaders), condition: 'vp' };
  }

  // Threat dial victory (handled inline in advanceDial, but double-check here)
  if (state.winners !== null) {
    return { winners: state.winners, condition: state.winCondition! };
  }

  // Ruination: 5 regions ruined
  if (state.ruinationCardsUsed >= 5) {
    // Powers with the most VP among ruination contributors win
    const winners = findVPWinners(state);
    return { winners, condition: 'ruination' };
  }

  // World deck exhausted (checked at start of world phase).
  // Per RULES.md: "If no Power has won by the time the World Deck is exhausted,
  // the mortal world is the victor and all players lose." — no winners.
  if (state.worldDeck.length === 0 && state.phase === 'world') {
    return { winners: [], condition: 'world_exhausted' };
  }

  return null;
}

/** Among candidates, filter to the single highest-VP power; break ties by highest threat. */
function breakTies(state: GameState, candidates: Power[]): Power[] {
  if (candidates.length <= 1) return candidates;

  // Step 1: highest VP
  const maxVP = Math.max(...candidates.map(p => state.powers[p]!.victoryPoints));
  const vpTied = candidates.filter(p => state.powers[p]!.victoryPoints === maxVP);
  if (vpTied.length === 1) return vpTied;

  // Step 2: highest threat value (tie-breaker)
  const maxThreat = Math.max(...vpTied.map(p => state.powers[p]!.threatValue));
  const threatTied = vpTied.filter(p => state.powers[p]!.threatValue === maxThreat);
  // If still tied after threat, return the single remaining (or all if perfectly tied)
  return threatTied;
}

function findVPWinners(state: GameState): Power[] {
  const all = state.activePowers;
  return breakTies(state, all);
}

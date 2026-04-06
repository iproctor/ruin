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
    // All powers at threshold win together; if multiple just at threshold, all win
    return { winners: vpLeaders, condition: 'vp' };
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

  // World deck exhausted (checked at start of world phase)
  if (state.worldDeck.length === 0 && state.phase === 'world') {
    const winners = findVPWinners(state);
    return { winners, condition: 'world_exhausted' };
  }

  return null;
}

function findVPWinners(state: GameState): Power[] {
  const maxVP = Math.max(...state.activePowers.map(p => state.powers[p]!.victoryPoints));
  return state.activePowers.filter(p => state.powers[p]!.victoryPoints === maxVP);
}

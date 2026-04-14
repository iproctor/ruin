import type { GameState, Power, RegionId, FollowerInstance, RegionState } from './types.js';
import { POWER_ORDER, ADJACENCY, CARD_BY_ID, BASE_POWER_POINTS, UPGRADES } from './constants.js';

// ─── Power helpers ────────────────────────────────────────────────────────────

export function activePowersInOrder(state: GameState): Power[] {
  return POWER_ORDER.filter(p => state.activePowers.includes(p));
}

export function nextPowerInOrder(state: GameState, current: Power): Power {
  const active = activePowersInOrder(state);
  const idx = active.indexOf(current);
  return active[(idx + 1) % active.length]!;
}

export function lowestThreatPower(state: GameState): Power {
  return activePowersInOrder(state).reduce((min, p) =>
    state.powers[p]!.threatValue < state.powers[min]!.threatValue ? p : min
  );
}

export function highestThreatPower(state: GameState): Power {
  return activePowersInOrder(state).reduce((max, p) =>
    state.powers[p]!.threatValue > state.powers[max]!.threatValue ? p : max
  );
}

export function currentThreat(state: GameState, power: Power): number {
  return state.powers[power]!.threatValue;
}

// ─── Region helpers ───────────────────────────────────────────────────────────

export function isAdjacent(a: RegionId, b: RegionId): boolean {
  return ADJACENCY[a]?.includes(b) ?? false;
}

export function isRuined(region: RegionState): boolean {
  return region.ruinationCardIndex !== null;
}

export function totalCorruption(region: RegionState): number {
  const tokens = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);
  const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
  return tokens + chaosStones;
}

export function countToken(region: RegionState, type: RegionState['tokens'][number]): number {
  return region.tokens.filter(t => t === type).length;
}

export function magicSymbolCount(state: GameState, regionId: RegionId): number {
  const region = state.regions[regionId]!;
  let count = 0;
  for (const card of region.chaosCards) {
    if (card === null) continue;
    if (CARD_BY_ID[card.cardId]?.hasMagicSymbol) count++;
  }
  // Figure-borne magic symbols (e.g. Fatespinner upgrade) handled by callers
  return count;
}

// ─── Follower helpers ─────────────────────────────────────────────────────────

export function followersInRegion(state: GameState, regionId: RegionId, power?: Power): FollowerInstance[] {
  const result: FollowerInstance[] = [];
  for (const p of state.activePowers) {
    for (const f of state.powers[p]!.followers) {
      if (f.regionId !== regionId) continue;
      if (power !== undefined && (f.controlledBy ?? f.power) !== power) continue;
      result.push(f);
    }
  }
  return result;
}

export function followersInReserve(state: GameState, power: Power): FollowerInstance[] {
  return state.powers[power]!.followers.filter(f => f.regionId === null);
}

export function allFollowersOnBoard(state: GameState, power: Power): FollowerInstance[] {
  return state.powers[power]!.followers.filter(f => f.regionId !== null);
}

export function hasFiguresOnBoard(state: GameState, power: Power): boolean {
  return state.powers[power]!.followers.some(f => f.regionId !== null);
}

export function regionsWithFigures(state: GameState, power: Power): RegionId[] {
  const regions = new Set<RegionId>();
  for (const f of state.powers[power]!.followers) {
    if (f.regionId !== null) regions.add(f.regionId);
  }
  return [...regions];
}

/** Regions where a power can legally place a new figure. */
export function legalPlacementRegions(state: GameState, power: Power, figureBeingMoved?: string): RegionId[] {
  const allRegions = Object.keys(state.regions) as RegionId[];

  // Find all regions currently occupied by this power — including figures
  // this power controls via Narcotic Musk / Rapture (controlledBy === power).
  const occupied = new Set<RegionId>();
  for (const p of state.activePowers) {
    for (const f of state.powers[p]!.followers) {
      if (f.regionId === null) continue;
      if ((f.controlledBy ?? f.power) !== power) continue;
      occupied.add(f.regionId);
    }
  }

  if (occupied.size === 0) {
    // No figures on board: can place anywhere (from reserve)
    return allRegions;
  }

  // Can place in occupied regions or adjacent to them
  const legal = new Set<RegionId>(occupied);
  for (const r of occupied) {
    for (const adj of ADJACENCY[r] ?? []) {
      legal.add(adj);
    }
  }
  return [...legal];
}

// ─── Card helpers ─────────────────────────────────────────────────────────────

export function cardSlotsAvailable(state: GameState, regionId: RegionId): number {
  const region = state.regions[regionId]!;
  if (isRuined(region)) return 0;

  // Entanglement: regions with Hero tokens have only 1 slot
  const hasHero = region.tokens.includes('hero');
  const entanglementActive = isWorldCardActive(state, 'heroes_of_order');
  const maxSlots = (hasHero && entanglementActive) ? 1 : 2;

  const filled = region.chaosCards.filter(c => c !== null).length;
  return Math.max(0, maxSlots - filled);
}

export function isWorldCardActive(state: GameState, cardId: string): boolean {
  return state.worldTrack.slot1 === cardId || state.worldTrack.slot2 === cardId;
}

// ─── Immutable state helpers ──────────────────────────────────────────────────

export function updateRegion(state: GameState, regionId: RegionId, update: Partial<RegionState>): GameState {
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: { ...state.regions[regionId]!, ...update },
    },
  };
}

export function updatePower(state: GameState, power: Power, update: Partial<GameState['powers'][Power]>): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, ...update },
    },
  };
}

export function scoreVP(state: GameState, power: Power, amount: number): GameState {
  if (amount === 0) return state;
  return updatePower(state, power, {
    victoryPoints: state.powers[power]!.victoryPoints + amount,
  });
}

export function addTokenToRegion(state: GameState, regionId: RegionId, token: RegionState['tokens'][number]): GameState {
  const region = state.regions[regionId]!;
  return updateRegion(state, regionId, {
    tokens: [...region.tokens, token],
  });
}

export function removeTokenFromRegion(state: GameState, regionId: RegionId, token: RegionState['tokens'][number]): GameState {
  const region = state.regions[regionId]!;
  const idx = region.tokens.indexOf(token);
  if (idx === -1) return state;
  const newTokens = [...region.tokens];
  newTokens.splice(idx, 1);
  return updateRegion(state, regionId, { tokens: newTokens });
}

// ─── Power point helpers ────────────────────────────────────────────────────

export function getBasePP(state: GameState, power: Power): number {
  let base = BASE_POWER_POINTS[power]!;
  for (const upId of state.powers[power]!.upgradesInPlay) {
    const up = UPGRADES.find(u => u.id === upId);
    if (!up?.powerBonus?.extraPowerPoints) continue;
    if (power === 'lasha' && (upId === 'lasha_power_of_pain' || upId === 'lasha_power_of_pleasure')) {
      const hasBoth = state.powers['lasha']!.upgradesInPlay.includes('lasha_power_of_pain')
        && state.powers['lasha']!.upgradesInPlay.includes('lasha_power_of_pleasure');
      if (hasBoth) {
        if (upId === 'lasha_power_of_pain') base += 3;
        continue;
      }
    }
    base += up.powerBonus.extraPowerPoints;
  }
  return base;
}

export function addLog(entry: string, log: string[]): string[] {
  return [...log, entry];
}

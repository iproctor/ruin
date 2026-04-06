/**
 * Test helpers — create minimal valid game states without going through
 * createInitialState so each test controls exactly what is in play.
 */
import type {
  GameState, Power, RegionId, Phase,
  FollowerInstance, PlayedCard, TokenType, RegionState, PowerState,
} from '../types.js';
import {
  REGIONS, REGION_ORDER, FOLLOWERS, BASE_POWER_POINTS,
  UPGRADES, THREAT_DIALS,
} from '../constants.js';

// ─── Follower factories ───────────────────────────────────────────────────────

export function makeFollowers(power: Power): FollowerInstance[] {
  const result: FollowerInstance[] = [];
  for (const cls of ['cultist', 'warrior', 'incarnation'] as const) {
    const def = FOLLOWERS[power]![cls]!;
    for (let i = 1; i <= def.count; i++) {
      result.push({
        id: `${power}_${cls}_${i}`,
        power,
        class: cls,
        regionId: null,
        controlledBy: null,
        tipped: false,
        protected: false,
      });
    }
  }
  return result;
}

// ─── State factory ────────────────────────────────────────────────────────────

export function makeState(overrides: Partial<GameState> = {}): GameState {
  const allPowers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

  const makePowerState = (power: Power): PowerState => {
    const basePP = BASE_POWER_POINTS[power]!;
    const startDialEntry = THREAT_DIALS[power]![0]!;
    const threatValue =
      typeof startDialEntry.threat === 'number' ? startDialEntry.threat : 0;
    return {
      power,
      playerType: 'human',
      victoryPoints: 0,
      powerPoints: basePP,
      basePowerPoints: basePP,
      threatValue,
      dialPosition: 0,
      dialCounters: 0,
      hand: [],
      deckIds: [],
      discardIds: [],
      upgradesInPlay: [],
      availableUpgradeIds: UPGRADES.filter(u => u.power === power).map(u => u.id),
      claimedPeasants: 0,
      passedSummoning: false,
      followers: makeFollowers(power),
    };
  };

  const makeRegionState = (regionId: RegionId): RegionState => {
    const def = REGIONS[regionId]!;
    return {
      regionId,
      baseValue: def.baseValue,
      resistance: def.baseValue,
      conquestValue: def.baseValue,
      populous: def.populous,
      tokens: [],
      placements: [],
      chaosCards: [null, null],
      ruinationCardIndex: null,
      corruptionTokens: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
    };
  };

  const base: GameState = {
    gameId: 'test',
    round: 1,
    phase: 'summoning',
    playerCount: 4,
    activePowers: [...allPowers],
    regions: Object.fromEntries(
      REGION_ORDER.map(id => [id, makeRegionState(id)]),
    ) as Record<RegionId, RegionState>,
    powers: Object.fromEntries(
      allPowers.map(p => [p, makePowerState(p)]),
    ) as Record<Power, PowerState>,
    worldDeck: [],
    worldTrack: { slot1: null, slot2: null },
    ruinationCardsUsed: 0,
    tokenSupply: { event: 6, hero: 4, noble: 6, peasant: 20, ratmen: 6, chaos_stone: 14 },
    pendingAction: {
      waitingFor: 'xarm',
      actionKind: 'summoning_action',
      context: {},
    },
    summoningOrder: [...allPowers],
    summoningIndex: 0,
    battleState: null,
    rngSeed: 42,
    actionCount: 0,
    winners: null,
    winCondition: null,
  };

  return { ...base, ...overrides };
}

// ─── State mutation helpers ───────────────────────────────────────────────────

/** Place the first available reserve follower of the given class in a region. */
export function placeFollower(
  state: GameState,
  power: Power,
  cls: 'cultist' | 'warrior' | 'incarnation',
  regionId: RegionId,
  opts: { controlledBy?: Power | null; protected?: boolean } = {},
): GameState {
  const follower = state.powers[power]!.followers.find(
    f => f.class === cls && f.regionId === null,
  );
  if (!follower) throw new Error(`No ${cls} in reserve for ${power}`);
  const updated = {
    ...follower,
    regionId,
    controlledBy: opts.controlledBy ?? null,
    protected: opts.protected ?? false,
  };
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        placements: [...state.regions[regionId]!.placements, updated],
      },
    },
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        followers: state.powers[power]!.followers.map(f =>
          f.id === follower.id ? updated : f,
        ),
      },
    },
  };
}

/** Place a chaos card directly in a region (bypasses hand / cost). */
export function placeCard(
  state: GameState,
  cardId: string,
  power: Power,
  regionId: RegionId,
  slot: 0 | 1 = 0,
  opts: { persistNextRound?: boolean } = {},
): GameState {
  const card: PlayedCard = {
    cardId,
    playedBy: power,
    slotIndex: slot,
    persistNextRound: opts.persistNextRound ?? false,
  };
  const slots = [...state.regions[regionId]!.chaosCards] as [
    PlayedCard | null,
    PlayedCard | null,
  ];
  slots[slot] = card;
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: { ...state.regions[regionId]!, chaosCards: slots },
    },
  };
}

/** Add corruption tokens for a power in a region. */
export function addCorruption(
  state: GameState,
  regionId: RegionId,
  power: Power,
  amount: number,
): GameState {
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        corruptionTokens: {
          ...state.regions[regionId]!.corruptionTokens,
          [power]: state.regions[regionId]!.corruptionTokens[power] + amount,
        },
      },
    },
  };
}

/** Add a world token to a region. */
export function addToken(
  state: GameState,
  regionId: RegionId,
  token: TokenType,
): GameState {
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        tokens: [...state.regions[regionId]!.tokens, token],
      },
    },
  };
}

/** Put card IDs into a power's hand. */
export function giveCards(
  state: GameState,
  power: Power,
  cardIds: string[],
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        hand: [...state.powers[power]!.hand, ...cardIds],
      },
    },
  };
}

/** Put card IDs into a power's deck (front). */
export function giveInDeck(
  state: GameState,
  power: Power,
  cardIds: string[],
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        deckIds: [...cardIds, ...state.powers[power]!.deckIds],
      },
    },
  };
}

/** Activate an upgrade card for a power. */
export function withUpgrade(
  state: GameState,
  power: Power,
  upgradeId: string,
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        upgradesInPlay: [...state.powers[power]!.upgradesInPlay, upgradeId],
        availableUpgradeIds: state.powers[power]!.availableUpgradeIds.filter(
          id => id !== upgradeId,
        ),
      },
    },
  };
}

/** Override power points for a power. */
export function setPP(state: GameState, power: Power, pp: number): GameState {
  return {
    ...state,
    powers: { ...state.powers, [power]: { ...state.powers[power]!, powerPoints: pp } },
  };
}

/** Override victory points for a power. */
export function setVP(state: GameState, power: Power, vp: number): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, victoryPoints: vp },
    },
  };
}

/** Override threat value for a power. */
export function setThreat(
  state: GameState,
  power: Power,
  threatValue: number,
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, threatValue },
    },
  };
}

/** Mark a region as ruined. */
export function ruinRegion(
  state: GameState,
  regionId: RegionId,
  cardIndex = 1,
): GameState {
  return {
    ...state,
    ruinationCardsUsed: state.ruinationCardsUsed + 1,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        ruinationCardIndex: cardIndex,
      },
    },
  };
}

/** Place a world card on the world track slot. */
export function setWorldCard(
  state: GameState,
  cardId: string,
  slot: 'slot1' | 'slot2' = 'slot1',
): GameState {
  return {
    ...state,
    worldTrack: { ...state.worldTrack, [slot]: cardId },
  };
}

/** Convenience: followers of a power in a region. */
export function followersIn(
  state: GameState,
  power: Power,
  regionId: RegionId,
): FollowerInstance[] {
  return state.regions[regionId]!.placements.filter(
    f => (f.controlledBy ?? f.power) === power,
  );
}

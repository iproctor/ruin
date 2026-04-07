import type { GameState, Power, RegionId, RegionState, PowerState, TokenType, FollowerInstance } from './types.js';
import {
  REGIONS, REGION_ORDER, POWER_ORDER, FOLLOWERS, BASE_POWER_POINTS,
  CHAOS_CARDS, UPGRADES, THREAT_DIALS, INITIAL_TOKEN_SUPPLY, STARTING_TOKEN_POOL,
  WORLD_CARDS, WORLD_DECK_SIZE_4P, WORLD_DECK_SIZE_3P, STARTING_HAND_SIZE,
} from './constants.js';
import { shuffle, makeRng } from './dice.js';

export interface GameConfig {
  gameId: string;
  activePowers: Power[];
  playerTypes: Record<Power, 'human' | 'ai' | 'guest'>;
  seed: number;
}

export function createInitialState(config: GameConfig): GameState {
  const { gameId, activePowers, playerTypes, seed } = config;
  const rng = makeRng(seed);

  // ── World deck ─────────────────────────────────────────────────────────────
  const allWorldCardIds: string[] = [];
  for (const card of WORLD_CARDS) {
    for (let i = 0; i < card.count; i++) allWorldCardIds.push(card.id);
  }
  shuffle(allWorldCardIds, rng);
  const deckSize = activePowers.length === 3 ? WORLD_DECK_SIZE_3P : WORLD_DECK_SIZE_4P;
  const worldDeck = allWorldCardIds.slice(0, deckSize);

  // ── Regions ────────────────────────────────────────────────────────────────
  const regions = {} as Record<RegionId, RegionState>;
  for (const id of REGION_ORDER) {
    const def = REGIONS[id]!;
    regions[id] = {
      regionId: id,
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
  }

  // ── Starting tokens ────────────────────────────────────────────────────────
  const tokenPool = [...STARTING_TOKEN_POOL] as TokenType[];
  shuffle(tokenPool, rng);
  for (let i = 0; i < REGION_ORDER.length; i++) {
    regions[REGION_ORDER[i]!]!.tokens.push(tokenPool[i]!);
  }

  const tokenSupply = { ...INITIAL_TOKEN_SUPPLY };
  for (const t of tokenPool) tokenSupply[t]--;

  // ── Powers ─────────────────────────────────────────────────────────────────
  const powers = {} as Record<Power, PowerState>;

  for (const power of POWER_ORDER) {
    if (!activePowers.includes(power)) continue;

    const followers: FollowerInstance[] = [];
    for (const cls of ['cultist', 'warrior', 'incarnation'] as const) {
      const def = FOLLOWERS[power]![cls]!;
      for (let i = 1; i <= def.count; i++) {
        followers.push({ id: `${power}_${cls}_${i}`, power, class: cls, regionId: null, controlledBy: null, tipped: false, protected: false });
      }
    }

    const deckIds: string[] = [];
    for (const card of CHAOS_CARDS.filter(c => c.power === power)) {
      for (let i = 0; i < card.count; i++) deckIds.push(card.id);
    }
    shuffle(deckIds, rng);
    const hand = deckIds.splice(0, STARTING_HAND_SIZE);

    const availableUpgradeIds = UPGRADES.filter(u => u.power === power).map(u => u.id);
    const basePP = BASE_POWER_POINTS[power]!;
    const startDialEntry = THREAT_DIALS[power]![0]!;
    const threatValue = typeof startDialEntry.threat === 'number' ? startDialEntry.threat : 0;

    powers[power] = {
      power,
      playerType: playerTypes[power] ?? 'ai',
      victoryPoints: 0,
      powerPoints: basePP,
      basePowerPoints: basePP,
      threatValue,
      dialPosition: 0,
      dialCounters: 0,
      hand,
      deckIds,
      discardIds: [],
      upgradesInPlay: [],
      availableUpgradeIds,
      claimedPeasants: 0,
      passedSummoning: false,
      pendingForcedDiscards: 0,
      followers,
    };
  }

  return {
    gameId,
    round: 0,
    phase: 'world',
    playerCount: activePowers.length as 2 | 3 | 4,
    activePowers,
    regions,
    powers,
    worldDeck,
    worldTrack: { slot1: null, slot2: null },
    ruinationCardsUsed: 0,
    tokenSupply,
    pendingAction: null,
    summoningOrder: POWER_ORDER.filter(p => activePowers.includes(p)),
    summoningIndex: 0,
    battleState: null,
    pendingDialRewards: null,
    rngSeed: seed,
    actionCount: 0,
    winners: null,
    winCondition: null,
  };
}

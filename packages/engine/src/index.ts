// Public API for the game engine package

export type {
  GameState, Power, Phase, RegionId, FollowerClass, TokenType, PlayerType,
  WinCondition, FollowerInstance, PlayedCard, RegionState, PowerState,
  PendingAction, ActionKind, BattleRoll, BattleState, WorldTrack, TokenSupply,
  WinResult, Action,
  TenzenDiscardAction, SummonFigureAction, PlayCardAction, SummoningPassAction,
  WorldChoiceAction, HeroRemovalAction, WorldCardEffectAction, UpgradeChoiceAction,
  CorruptionHarvestChoiceAction, CardOnPlayChoiceAction,
} from './types.js';

export { createInitialState } from './setup.js';
export type { GameConfig } from './setup.js';

export { applyAction, autoAdvance } from './reducers.js';
export type { ApplyResult } from './reducers.js';

export { getLegalActions } from './legalActions.js';
export { checkVictory } from './victory.js';

export { makeRng, rollDice, rollWithExplosions, countHits, shuffle } from './dice.js';
export type { Rng } from './dice.js';

export {
  CARD_BY_ID, WORLD_CARD_BY_ID, UPGRADE_BY_ID,
  CHAOS_CARDS, WORLD_CARDS, UPGRADES,
  REGIONS, REGION_ORDER,
  THREAT_DIALS,
} from './constants.js';
export type { CardDef, WorldCardDef, UpgradeDef, DialPosition } from './constants.js';

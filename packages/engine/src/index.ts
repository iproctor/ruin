// Public API for the game engine package

export type {
  GameState, Power, Phase, RegionId, FollowerClass, TokenType, PlayerType,
  WinCondition, FollowerInstance, PlayedCard, RegionState, PowerState,
  PendingAction, ActionKind, BattleRoll, BattleState, BattleNextStep, WorldTrack, TokenSupply,
  WinResult, Action,
  TenzenDiscardAction, SummonFigureAction, PlayCardAction, SummoningPassAction,
  WorldChoiceAction, HeroRemovalAction, WorldCardEffectAction, UpgradeChoiceAction,
  CorruptionHarvestChoiceAction, CardOnPlayChoiceAction, ForcedDiscardAction,
  BattleHitAssignmentAction, RaptureChoiceAction,
  DialPendingReward,
  DialPlaceTokenAction, DialRemoveCorruptionAction, DialRemoveWorldTokenAction,
  CompanionOptions, CompanionWorldPickAction, CompanionDiceRollAction,
  GameEvent,
} from './types.js';

export { createInitialState } from './setup.js';
export type { GameConfig } from './setup.js';

export { applyAction, applyActionForPreview, autoAdvance } from './reducers.js';
export type { ApplyResult } from './reducers.js';
export { applyEvent } from './applyEvent.js';
export { maskEvent, maskEvents } from './maskEvent.js';
export { GameLog, renderText } from './gameLog.js';

export { getLegalActions, enumerateBattleHitStrategies, sampleLegalSummoningAction } from './legalActions.js';
export { getRegionDominationLeader, getRegionDomination, getRegionResistance, getPowerDomination, previewDialAdvancementEarners } from './phases/corruption.js';
export { effectiveDefense } from './phases/battle.js';
export { followersInRegion } from './helpers.js';
export { getWorldChoiceRegions } from './phases/world.js';
export { checkVictory } from './victory.js';

export { makeRng, rollDice, rollWithExplosions, countHits, shuffle } from './dice.js';
export type { Rng } from './dice.js';

export {
  CARD_BY_ID, WORLD_CARD_BY_ID, UPGRADE_BY_ID,
  CHAOS_CARDS, WORLD_CARDS, UPGRADES, FOLLOWERS,
  REGIONS, REGION_ORDER, ADJACENCY,
  THREAT_DIALS,
  RUINATION_CARDS,
} from './constants.js';
export type { CardDef, WorldCardDef, UpgradeDef, DialPosition, DialInstruction, RuinationCard } from './constants.js';

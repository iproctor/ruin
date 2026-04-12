// ─── Core enumerations ────────────────────────────────────────────────────────

export type Power = 'xarm' | 'gormen' | 'tenzen' | 'lasha';

export type Phase =
  | 'lobby'
  | 'world'
  | 'draw'
  | 'summoning'
  | 'battle'
  | 'corruption'
  | 'end'
  | 'completed';

export type RegionId =
  | 'norrsund'
  | 'talvimaa'
  | 'volensk'
  | 'mittelreich'
  | 'normagne'
  | 'almerida'
  | 'toscavar'
  | 'pelascos'
  | 'the_barrens';

export type FollowerClass = 'cultist' | 'warrior' | 'incarnation';
export type TokenType = 'event' | 'hero' | 'noble' | 'peasant' | 'ratmen' | 'chaos_stone';
export type PlayerType = 'human' | 'ai' | 'guest';

export type WinCondition = 'threat_dial' | 'vp' | 'ruination' | 'world_exhausted';

// ─── Follower instances ────────────────────────────────────────────────────────

export interface FollowerInstance {
  id: string;           // e.g. "xarm_cultist_1"
  power: Power;
  class: FollowerClass;
  regionId: RegionId | null;  // null = in reserve
  controlledBy: Power | null; // non-null when Enthrallment/Rapture active
  tipped: boolean;            // killed this battle round, awaiting removal
  protected: boolean;         // Fate's Aegis: cannot be killed in battle this round
  warFrenzyHits: number;      // partial hits from War Frenzy; count toward Xarm's defense threshold only
  placedAt: number;           // actionCount when placed/moved to current region (0 = initial)
}

// ─── Cards ────────────────────────────────────────────────────────────────────

export interface PlayedCard {
  cardId: string;
  playedBy: Power;
  slotIndex: 0 | 1;
  persistNextRound: boolean; // Recursive Pattern
  placedAt: number;          // actionCount when played (0 = initial)
}

// ─── Regions ──────────────────────────────────────────────────────────────────

export interface RegionState {
  regionId: RegionId;
  baseValue: number;          // initial Resistance = Conquest Value
  resistance: number;         // modified by Ratmen, cards, etc.
  conquestValue: number;      // modified by Noble tokens, cards, etc.
  populous: boolean;
  tokens: TokenType[];
  placements: FollowerInstance[]; // followers currently here (redundant with FollowerInstance.regionId, kept for fast lookup)
  chaosCards: (PlayedCard | null)[];  // length 2; null = empty slot
  ruinationCardIndex: number | null;  // 1-5 if ruined, else null
  corruptionTokens: Record<Power, number>;
}

// ─── Per-power state ──────────────────────────────────────────────────────────

export interface PowerState {
  power: Power;
  playerType: PlayerType;
  victoryPoints: number;
  powerPoints: number;
  basePowerPoints: number;    // highlighted value on track (increases with upgrades)
  threatValue: number;
  dialPosition: number;       // index into static dial progression array
  dialCounters: number;       // advancement counters accumulated this round
  hand: string[];             // card IDs — hidden from opponents
  deckIds: string[];          // remaining deck (ordered)
  discardIds: string[];
  upgradesInPlay: string[];      // upgrade card IDs currently active
  availableUpgradeIds: string[]; // upgrade cards not yet played
  claimedPeasants: number;       // collected via battle (for Peasant Harvest)
  passedSummoning: boolean;
  pendingForcedDiscards: number; // cards this power must discard at start of their next summoning turn
  followers: FollowerInstance[]; // all followers (on board + reserve)
  lastSummonTurnAt: number;     // actionCount at start of this power's most recent summoning turn
}

// ─── Pending action ───────────────────────────────────────────────────────────

export type ActionKind =
  | 'tenzen_discard'
  | 'summoning_action'         // summon figure, play card, or pass
  | 'world_choice'             // lowest-threat player must choose token placement
  | 'hero_removal'             // forced figure removal from Hero token
  | 'world_card_effect'        // world card persistent effect requiring choice
  | 'upgrade_choice'           // dial instruction: choose an upgrade card
  | 'battle_hit_assignment'    // interactive hit assignment during battle
  | 'corruption_harvest_choice'// Gormen chooses which figures to kill
  | 'card_on_play_choice'      // on-play card effect requiring player choice
  | 'forced_discard'           // player must discard N cards (deferred opponent effect)
  | 'tenzen_apprentice_choice' // Tenzen Apprentices upgrade: carry a chaos stone or leave it
  | 'dial_place_token'         // dial reward: place a noble or chaos stone on any region
  | 'dial_remove_corruption'   // dial reward: remove a corruption token (any power's) from a region
  | 'dial_remove_world_token'; // dial reward: remove a world token from a region

export interface PendingAction {
  waitingFor: Power;
  actionKind: ActionKind;
  context: Record<string, unknown>;
}

// ─── Battle state (transient, during battle phase) ────────────────────────────

export interface BattleRoll {
  power: Power;
  regionId: RegionId;
  dice: number[];
  hits: number;
  assignments: Array<{ followerId: string }>;
}

export type BattleNextStep =
  | { type: 'normal_battle'; powerIndex: number; clearTipped?: boolean }
  | { type: 'undying_fury';  powerIndex: number }
  | { type: 'post_normal' }
  | { type: 'post_undying' };

export interface BattleState {
  regionOrder: RegionId[];          // remaining regions to resolve
  currentRegionIndex: number;
  log: string[];
  nextStep: BattleNextStep | null;  // null = not paused for hit choice
}

// ─── Dial pending rewards (queued interactive end-phase rewards) ──────────────

export type DialPendingReward =
  | { kind: 'upgrade_choice';        power: Power }
  | { kind: 'place_token';           power: Power; tokenType: 'noble' | 'chaos_stone'; remaining: number }
  | { kind: 'remove_corruption';     power: Power; remaining: number }
  | { kind: 'remove_world_tokens';   power: Power; remaining: number };

// ─── World track ──────────────────────────────────────────────────────────────

export interface WorldTrack {
  slot1: string | null;   // card ID
  slot2: string | null;
  discardCard: string | null;  // discard-timing card drawn this round (never goes on track)
}

// ─── Token supply ─────────────────────────────────────────────────────────────

export type TokenSupply = Record<TokenType, number>;

// ─── Game state ───────────────────────────────────────────────────────────────

export interface GameState {
  gameId: string;
  round: number;
  phase: Phase;
  playerCount: 2 | 3 | 4;
  activePowers: Power[];

  regions: Record<RegionId, RegionState>;
  powers: Record<Power, PowerState>;

  worldDeck: string[];      // remaining card IDs, face-down
  worldTrack: WorldTrack;
  ruinationCardsUsed: number; // 0–5

  tokenSupply: TokenSupply;

  // Turn coordination
  pendingAction: PendingAction | null;
  summoningOrder: Power[];  // active powers in power order
  summoningIndex: number;   // index into summoningOrder for current turn

  // Transient
  battleState: BattleState | null;
  pendingDialRewards: DialPendingReward[] | null; // queue of end-phase dial rewards awaiting player choices

  // Replay / RNG
  rngSeed: number;
  actionCount: number;      // incremented per action, used as RNG offset

  // Structured event history (append-only, never mutated)
  events: GameEvent[];

  // Result
  winners: Power[] | null;
  winCondition: WinCondition | null;
}

export type GameEvent =
  // ── Lifecycle ────────────────────────────────────────────────────────────────
  | { type: 'phase_start'; phase: Phase; round: number }
  | { type: 'round_start'; round: number }
  | { type: 'game_over'; winners: Power[]; condition: WinCondition }
  | { type: 'awaiting_action'; power: Power; actionKind: ActionKind; context: Record<string, unknown>; description: string }

  // ── World ────────────────────────────────────────────────────────────────────
  | { type: 'world_card_drawn'; cardId: string; cardName: string }
  | { type: 'comet_removed'; cardIds: string[] }
  | { type: 'world_card_choice'; cardId: string; cardName: string; description: string }
  | { type: 'token_supply_exhausted'; tokenType: TokenType }

  // ── Draw ─────────────────────────────────────────────────────────────────────
  | { type: 'tenzen_discard'; cardId: string | null }
  | { type: 'power_draw'; power: Power; drawn: number; handSize: number; powerPoints: number; basePowerPoints: number }
  | { type: 'summoning_banner'; round: number }

  // ── Summoning ────────────────────────────────────────────────────────────────
  | { type: 'summon_figure'; power: Power; followerId: string; followerClass: FollowerClass; toRegion: RegionId; fromRegion: RegionId | null; cost: number }
  | { type: 'play_card'; power: Power; cardId: string; cardName: string; toRegion: RegionId; slotIndex: 0 | 1; cost: number }
  | { type: 'summoning_pass'; power: Power }
  | { type: 'apprentice_choice'; followerId: string; fromRegion: RegionId; toRegion: RegionId; carry: boolean }
  | { type: 'card_effect'; subtype: 'plaguefather_corruption'; power: Power; regionId: RegionId; tokens: number }
  | { type: 'card_effect'; subtype: 'fractals_summon'; regionId: RegionId; followerName: string }
  | { type: 'card_effect'; subtype: 'call_to_war'; power: Power; followerId: string; fromRegion: RegionId; toRegion: RegionId }
  | { type: 'card_effect'; subtype: 'teleport'; power: Power; followerClass: FollowerClass; fromRegion: RegionId; toRegion: RegionId }
  | { type: 'card_effect'; subtype: 'meddling_of_rats'; targetPower: Power }
  | { type: 'card_effect'; subtype: 'fate_shield'; followerId: string }
  | { type: 'card_effect'; subtype: 'hidden_influence'; tokenType: TokenType; fromRegion: RegionId; toRegion: RegionId }
  | { type: 'card_effect'; subtype: 'narcotic_musk'; power: Power; followerId: string }
  | { type: 'card_effect'; subtype: 'decay'; power: Power; regionId: RegionId }
  | { type: 'card_effect'; subtype: 'siphon_power'; power: Power }
  | { type: 'card_effect'; subtype: 'depraved_infiltration'; regionId: RegionId }

  // ── Battle ───────────────────────────────────────────────────────────────────
  | { type: 'battle_region_start'; regionId: RegionId }
  | { type: 'battle_roll'; regionId: RegionId; power: Power; dice: number[]; hits: number; kind: 'normal' | 'war_frenzy' | 'undying_fury' }
  | { type: 'battle_kill'; regionId: RegionId; attacker: Power; targetPower: Power; targetClass: FollowerClass; targetId: string }
  | { type: 'peasant_claimed'; regionId: RegionId; power: Power; total: number }
  | { type: 'rapture_control'; regionId: RegionId; targetPower: Power; targetClass: FollowerClass; targetId: string }
  | { type: 'heartrippers_corruption'; regionId: RegionId; tokens: number }
  | { type: 'war_frenzy_partial'; regionId: RegionId; followerId: string; hits: number }

  // ── Corruption ───────────────────────────────────────────────────────────────
  | { type: 'domination_result'; regionId: RegionId; power: Power | null; value: number; resistance: number; conquered: boolean; vp: number }
  | { type: 'domination_failed'; regionId: RegionId; power: Power; value: number; resistance: number }
  | { type: 'corruption_placement'; regionId: RegionId; power: Power; tokens: number }
  | { type: 'war_cry_block'; regionId: RegionId }
  | { type: 'deaths_perfume'; regionId: RegionId; tokens: number }
  | { type: 'vile_consumption'; regionId: RegionId; figuresRemoved: number; tokensPlaced: number }
  | { type: 'ruination'; regionId: RegionId; cardIndex: number; ruiners: Power[]; ruinerVP: number }
  | { type: 'ruination_blocked'; regionId: RegionId }
  | { type: 'dial_counter'; regionId: RegionId; power: Power }
  | { type: 'provender_score'; power: Power; vp: number }

  // ── End ──────────────────────────────────────────────────────────────────────
  | { type: 'narcotic_release'; power: Power; followerId: string }
  | { type: 'hero_removal'; regionId: RegionId; power: Power; followerClass: FollowerClass; followerId: string }
  | { type: 'world_card_effect'; subtype: 'normagne_heir_discard'; power: Power; cardId: string }
  | { type: 'world_card_effect'; subtype: 'northern_heir'; power: Power; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'diplomatic_envoy'; power: Power; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'chaos_countermeasures'; power: Power; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'great_exorcism_figures'; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'great_exorcism_events'; regionId: RegionId; eventsMoved: number }
  | { type: 'world_card_effect'; subtype: 'central_overpopulation'; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'cleansing_wave'; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'noble_scrutiny'; power: Power; regionId: RegionId }
  | { type: 'world_card_effect'; subtype: 'eastern_armistice'; power: Power; regionId: RegionId; followerClass: FollowerClass; followerId: string }
  | { type: 'world_card_effect'; subtype: 'peasant_harvest'; power: Power; vp: number; claimed: number }
  | { type: 'world_card_effect'; subtype: 'accelerating_doom' }
  | { type: 'world_card_effect'; subtype: 'forward_scouts_empty' }
  | { type: 'ruination_scoring'; regionId: RegionId; cardIndex: number; first: Power[]; firstVP: number; second: Power[]; secondVP: number }
  | { type: 'dial_advance'; power: Power; position: number; threat: number | 'victory' }
  | { type: 'dial_vp'; power: Power; vp: number }
  | { type: 'dial_victory'; power: Power }
  | { type: 'card_drawn'; power: Power; cardId: string; source: string }

  // ── Reducers (interactive action results) ────────────────────────────────────
  | { type: 'forced_discard'; power: Power; count: number }
  | { type: 'upgrade_taken'; power: Power; upgradeCardId: string }
  | { type: 'dial_place_token'; power: Power; regionId: RegionId; tokenType: 'noble' | 'chaos_stone' }
  | { type: 'dial_remove_corruption'; power: Power; regionId: RegionId; targetPower: Power }
  | { type: 'dial_remove_world_token'; power: Power; regionId: RegionId; tokenType: TokenType }
  | { type: 'hero_forced_removal'; power: Power; regionId: RegionId; followerClass: FollowerClass; followerId: string }
  | { type: 'harvest_kill'; regionId: RegionId; killedBy: Power; targetPower: Power; targetClass: FollowerClass; followerId: string };

// ─── Win result ───────────────────────────────────────────────────────────────

export interface WinResult {
  winners: Power[];
  condition: WinCondition;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface TenzenDiscardAction {
  kind: 'tenzen_discard';
  power: 'tenzen';
  cardId: string | null;  // null = do not discard
}

export interface SummonFigureAction {
  kind: 'summoning_summon_figure';
  power: Power;
  followerId: string;
  toRegion: RegionId;
  /** Tenzen Apprentices: carry the chaos stone from the origin region? */
  carry?: boolean;
}

export interface PlayCardAction {
  kind: 'summoning_play_card';
  power: Power;
  cardId: string;
  toRegion: RegionId;
  slotIndex: 0 | 1;
}

export interface SummoningPassAction {
  kind: 'summoning_pass';
  power: Power;
}

export interface WorldChoiceAction {
  kind: 'world_choice';
  power: Power;
  cardId: string;
  choices: Record<string, unknown>; // card-specific payload
}

export interface HeroRemovalAction {
  kind: 'hero_removal';
  power: Power;
  followerId: string;
  regionId: RegionId;
}

export interface WorldCardEffectAction {
  kind: 'world_card_effect';
  power: Power;
  cardId: string;
  choices: Record<string, unknown>;
}

export interface UpgradeChoiceAction {
  kind: 'upgrade_choice';
  power: Power;
  upgradeCardId: string;
}

export interface CorruptionHarvestChoiceAction {
  kind: 'corruption_harvest_choice';
  power: 'gormen';
  regionId: RegionId;
  followerIds: string[]; // which enemy figures to kill (one per corruption token)
}

/**
 * Generic on-play card choice. `choices` payload per cardId:
 *   xarm_call_to_war:       { followerIds: string[] }          — up to 2 own figures to move in
 *   tenzen_teleport:   { followerId: string, toRegion: RegionId }
 *   tenzen_the_meddling_of_rats: { targetPower: Power }           — opponent to discard 2 cards
 *   tenzen_fate_shield:   { followerId: string }             — figure that cannot be killed
 *   lasha_hidden_influence: { token: TokenType, fromRegion: RegionId, toRegion: RegionId }
 *   lasha_narcotic_musk:   { followerId: string }             — enemy cultist to control
 */
export interface CardOnPlayChoiceAction {
  kind: 'card_on_play_choice';
  power: Power;
  cardId: string;
  regionId: RegionId;
  choices: Record<string, unknown>;
}

export interface ForcedDiscardAction {
  kind: 'forced_discard';
  power: Power;
  cardIds: string[];  // cards chosen to discard (length must equal min(pendingForcedDiscards, hand.length))
}

export interface BattleHitAssignmentAction {
  kind: 'battle_hit_assignment';
  power: Power;
  regionId: RegionId;
  followerIds: string[]; // enemy figures the attacker chooses to kill (total defense must be <= hitsRemaining)
  peasantsToTake?: number; // number of peasant tokens to claim with remaining hits
  warFrenzyPartialHits?: Array<{ followerId: string; hits: number }>; // War Frenzy only: partial hits that don't kill
}

export interface DialPlaceTokenAction {
  kind: 'dial_place_token';
  power: Power;
  regionId: RegionId;
}

export interface DialRemoveCorruptionAction {
  kind: 'dial_remove_corruption';
  power: Power;          // the player who earned the dial reward
  regionId: RegionId;
  targetPower: Power;    // whose corruption token to remove (any power)
}

export interface DialRemoveWorldTokenAction {
  kind: 'dial_remove_world_token';
  power: Power;
  regionId: RegionId;
  tokenType: TokenType;
}

export interface TenzenApprenticeChoiceAction {
  kind: 'tenzen_apprentice_choice';
  power: Power;          // always tenzen
  followerId: string;    // the apprentice that just moved
  fromRegion: RegionId;  // origin (where the chaos stone is)
  toRegion: RegionId;    // destination (where it would go if carried)
  carry: boolean;        // true = carry the chaos stone, false = leave it
}

export type Action =
  | TenzenDiscardAction
  | SummonFigureAction
  | PlayCardAction
  | SummoningPassAction
  | WorldChoiceAction
  | HeroRemovalAction
  | WorldCardEffectAction
  | UpgradeChoiceAction
  | CorruptionHarvestChoiceAction
  | CardOnPlayChoiceAction
  | ForcedDiscardAction
  | TenzenApprenticeChoiceAction
  | DialPlaceTokenAction
  | DialRemoveCorruptionAction
  | DialRemoveWorldTokenAction
  | BattleHitAssignmentAction;

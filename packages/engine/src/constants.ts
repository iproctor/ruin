import type { Power, RegionId, TokenType, FollowerClass } from './types.js';

// ─── Region order ─────────────────────────────────────────────────────────────

export const REGION_ORDER: RegionId[] = [
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

// ─── Region data ──────────────────────────────────────────────────────────────

export interface RegionDef {
  id: RegionId;
  name: string;
  baseValue: number;    // initial Resistance = Conquest Value
  populous: boolean;
}

export const REGIONS: Record<RegionId, RegionDef> = {
  norrsund:    { id: 'norrsund',    name: 'Norrsund',    baseValue: 1, populous: false },
  talvimaa:    { id: 'talvimaa',    name: 'Talvimaa',    baseValue: 1, populous: false },
  volensk:     { id: 'volensk',     name: 'Volensk',     baseValue: 3, populous: true  },
  mittelreich: { id: 'mittelreich', name: 'Mittelreich', baseValue: 5, populous: true  },
  normagne:    { id: 'normagne',    name: 'Normagne',    baseValue: 3, populous: true  },
  almerida:    { id: 'almerida',    name: 'Almerida',    baseValue: 4, populous: true  },
  toscavar:    { id: 'toscavar',    name: 'Toscavar',    baseValue: 2, populous: false },
  pelascos:    { id: 'pelascos',    name: 'Pelascos',    baseValue: 1, populous: false },
  the_barrens: { id: 'the_barrens', name: 'The Barrens', baseValue: 1, populous: false },
};

// ─── Adjacency ────────────────────────────────────────────────────────────────

export const ADJACENCY: Record<RegionId, RegionId[]> = {
  norrsund:    ['talvimaa'],
  talvimaa:    ['norrsund', 'volensk'],
  volensk:     ['talvimaa', 'mittelreich'],
  mittelreich: ['volensk', 'normagne', 'pelascos'],
  normagne:    ['mittelreich', 'almerida', 'toscavar', 'pelascos'],
  almerida:    ['normagne', 'toscavar'],
  toscavar:    ['normagne', 'almerida', 'pelascos'],
  pelascos:    ['mittelreich', 'normagne', 'toscavar', 'the_barrens'],
  the_barrens: ['pelascos'],
};

// ─── Power order ──────────────────────────────────────────────────────────────

export const POWER_ORDER: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

// ─── Token supply ─────────────────────────────────────────────────────────────

export const INITIAL_TOKEN_SUPPLY: Record<TokenType, number> = {
  event:       6,
  hero:        4,
  noble:       6,
  peasant:     20,
  ratmen:      6,
  chaos_stone: 14,
};

// ─── Starting token placement ─────────────────────────────────────────────────

// 2 Noble, 3 Chaos Stone, 4 Peasant placed randomly at setup (one per region)
export const STARTING_TOKEN_POOL: TokenType[] = [
  'noble', 'noble',
  'chaos_stone', 'chaos_stone', 'chaos_stone',
  'peasant', 'peasant', 'peasant', 'peasant',
];

// ─── Follower statistics ──────────────────────────────────────────────────────

export interface FollowerStats {
  cost: number;
  attack: number;
  defense: number;
}

export interface FollowerDef {
  class: FollowerClass;
  name: string;
  count: number;    // total figures in the game for this power
  base: FollowerStats;
  upgraded: FollowerStats;
}

export type PowerFollowers = Record<FollowerClass, FollowerDef>;

export const FOLLOWERS: Record<Power, PowerFollowers> = {
  xarm: {
    cultist:    { class: 'cultist',    name: 'Heartseekers', count: 4, base: { cost: 1, attack: 0, defense: 1 }, upgraded: { cost: 1, attack: 1, defense: 1 } },
    warrior:    { class: 'warrior',    name: 'Heartrippers', count: 6, base: { cost: 2, attack: 2, defense: 1 }, upgraded: { cost: 2, attack: 2, defense: 1 } },
    incarnation:{ class: 'incarnation',name: 'Heartgrinder', count: 1, base: { cost: 3, attack: 4, defense: 3 }, upgraded: { cost: 3, attack: 4, defense: 3 } },
  },
  gormen: {
    cultist:    { class: 'cultist',    name: 'Plaguecarriers', count: 6, base: { cost: 1, attack: 0, defense: 1 }, upgraded: { cost: 1, attack: 0, defense: 1 } },
    warrior:    { class: 'warrior',    name: 'Plaguebringers', count: 5, base: { cost: 1, attack: 1, defense: 1 }, upgraded: { cost: 1, attack: 1, defense: 1 } },
    incarnation:{ class: 'incarnation',name: 'Plaguefather',   count: 1, base: { cost: 3, attack: 3, defense: 3 }, upgraded: { cost: 3, attack: 3, defense: 3 } },
  },
  tenzen: {
    cultist:    { class: 'cultist',    name: 'Apprentices', count: 8, base: { cost: 1, attack: 0, defense: 1 }, upgraded: { cost: 1, attack: 0, defense: 1 } },
    warrior:    { class: 'warrior',    name: 'Fractals',    count: 3, base: { cost: 2, attack: 1, defense: 2 }, upgraded: { cost: 2, attack: 1, defense: 2 } },
    incarnation:{ class: 'incarnation',name: 'Fatespinner', count: 1, base: { cost: 3, attack: 3, defense: 2 }, upgraded: { cost: 3, attack: 3, defense: 2 } },
  },
  lasha: {
    cultist:    { class: 'cultist',    name: 'Addicts',    count: 6, base: { cost: 1, attack: 0, defense: 1 }, upgraded: { cost: 1, attack: 0, defense: 2 } },
    warrior:    { class: 'warrior',    name: 'Ravers',     count: 3, base: { cost: 2, attack: 1, defense: 2 }, upgraded: { cost: 2, attack: 1, defense: 2 } },
    incarnation:{ class: 'incarnation',name: 'The Rapture',count: 1, base: { cost: 3, attack: 2, defense: 4 }, upgraded: { cost: 3, attack: 2, defense: 4 } },
  },
};

// ─── Base power points ────────────────────────────────────────────────────────

export const BASE_POWER_POINTS: Record<Power, number> = {
  xarm:   7,
  gormen: 6,
  tenzen: 6,
  lasha:  6,
};

// ─── Draw amounts ─────────────────────────────────────────────────────────────
// Tenzen draws to 5 (special rule), others draw 2

export const BASE_DRAW_AMOUNT: Record<Power, number | 'draw_to_5'> = {
  xarm:   2,
  gormen: 2,
  tenzen: 'draw_to_5',
  lasha:  2,
};

// ─── Chaos card definitions ───────────────────────────────────────────────────

export interface CardDef {
  id: string;
  power: Power;
  name: string;
  shortName?: string;
  cost: number;
  hasMagicSymbol: boolean;
  count: number;         // copies in the deck
  timing: 'immediate' | 'persistent' | 'beginning_of_battle' | 'end_of_battle' | 'on_play';
  effect: string;        // human-readable description (used for log/UI)
}

export const CHAOS_CARDS: CardDef[] = [
  // ── Xarm ──────────────────────────────────────────────────────────────────
  { id: 'xarm_war_frenzy',    power: 'xarm', name: 'War Frenzy', shortName: 'Frenzy',   cost: 0, hasMagicSymbol: false, count: 4, timing: 'beginning_of_battle', effect: 'At the start of battle, roll two dice and apply hits before normal battle dice are rolled.' },
  { id: 'xarm_war_cry',power: 'xarm', name: 'War Cry', shortName: 'Cry', cost: 1, hasMagicSymbol: false, count: 4, timing: 'persistent', effect: 'No corruption tokens may be placed in this region this round.' },
  { id: 'xarm_carnage_trap',power: 'xarm', name: 'Carnage Trap', shortName: 'Carnage', cost: 1, hasMagicSymbol: false, count: 3, timing: 'persistent', effect: 'No figures other than yours may be summoned away from this region.' },
  { id: 'xarm_ritual_death',power: 'xarm', name: 'Ritual Death', shortName: 'Ritual', cost: 1, hasMagicSymbol: false, count: 3, timing: 'persistent', effect: 'Each time you kill a figure here, draw a Chaos card.' },
  { id: 'xarm_the_red_throne',     power: 'xarm', name: 'The Red Throne', shortName: 'Throne',      cost: 1, hasMagicSymbol: false, count: 4, timing: 'persistent', effect: 'When calculating your domination value in this region, count the sum of your figures\' attack values instead of the quantity of figures.' },
  { id: 'xarm_bloody_rebirth',  power: 'xarm', name: 'Bloody Rebirth', shortName: 'Rebirth',  cost: 2, hasMagicSymbol: false, count: 3, timing: 'persistent', effect: 'During the battle phase, conduct an additional battle in this region.' },
  { id: 'xarm_call_to_war',     power: 'xarm', name: 'Call to War', shortName: 'Call',     cost: 2, hasMagicSymbol: false, count: 3, timing: 'on_play', effect: 'Move up to two of your figures into this region from other regions.' },

  // ── Gormen ────────────────────────────────────────────────────────────────
  { id: 'gormen_pestilent_aura',       power: 'gormen', name: 'Pestilent Aura', shortName: 'Aura',      cost: 0, hasMagicSymbol: true,  count: 4, timing: 'persistent', effect: 'Each of your corruption tokens in this region adds one to your domination value.' },
  { id: 'gormen_pestilent_touch',        power: 'gormen', name: 'Pestilent Touch', shortName: 'Touch',        cost: 0, hasMagicSymbol: false, count: 3, timing: 'persistent', effect: 'Enemy figures\' defense value is reduced by one (minimum 1).' },
  { id: 'gormen_pandemic',             power: 'gormen', name: 'Pandemic', shortName: 'Pandemic',             cost: 1, hasMagicSymbol: false, count: 4, timing: 'persistent', effect: 'This region\'s Resistance is reduced by two.' },
  { id: 'gormen_rain_of_bile',          power: 'gormen', name: 'Rain of Bile', shortName: 'Rain',          cost: 1, hasMagicSymbol: false, count: 3, timing: 'persistent', effect: 'Your figures\' defense value is increased by one.' },
  { id: 'gormen_decay',              power: 'gormen', name: 'Decay', shortName: 'Decay',              cost: 1, hasMagicSymbol: false, count: 2, timing: 'on_play', effect: 'Remove one corruption token (any player) from this region.' },
  { id: 'gormen_vile_consumption',         power: 'gormen', name: 'Vile Consumption', shortName: 'Consump.',         cost: 2, hasMagicSymbol: false, count: 3, timing: 'on_play', effect: 'At the end of Corruption Phase, remove all of your figures from this region; place one corruption token for every two figures removed.' },
  { id: 'gormen_inevitable_rot',  power: 'gormen', name: 'Inevitable Rot', shortName: 'Rot', cost: 2, hasMagicSymbol: false, count: 3, timing: 'end_of_battle', effect: 'After battle, kill one enemy Cultist or Warrior per corruption token you have in this region. Gormen chooses which figures to kill.' },
  { id: 'gormen_deaths_perfume',       power: 'gormen', name: 'Death\'s Perfume', shortName: 'Perfume',      cost: 3, hasMagicSymbol: true,  count: 2, timing: 'persistent', effect: 'If you dominate this region, place two corruption tokens here.' },

  // ── Tenzen ────────────────────────────────────────────────────────────────
  { id: 'tenzen_changer_of_fate',       power: 'tenzen', name: 'Changer of Fate', shortName: 'Changer',       cost: 0, hasMagicSymbol: true,  count: 3, timing: 'persistent', effect: 'The text effects of all other Chaos cards in this region are canceled.' },
  { id: 'tenzen_fate_shield',      power: 'tenzen', name: 'Fate Shield', shortName: 'Shield',    cost: 0, hasMagicSymbol: false, count: 3, timing: 'on_play', effect: 'Choose one of your figures; it cannot be killed in battle this round.' },
  { id: 'tenzen_teleport',      power: 'tenzen', name: 'Teleport', shortName: 'Teleport',      cost: 1, hasMagicSymbol: false, count: 4, timing: 'on_play', effect: 'Move any Cultist or Warrior in this region to any other region.' },
  { id: 'tenzen_the_meddling_of_rats',  power: 'tenzen', name: 'The Meddling of Rats', shortName: 'Meddling',  cost: 1, hasMagicSymbol: false, count: 3, timing: 'on_play', effect: 'Choose one opponent with figures in this region; that opponent discards two Chaos cards.' },
  { id: 'tenzen_stasis_web',       power: 'tenzen', name: 'Stasis Web', shortName: 'Stasis',       cost: 1, hasMagicSymbol: true,  count: 3, timing: 'persistent', effect: 'Opponents pay +2 power points to summon figures or play Chaos cards in this region.' },
  { id: 'tenzen_persistence_matrix',power: 'tenzen', name: 'Persistence Matrix', shortName: 'Persistence', cost: 1, hasMagicSymbol: true,  count: 3, timing: 'persistent', effect: 'If you kill one or more figures in battle here, you may keep this card on the board rather than discarding it at end of round.' },
  { id: 'tenzen_shimmer',     power: 'tenzen', name: 'Shimmer', shortName: 'Shimmer',     cost: 2, hasMagicSymbol: true,  count: 3, timing: 'persistent', effect: 'During the corruption phase, one Cultist per opponent in this region does not count toward corruption token placement.' },
  { id: 'tenzen_siphon_power',    power: 'tenzen', name: 'Siphon Power', shortName: 'Siphon',    cost: 0, hasMagicSymbol: false, count: 2, timing: 'on_play', effect: 'Each other player with at least one Cultist in this region loses one power point; you gain one power point.' },

  // ── Lasha ─────────────────────────────────────────────────────────────────
  { id: 'lasha_hollow_pact',    power: 'lasha', name: 'Hollow Pact', shortName: 'Pact',    cost: 0, hasMagicSymbol: true,  count: 2, timing: 'persistent', effect: 'Enemy figures contribute nothing to their owners\' domination values in this region.' },
  { id: 'lasha_depraved_infiltration',   power: 'lasha', name: 'Depraved Infiltration', shortName: 'Infiltration',   cost: 0, hasMagicSymbol: false, count: 4, timing: 'on_play', effect: 'Place one corruption token in this region. This does not trigger your dial advancement condition.' },
  { id: 'lasha_sweet_lies',   power: 'lasha', name: 'Sweet Lies', shortName: 'Lies',   cost: 1, hasMagicSymbol: false, count: 4, timing: 'persistent', effect: 'For each Noble and Hero token in this region, add two to your domination value.' },
  { id: 'lasha_hidden_influence', power: 'lasha', name: 'Hidden Influence', shortName: 'Influence', cost: 1, hasMagicSymbol: true, count: 4, timing: 'on_play', effect: 'Move a Peasant, Hero, or Noble token from this region to any other region.' },
  { id: 'lasha_narcotic_musk',   power: 'lasha', name: 'Narcotic Musk', shortName: 'Musk',   cost: 2, hasMagicSymbol: true,  count: 4, timing: 'persistent', effect: 'Choose one enemy Cultist in this region; you control it until this card is discarded.' },
  { id: 'lasha_ecstasy',  power: 'lasha', name: 'Plane of Ecstasy', shortName: 'Ecstasy',  cost: 2, hasMagicSymbol: false, count: 3, timing: 'persistent', effect: 'No figures roll battle dice in this region this round.' },
  { id: 'lasha_debauched_royalty',power: 'lasha', name: 'Debauched Royalty', shortName: 'Royalty', cost: 3, hasMagicSymbol: false, count: 3, timing: 'on_play', effect: 'If this region contains three or more corruption tokens when you play this card, reduce the cost by three. The printed cost still counts toward domination.' },
];

// ─── Upgrade card definitions ─────────────────────────────────────────────────

export type UpgradeType = 'power' | 'cultist' | 'warrior' | 'incarnation';

export interface UpgradeDef {
  id: string;
  power: Power;
  name: string;
  upgradeType: UpgradeType;
  effect: string;
  // For follower upgrades, the new stats (overrides base)
  newStats?: { cost?: number; attack?: number; defense?: number };
  // For power upgrades, the effect is applied to PowerState
  powerBonus?: { extraPowerPoints?: number; extraDraw?: number };
}

export const UPGRADES: UpgradeDef[] = [
  // ── Xarm ──────────────────────────────────────────────────────────────────
  { id: 'xarm_flood_of_ferocity', power: 'xarm', name: 'Flood of Ferocity', upgradeType: 'power',      effect: 'Draw one additional Chaos card in each draw phase.', powerBonus: { extraDraw: 1 } },
  { id: 'xarm_power_of_war',     power: 'xarm', name: 'Power of War',     upgradeType: 'power',      effect: 'Gain one extra power point in the draw phase.', powerBonus: { extraPowerPoints: 1 } },
  { id: 'xarm_heartseekers_up',    power: 'xarm', name: 'Heartseekers Upgrade',upgradeType: 'cultist',   effect: 'Heartseekers gain attack 1.', newStats: { attack: 1 } },
  { id: 'xarm_heartrippers_up',    power: 'xarm', name: 'Heartrippers Upgrade',upgradeType: 'warrior',   effect: 'Place one corruption token for each enemy figure your Heartrippers kill in the battle phase (including explosions).' },
  { id: 'xarm_heartgrinder_up',    power: 'xarm', name: 'Heartgrinder Upgrade',upgradeType: 'incarnation',effect: 'A single Heartgrinder counts as four figures for domination value.' },

  // ── Gormen ────────────────────────────────────────────────────────────────
  { id: 'gormen_provender_of_rot',  power: 'gormen', name: 'Provender of Rot',    upgradeType: 'power',      effect: 'Score 3 VP each time any region is ruined.', powerBonus: {} },
  { id: 'gormen_power_of_decay',power: 'gormen', name: 'Power of Decay',  upgradeType: 'power',      effect: 'Gain two extra power points in the draw phase.', powerBonus: { extraPowerPoints: 2 } },
  { id: 'gormen_plaguecarriers_up',  power: 'gormen', name: 'Plaguecarriers Upgrade',upgradeType: 'cultist',   effect: 'A Plaguecarrier costs 0 if placed in a region where you have no other figures (once per figure per round).' },
  { id: 'gormen_plaguebringers_up',  power: 'gormen', name: 'Plaguebringers Upgrade',upgradeType: 'warrior',   effect: 'Each Plaguebringer counts as two figures toward your domination value.', newStats: { cost: 1, attack: 1, defense: 1 } },
  { id: 'gormen_plaguefather_up',    power: 'gormen', name: 'Plaguefather Upgrade',  upgradeType: 'incarnation',effect: 'Immediately place two corruption tokens in a region when you summon your Plaguefather there.' },

  // ── Tenzen ────────────────────────────────────────────────────────────────
  { id: 'tenzen_flood_of_magic', power: 'tenzen', name: 'Flood of Magic',   upgradeType: 'power',      effect: 'Draw to six Chaos cards in each draw phase instead of five.', powerBonus: { extraDraw: 1 } },
  { id: 'tenzen_power_of_fate',  power: 'tenzen', name: 'Power of Fate',    upgradeType: 'power',      effect: 'Gain one extra power point in the draw phase.', powerBonus: { extraPowerPoints: 1 } },
  { id: 'tenzen_apprentices_up',  power: 'tenzen', name: 'Apprentices Upgrade',upgradeType: 'cultist',   effect: 'When summoned from the board, an Apprentice may carry one Chaos Stone token from its origin region to its destination.' },
  { id: 'tenzen_fractals_up',     power: 'tenzen', name: 'Fractals Upgrade',   upgradeType: 'warrior',   effect: 'When you play a Chaos card with a magic symbol, you may immediately summon a Fractal to that region for 0 power.', newStats: { cost: 2, attack: 1, defense: 2 } },
  { id: 'tenzen_fatespinner_up',  power: 'tenzen', name: 'Fatespinner Upgrade',upgradeType: 'incarnation',effect: 'The Fatespinner counts as two Chaos Stone tokens for ruination and dial advancement purposes.', newStats: { cost: 3, attack: 3, defense: 2 } },

  // ── Lasha ─────────────────────────────────────────────────────────────────
  { id: 'lasha_power_of_pain',    power: 'lasha', name: 'Power of Pain',    upgradeType: 'power',      effect: 'Gain one extra power point per draw phase. If Power of Pleasure is also in play, gain three extra total.', powerBonus: { extraPowerPoints: 1 } },
  { id: 'lasha_power_of_pleasure',power: 'lasha', name: 'Power of Pleasure', upgradeType: 'power',     effect: 'Gain one extra power point per draw phase. If Power of Pain is also in play, gain three extra total.', powerBonus: { extraPowerPoints: 1 } },
  { id: 'lasha_addicts_up',       power: 'lasha', name: 'Addicts Upgrade',   upgradeType: 'cultist',   effect: 'Addicts gain defense 2.', newStats: { defense: 2 } },
  { id: 'lasha_ravers_up',        power: 'lasha', name: 'Ravers Upgrade',    upgradeType: 'warrior',   effect: 'Ravers also place corruption tokens during the corruption phase, as if they were Cultists.', newStats: { cost: 2, attack: 1, defense: 2 } },
  { id: 'lasha_rapture_up',       power: 'lasha', name: 'The Rapture Upgrade',upgradeType: 'incarnation',effect: 'At the beginning of the battle phase, choose any enemy Cultist or Warrior in this region. You control it until end of round or until The Rapture is killed.', newStats: { cost: 3, attack: 2, defense: 4 } },
];

// ─── Threat dial progressions ─────────────────────────────────────────────────

export type DialInstruction =
  | { type: 'start' }
  | { type: 'victory' }
  | { type: 'score_vp'; amount: number }
  | { type: 'upgrade_card' }
  | { type: 'draw_chaos_cards'; amount: number }
  | { type: 'place_nobles'; amount: number }
  | { type: 'place_chaos_stone'; amount: number }
  | { type: 'remove_corruption'; amount: number }
  | { type: 'remove_world_tokens'; amount: number };

export interface DialPosition {
  threat: number | 'victory';
  instruction: DialInstruction;
}

export const THREAT_DIALS: Record<Power, DialPosition[]> = {
  xarm: [
    { threat: 3,         instruction: { type: 'start' } },
    { threat: 6,         instruction: { type: 'score_vp', amount: 4 } },
    { threat: 12,        instruction: { type: 'upgrade_card' } },
    { threat: 14,        instruction: { type: 'draw_chaos_cards', amount: 2 } },
    { threat: 17,        instruction: { type: 'score_vp', amount: 4 } },
    { threat: 23,        instruction: { type: 'upgrade_card' } },
    { threat: 28,        instruction: { type: 'upgrade_card' } },
    { threat: 31,        instruction: { type: 'draw_chaos_cards', amount: 2 } },
    { threat: 32,        instruction: { type: 'draw_chaos_cards', amount: 2 } },
    { threat: 'victory', instruction: { type: 'victory' } },
  ],
  gormen: [
    { threat: 1,         instruction: { type: 'start' } },
    { threat: 5,         instruction: { type: 'score_vp', amount: 3 } },
    { threat: 10,        instruction: { type: 'remove_corruption', amount: 1 } },
    { threat: 13,        instruction: { type: 'upgrade_card' } },
    { threat: 18,        instruction: { type: 'score_vp', amount: 3 } },
    { threat: 22,        instruction: { type: 'upgrade_card' } },
    { threat: 26,        instruction: { type: 'remove_corruption', amount: 2 } },
    { threat: 30,        instruction: { type: 'upgrade_card' } },
    { threat: 33,        instruction: { type: 'score_vp', amount: 3 } },
    { threat: 34,        instruction: { type: 'remove_corruption', amount: 2 } },
    { threat: 'victory', instruction: { type: 'victory' } },
  ],
  tenzen: [
    { threat: 2,         instruction: { type: 'start' } },
    { threat: 7,         instruction: { type: 'place_chaos_stone', amount: 1 } },
    { threat: 9,         instruction: { type: 'upgrade_card' } },
    { threat: 15,        instruction: { type: 'score_vp', amount: 3 } },
    { threat: 20,        instruction: { type: 'upgrade_card' } },
    { threat: 21,        instruction: { type: 'place_chaos_stone', amount: 2 } },
    { threat: 25,        instruction: { type: 'upgrade_card' } },
    { threat: 29,        instruction: { type: 'score_vp', amount: 5 } },
    { threat: 'victory', instruction: { type: 'victory' } },
  ],
  lasha: [
    { threat: 4,         instruction: { type: 'start' } },
    { threat: 8,         instruction: { type: 'score_vp', amount: 3 } },
    { threat: 11,        instruction: { type: 'upgrade_card' } },
    { threat: 16,        instruction: { type: 'place_nobles', amount: 2 } },
    { threat: 19,        instruction: { type: 'upgrade_card' } },
    { threat: 24,        instruction: { type: 'upgrade_card' } },
    { threat: 27,        instruction: { type: 'remove_world_tokens', amount: 2 } },
    { threat: 'victory', instruction: { type: 'victory' } },
  ],
};

// ─── Ruination cards ──────────────────────────────────────────────────────────

export interface RuinationCard {
  index: number;           // 1–5
  ruinersScore: number;    // immediate VP for players who placed tokens
  endPhaseVP: Record<RegionId, { first: number; second: number }>;
}

export const RUINATION_CARDS: RuinationCard[] = [
  {
    index: 1, ruinersScore: 3,
    endPhaseVP: {
      norrsund:    { first: 6,  second: 3 },
      talvimaa:    { first: 6,  second: 3 },
      volensk:     { first: 8,  second: 4 },
      mittelreich: { first: 10, second: 5 },
      normagne:    { first: 8,  second: 4 },
      almerida:    { first: 9,  second: 4 },
      toscavar:    { first: 7,  second: 3 },
      pelascos:    { first: 7,  second: 3 },
      the_barrens: { first: 6,  second: 3 },
    },
  },
  {
    index: 2, ruinersScore: 4,
    endPhaseVP: {
      norrsund:    { first: 7,  second: 3 },
      talvimaa:    { first: 7,  second: 3 },
      volensk:     { first: 9,  second: 4 },
      mittelreich: { first: 11, second: 5 },
      normagne:    { first: 9,  second: 4 },
      almerida:    { first: 10, second: 5 },
      toscavar:    { first: 8,  second: 4 },
      pelascos:    { first: 8,  second: 4 },
      the_barrens: { first: 7,  second: 3 },
    },
  },
  {
    index: 3, ruinersScore: 4,
    endPhaseVP: {
      norrsund:    { first: 7,  second: 3 },
      talvimaa:    { first: 7,  second: 3 },
      volensk:     { first: 9,  second: 4 },
      mittelreich: { first: 11, second: 5 },
      normagne:    { first: 9,  second: 4 },
      almerida:    { first: 10, second: 5 },
      toscavar:    { first: 8,  second: 4 },
      pelascos:    { first: 8,  second: 4 },
      the_barrens: { first: 7,  second: 3 },
    },
  },
  {
    index: 4, ruinersScore: 5,
    endPhaseVP: {
      norrsund:    { first: 8,  second: 4 },
      talvimaa:    { first: 8,  second: 4 },
      volensk:     { first: 10, second: 5 },
      mittelreich: { first: 12, second: 6 },
      normagne:    { first: 10, second: 5 },
      almerida:    { first: 11, second: 5 },
      toscavar:    { first: 9,  second: 4 },
      pelascos:    { first: 9,  second: 4 },
      the_barrens: { first: 8,  second: 4 },
    },
  },
  {
    index: 5, ruinersScore: 5,
    endPhaseVP: {
      norrsund:    { first: 8,  second: 4 },
      talvimaa:    { first: 8,  second: 4 },
      volensk:     { first: 10, second: 5 },
      mittelreich: { first: 12, second: 6 },
      normagne:    { first: 10, second: 5 },
      almerida:    { first: 11, second: 5 },
      toscavar:    { first: 9,  second: 4 },
      pelascos:    { first: 9,  second: 4 },
      the_barrens: { first: 8,  second: 4 },
    },
  },
];

// ─── World cards ──────────────────────────────────────────────────────────────

export type WorldCardTiming =
  | 'discard'           // never goes on track
  | 'persistent'        // goes on track, resolves in Resolve World Cards step
  | 'end_of_battle'     // goes on track, resolves at end of battle phase
  | 'constant';         // goes on track, always in effect

export interface WorldCardDef {
  id: string;
  name: string;
  count: number;
  hasCometIcon: boolean;
  timing: WorldCardTiming;
  immediateEffect: string;
  persistentEffect: string | null;
  requiresChoice: boolean;          // whether lowest-threat player must make a decision on immediate
}

export const WORLD_CARDS: WorldCardDef[] = [
  { id: 'normagne_heir', name: 'Normagne Heir', count: 1, hasCometIcon: false, timing: 'persistent', requiresChoice: true,
    immediateEffect: 'Place a Hero token on Normagne and a Hero token on any other region.',
    persistentEffect: 'During Resolve World Cards: each player with 1+ figures on Normagne must discard a Chaos card of their choice, if possible.' },

  { id: 'eastern_armistice', name: 'Eastern Armistice', count: 1, hasCometIcon: true, timing: 'end_of_battle', requiresChoice: false,
    immediateEffect: 'Place an Event token on Almerida, Normagne, and Norrsund.',
    persistentEffect: 'At the end of the battle phase: each player must remove one of their figures from each region containing an Event token, if possible.' },

  { id: 'northern_heir', name: 'Northern Heir', count: 1, hasCometIcon: false, timing: 'persistent', requiresChoice: true,
    immediateEffect: 'Place a Hero token on Norrsund and Volensk, OR on Talvimaa and Mittelreich.',
    persistentEffect: 'During Resolve World Cards: the player with the lowest Threat places a Hero token on a region where there is already a Hero token, if possible.' },

  { id: 'mittelreich_diplomacy', name: 'Mittelreich Diplomacy', count: 1, hasCometIcon: true, timing: 'constant', requiresChoice: true,
    immediateEffect: 'Place an Event token on Mittelreich and an Event token on any other region.',
    persistentEffect: 'No battles may take place in regions containing at least 1 Event token.' },

  { id: 'accelerating_doom', name: 'Accelerating Doom', count: 1, hasCometIcon: false, timing: 'discard', requiresChoice: false,
    immediateEffect: 'Discard this card from the game entirely, then draw and resolve another card from the top of the World Deck immediately.',
    persistentEffect: null },

  { id: 'the_chokepoint', name: 'The Chokepoint', count: 1, hasCometIcon: true, timing: 'constant', requiresChoice: true,
    immediateEffect: 'Place an Event token on The Barrens, Mittelreich, and Toscavar.',
    persistentEffect: 'Each player who battles in a region containing at least 1 Event token may only roll 1 battle die in total for that battle.' },

  { id: 'chaos_storm', name: 'Chaos Storm', count: 2, hasCometIcon: false, timing: 'discard', requiresChoice: false,
    immediateEffect: 'Place a Chaos Stone token on 3 different regions.',
    persistentEffect: null },

  { id: 'central_overpopulation', name: 'Central Overpopulation', count: 1, hasCometIcon: true, timing: 'persistent', requiresChoice: true,
    immediateEffect: 'Place an Event token on Normagne, Mittelreich, and Toscavar. Then place a Peasant token on every region.',
    persistentEffect: 'During Resolve World Cards: remove one Peasant token from each region containing an Event token.' },

  { id: 'raise_the_militia', name: 'Raise the Militia', count: 2, hasCometIcon: false, timing: 'constant', requiresChoice: false,
    immediateEffect: 'Place a Peasant token on every region except The Barrens.',
    persistentEffect: 'Each Peasant token on the board increases the Resistance of its region by 1.' },

  { id: 'peasant_harvest', name: 'Peasant Harvest', count: 4, hasCometIcon: false, timing: 'discard', requiresChoice: false,
    immediateEffect: 'Each player scores 1 VP per claimed Peasant token. The player with the most claimed Peasants scores an additional 3 VP. Claimed tokens are not discarded.',
    persistentEffect: null },

  { id: 'diplomatic_envoy', name: 'Diplomatic Envoy', count: 1, hasCometIcon: false, timing: 'persistent', requiresChoice: false,
    immediateEffect: 'Place a Hero token on 3 different Populous regions.',
    persistentEffect: 'During Resolve World Cards: the player with the lowest Threat removes 1 Hero token from the board.' },

  { id: 'chaos_countermeasures', name: 'Chaos Countermeasures', count: 1, hasCometIcon: false, timing: 'persistent', requiresChoice: false,
    immediateEffect: 'Place a Ratmen token on The Barrens and Pelascos.',
    persistentEffect: 'During Resolve World Cards: the player with the lowest Threat places a Ratmen token on any region containing at least 1 Chaos Stone token. If none, do nothing.' },

  { id: 'great_exorcism', name: 'Great Exorcism', count: 1, hasCometIcon: true, timing: 'persistent', requiresChoice: true,
    immediateEffect: 'Place an Event token on any region.',
    persistentEffect: "During Resolve World Cards: remove all Cultists from each region containing at least 1 Event token (return to owners' stockpiles). Then move all Event tokens to the region with the most corruption tokens." },

  { id: 'grand_muster', name: 'Grand Muster', count: 1, hasCometIcon: false, timing: 'discard', requiresChoice: false,
    immediateEffect: 'Place a Peasant token on 2 different regions, then a Hero token on 2 different regions, then a Noble token on 2 different regions.',
    persistentEffect: null },

  { id: 'ratmens_price', name: "Ratmen's Price", count: 1, hasCometIcon: false, timing: 'constant', requiresChoice: true,
    immediateEffect: 'Place a Ratmen token on Normagne and Mittelreich, OR on Almerida and Toscavar.',
    persistentEffect: 'While this card remains in play, only 1 Chaos card may be played in any region containing 1 or more Ratmen tokens.' },

  { id: 'cleansing_wave', name: 'Cleansing Wave', count: 1, hasCometIcon: true, timing: 'persistent', requiresChoice: false,
    immediateEffect: 'Place an Event token on Normagne and an Event token on a region adjacent to Normagne.',
    persistentEffect: 'During Resolve World Cards: remove all corruption tokens from each region containing at least 1 Event token.' },

  { id: 'forward_scouts', name: 'Forward Scouts', count: 2, hasCometIcon: false, timing: 'discard', requiresChoice: false,
    immediateEffect: 'Place a Ratmen token on any region (or adjacent region) containing 1+ Chaos Stone tokens. If none, do nothing.',
    persistentEffect: null },

  { id: 'the_exchange', name: 'The Exchange', count: 1, hasCometIcon: false, timing: 'persistent', requiresChoice: true,
    immediateEffect: 'Place 2 Chaos Stone tokens on any region.',
    persistentEffect: 'During Resolve World Cards: each player with at least 1 figure on a region containing at least 1 Chaos Stone token draws 1 Chaos card.' },

  { id: 'noble_scrutiny', name: 'Noble Scrutiny', count: 1, hasCometIcon: false, timing: 'persistent', requiresChoice: false,
    immediateEffect: 'Place a Hero token on Normagne, Mittelreich, and Almerida.',
    persistentEffect: 'During Resolve World Cards: in each region containing a Hero token, the player with the greatest Threat removes 1 of their corruption tokens from that region, if they have one there.' },
];

// ─── Derived lookups ──────────────────────────────────────────────────────────

export const CARD_BY_ID = Object.fromEntries(CHAOS_CARDS.map(c => [c.id, c])) as Record<string, CardDef>;
export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u])) as Record<string, UpgradeDef>;
export const WORLD_CARD_BY_ID = Object.fromEntries(WORLD_CARDS.map(c => [c.id, c])) as Record<string, WorldCardDef>;

export const VP_WIN_THRESHOLD = 50;
export const CORRUPTION_RUIN_THRESHOLD = 12;
export const MAX_RUINATION_CARDS = 5;
export const WORLD_DECK_SIZE_4P = 7;
export const WORLD_DECK_SIZE_3P = 8;
export const STARTING_HAND_SIZE = 3;
export const TENZEN_DRAW_TO = 5;
export const CARD_SLOTS_PER_REGION = 2;

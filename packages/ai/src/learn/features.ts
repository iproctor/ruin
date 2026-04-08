import type { GameState, Power, RegionId, FollowerClass, TokenType } from '@ruin/engine';
import { CHAOS_CARDS, WORLD_CARDS, UPGRADES, getRegionResistance } from '@ruin/engine';

/**
 * Feature extractor — v2 (~450 features).
 *
 * Layout:
 *   [0]                         global (round, world_slot_flags, ruination)
 *   [...]                       per-power stats (4 × PER_POWER)
 *   [...]                       per-region stats (9 × PER_REGION)
 *   [...]                       one-hot for world track cards
 *
 * Changes vs v1:
 *   - Per-power: adds deck/discard sizes, figure class breakdown, upgrade one-hot
 *   - Per-region: adds chaos card slots (one-hot by cardId + playedBy),
 *     token counts (peasant, noble, event, hero, chaos_stone, ratmen),
 *     figure class breakdown per power
 *   - Global: adds ruination card count, world track presence
 *
 * This still doesn't cover everything (no hidden info, no battle state), but
 * it captures the board-level signals a linear/MLP model needs to discriminate
 * mid-game positions.
 */

// ── Canonical orderings ──────────────────────────────────────────────────────

export const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

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

export const FOLLOWER_CLASSES: FollowerClass[] = ['cultist', 'warrior', 'incarnation'];
export const TOKEN_TYPES: TokenType[] = ['peasant', 'noble', 'event', 'hero', 'ratmen', 'chaos_stone'];

// Sorted card ids for stable indexing
const CHAOS_CARD_IDS = CHAOS_CARDS.map(c => c.id).sort();
const UPGRADE_IDS = UPGRADES.map(u => u.id).sort();
const WORLD_CARD_IDS = WORLD_CARDS.map(w => w.id).sort();

const CHAOS_CARD_INDEX = new Map(CHAOS_CARD_IDS.map((id, i) => [id, i]));
const UPGRADE_INDEX = new Map(UPGRADE_IDS.map((id, i) => [id, i]));
const WORLD_CARD_INDEX = new Map(WORLD_CARD_IDS.map((id, i) => [id, i]));

// Quick lookup: is a chaos card a magic-symbol card?
const MAGIC_SYMBOL_CARDS = new Set(CHAOS_CARDS.filter(c => c.hasMagicSymbol).map(c => c.id));

// Persistent chaos cards whose region-level effect changes the game enough to
// be worth a dedicated binary feature. Order is fixed (sorted) so the column
// indices are stable across builds.
export const PERSISTENT_EFFECT_IDS: string[] = [
  'gormen_deaths_perfume',
  'gormen_pestilent_aura',
  'lasha_ecstasy',
  'lasha_hollow_pact',
  'tenzen_changer_of_fate',
  'tenzen_persistence_matrix',
  'tenzen_stasis_web',
  'xarm_bloody_rebirth',
  'xarm_carnage_trap',
  'xarm_ritual_death',
  'xarm_the_red_throne',
  'xarm_war_cry',
];

const DIAL_MAX: Record<Power, number> = {
  xarm: 9, gormen: 10, tenzen: 8, lasha: 7,
};

// ── Dim calculations ─────────────────────────────────────────────────────────

const GLOBAL_DIMS = 4;
// round/10, ruination_cards_used/5, world_slot1_filled, world_slot2_filled

// Per-power: basic stats + upgrade one-hot
const PER_POWER_BASIC = 14;
// vp, dialPos, dialCounters, pp, basePP, hand, deck, discard,
// figuresOnBoard, figuresReserve, cultistCount, warriorCount, incarnationCount, passedSummoning

const UPGRADE_COUNT = UPGRADE_IDS.length;
const PER_POWER = PER_POWER_BASIC + UPGRADE_COUNT;

// Per-region: region-level + per-power breakdown + card slots + token counts + magic symbols + persistent effects
const REGION_BASIC = 5;
// resistance, conquestValue, populous, ruined, ruinationCardIndex
const PER_REGION_PER_POWER = 5;
// corruption, totalFigures, cultistCount, warriorCount, incarnationCount
const CARD_SLOT_DIMS = 2 * (1 + POWERS.length); // 2 slots × (filled + playedBy_onehot)
const TOKEN_DIMS = TOKEN_TYPES.length;
const MAGIC_SYMBOL_DIMS = 1; // single per-region count of magic-symbol cards
const PERSISTENT_EFFECT_DIMS = PERSISTENT_EFFECT_IDS.length; // 12 binary flags per region
const PER_REGION =
  REGION_BASIC +
  POWERS.length * PER_REGION_PER_POWER +
  CARD_SLOT_DIMS +
  TOKEN_DIMS +
  MAGIC_SYMBOL_DIMS +
  PERSISTENT_EFFECT_DIMS;

// World track one-hot (both slots concatenated)
const WORLD_TRACK_DIMS = 2 * WORLD_CARD_IDS.length;

export const FEATURE_DIM =
  GLOBAL_DIMS + POWERS.length * PER_POWER + REGION_ORDER.length * PER_REGION + WORLD_TRACK_DIMS;

// ── Extractor ────────────────────────────────────────────────────────────────

export function extractFeatures(state: GameState): Float32Array {
  const out = new Float32Array(FEATURE_DIM);
  let i = 0;

  // ── Global ──────────────────────────────────────────────────────────────
  out[i++] = state.round / 10;
  out[i++] = state.ruinationCardsUsed / 5;
  out[i++] = state.worldTrack.slot1 !== null ? 1 : 0;
  out[i++] = state.worldTrack.slot2 !== null ? 1 : 0;

  // ── Per power ───────────────────────────────────────────────────────────
  for (const p of POWERS) {
    const ps = state.powers[p];
    if (!ps) { i += PER_POWER; continue; }

    out[i++] = ps.victoryPoints / 60;
    out[i++] = ps.dialPosition / DIAL_MAX[p];
    out[i++] = Math.min(ps.dialCounters / 3, 1);
    out[i++] = Math.min(ps.powerPoints / 10, 1);
    out[i++] = Math.min(ps.basePowerPoints / 10, 1);
    out[i++] = Math.min(ps.hand.length / 8, 1);
    out[i++] = Math.min(ps.deckIds.length / 20, 1);
    out[i++] = Math.min(ps.discardIds.length / 20, 1);

    const onBoard = ps.followers.filter(f => f.regionId !== null);
    const inReserve = ps.followers.length - onBoard.length;
    out[i++] = onBoard.length / 12;
    out[i++] = inReserve / 12;

    let cultist = 0, warrior = 0, incarnation = 0;
    for (const f of onBoard) {
      if (f.class === 'cultist') cultist++;
      else if (f.class === 'warrior') warrior++;
      else if (f.class === 'incarnation') incarnation++;
    }
    out[i++] = cultist / 8;
    out[i++] = warrior / 6;
    out[i++] = incarnation / 2;
    out[i++] = ps.passedSummoning ? 1 : 0;

    // Upgrade one-hot
    const upStart = i;
    for (let u = 0; u < UPGRADE_COUNT; u++) out[upStart + u] = 0;
    for (const upId of ps.upgradesInPlay) {
      const idx = UPGRADE_INDEX.get(upId);
      if (idx !== undefined) out[upStart + idx] = 1;
    }
    i += UPGRADE_COUNT;
  }

  // ── Per region ──────────────────────────────────────────────────────────
  for (const r of REGION_ORDER) {
    const region = state.regions[r];
    if (!region) { i += PER_REGION; continue; }

    // Use the LIVE resistance, not the stale field — this reflects pandemic,
    // ratmen tokens, raise_the_militia, etc.
    out[i++] = Math.min(getRegionResistance(state, r) / 10, 1);
    out[i++] = Math.min(region.conquestValue / 8, 1);
    out[i++] = region.populous ? 1 : 0;
    out[i++] = region.ruinationCardIndex !== null ? 1 : 0;
    out[i++] = region.ruinationCardIndex !== null ? region.ruinationCardIndex / 5 : 0;

    // Per-power breakdown
    for (const p of POWERS) {
      out[i++] = Math.min((region.corruptionTokens[p] ?? 0) / 8, 1);
      const figs = region.placements.filter(f => (f.controlledBy ?? f.power) === p);
      out[i++] = Math.min(figs.length / 6, 1);
      let c = 0, w = 0, inc = 0;
      for (const f of figs) {
        if (f.class === 'cultist') c++;
        else if (f.class === 'warrior') w++;
        else if (f.class === 'incarnation') inc++;
      }
      out[i++] = c / 4;
      out[i++] = w / 3;
      out[i++] = inc / 2;
    }

    // Magic-symbol cards in this region (any power) — fuels tenzen's engine.
    // Max 2 since each region has 2 chaos card slots.
    let magicSymbols = 0;
    for (const card of region.chaosCards) {
      if (card && MAGIC_SYMBOL_CARDS.has(card.cardId)) magicSymbols++;
    }
    out[i++] = magicSymbols / 2;

    // Persistent strategically-significant effect flags. Each is 1 if any
    // chaos card in this region matches the cardId, else 0. Order is fixed
    // by PERSISTENT_EFFECT_IDS.
    for (const effectId of PERSISTENT_EFFECT_IDS) {
      let active = 0;
      for (const card of region.chaosCards) {
        if (card && card.cardId === effectId) { active = 1; break; }
      }
      out[i++] = active;
    }

    // Chaos card slots: filled flag + playedBy one-hot
    for (let slot = 0; slot < 2; slot++) {
      const card = region.chaosCards[slot] ?? null;
      out[i++] = card !== null ? 1 : 0;
      for (const p of POWERS) {
        out[i++] = card?.playedBy === p ? 1 : 0;
      }
    }

    // Token counts
    for (const t of TOKEN_TYPES) {
      out[i++] = Math.min(region.tokens.filter(x => x === t).length / 3, 1);
    }
  }

  // ── World track (one-hot per slot) ──────────────────────────────────────
  const slot1Start = i;
  for (let k = 0; k < WORLD_CARD_IDS.length; k++) out[slot1Start + k] = 0;
  if (state.worldTrack.slot1) {
    const idx = WORLD_CARD_INDEX.get(state.worldTrack.slot1);
    if (idx !== undefined) out[slot1Start + idx] = 1;
  }
  i += WORLD_CARD_IDS.length;

  const slot2Start = i;
  for (let k = 0; k < WORLD_CARD_IDS.length; k++) out[slot2Start + k] = 0;
  if (state.worldTrack.slot2) {
    const idx = WORLD_CARD_INDEX.get(state.worldTrack.slot2);
    if (idx !== undefined) out[slot2Start + idx] = 1;
  }
  i += WORLD_CARD_IDS.length;

  return out;
}

export function powerIndex(power: Power): number {
  return POWERS.indexOf(power);
}

// Debug helper — ensures our dim math is right.
export function validateFeatureDim(): void {
  const s: GameState = {} as GameState;
  void s;
  // Actual check: extract from a real state and compare length.
  // Call this from scripts after createInitialState.
}

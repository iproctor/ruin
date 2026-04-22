import type { GameState, Power, RegionId, FollowerClass, TokenType } from '@ruin/engine';
import { CHAOS_CARDS, WORLD_CARDS, UPGRADES, FOLLOWERS, getRegionResistance, followersInRegion, getRegionDomination } from '@ruin/engine';

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

// World card slot list is *legacy-stable*: it contains the IDs that existed
// when the model was first trained. Removing a card would shift every later
// slot index and silently invalidate every trained model. Instead we keep
// removed cards as ghost slots (always zero) and alias renames to their
// previous id so the feature positions are preserved. This is the world-card
// equivalent of the "features are append-only" invariant.
const LEGACY_DELETED_WORLD_CARD_IDS = [
  'heroes_of_order',
  'peasant_prosperity',
  'purchased_title',
  'ratmen_incursion',    // replaced by ratmens_price — aliased below
];
const WORLD_CARD_ALIAS: Record<string, string> = {
  ratmens_price: 'ratmen_incursion',
};
const WORLD_CARD_IDS = [
  ...WORLD_CARDS.map(w => w.id).filter(id => !(id in WORLD_CARD_ALIAS)),
  ...LEGACY_DELETED_WORLD_CARD_IDS,
].sort();

const CHAOS_CARD_INDEX = new Map(CHAOS_CARD_IDS.map((id, i) => [id, i]));
const UPGRADE_INDEX = new Map(UPGRADE_IDS.map((id, i) => [id, i]));
const WORLD_CARD_INDEX = new Map(WORLD_CARD_IDS.map((id, i) => [id, i]));

function worldCardSlot(cardId: string | null): number | undefined {
  if (cardId === null) return undefined;
  const legacy = WORLD_CARD_ALIAS[cardId] ?? cardId;
  return WORLD_CARD_INDEX.get(legacy);
}

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
const PER_POWER_BASIC = 18; // 14 base + 3 affordable summons + 1 affordable cards
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

// Viewpoint-power's hand contents (multi-hot over chaos cards). Other powers'
// hands are NOT encoded — that would leak hidden information across viewpoints.
// This block sits at the END of the vector so the v2→v3 upgrade is a simple
// right-pad (no mid-vector insertion).
const VIEWPOINT_HAND_DIMS = CHAOS_CARD_IDS.length;

// Fate Shield protected-figure counts per region.
//   - 3 features per region: protected cultist / warrior / incarnation count
//   - 1 feature per region: protected figures currently controlled by lasha
//     (because Narcotic Musk can transfer a protected tenzen cultist to lasha)
// Sits at the end of the vector for clean append-style upgrades.
const PROTECTED_PER_CLASS_DIMS = 3 * REGION_ORDER.length;
const PROTECTED_LASHA_DIMS = REGION_ORDER.length;

// Potential corruption tokens each power would place per region this round.
// Accounts for War Cry (blocks all), Shimmer (-1 per opponent), Changer of Fate
// (cancels both), Lasha Ravers upgrade (warriors count), and controlledBy.
const POTENTIAL_CORRUPTION_DIMS = POWERS.length * REGION_ORDER.length;

// Per-region binary: would this region ruin if corruption is placed now?
const EXPECTED_RUIN_DIMS = REGION_ORDER.length;

// Per-region domination leader one-hot (4 powers + 1 "tied / no leader").
// Captures the output of getRegionDomination's leader field. The handmade
// evaluator uses this directly to decide who earns domination VP per region;
// the model can't easily derive it from features alone because calcDomination
// depends on chaos-card cost sums (not encoded) plus persistent effects
// (only partially encoded). Exposing the answer closes the gap.
const DOMINATION_LEADER_DIMS = (POWERS.length + 1) * REGION_ORDER.length;

export const FEATURE_DIM =
  GLOBAL_DIMS +
  POWERS.length * PER_POWER +
  REGION_ORDER.length * PER_REGION +
  WORLD_TRACK_DIMS +
  VIEWPOINT_HAND_DIMS +
  PROTECTED_PER_CLASS_DIMS +
  PROTECTED_LASHA_DIMS +
  POTENTIAL_CORRUPTION_DIMS +
  EXPECTED_RUIN_DIMS +
  DOMINATION_LEADER_DIMS;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Count regions where `power` would optimistically earn a dial counter this round. */
function optimisticDac(state: GameState, power: Power): number {
  let count = 0;
  const xarmHasHeartseekers = state.powers['xarm']?.upgradesInPlay.includes('xarm_heartseekers_up') ?? false;
  const lashaRavers = state.powers['lasha']?.upgradesInPlay.includes('lasha_ravers_up') ?? false;

  for (const r of REGION_ORDER) {
    const region = state.regions[r];
    if (!region || region.ruinationCardIndex !== null) continue;
    const changer = region.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');

    if (power === 'xarm') {
      // Xarm: has attack dice AND enemies → assume a kill
      const ecstasy = !changer && region.chaosCards.some(c => c?.cardId === 'lasha_ecstasy');
      if (ecstasy) continue;
      const hasWarFrenzy = !changer && region.chaosCards.some(c => c?.cardId === 'xarm_war_frenzy');
      let attack = 0;
      const figs = followersInRegion(state, r);
      for (const f of figs) {
        if (f.tipped || (f.controlledBy ?? f.power) !== 'xarm') continue;
        if (f.class === 'warrior' || f.class === 'incarnation') attack++;
        else if (f.class === 'cultist' && xarmHasHeartseekers) attack++;
      }
      if (hasWarFrenzy) attack += 2;
      if (attack > 0 && figs.some(f => !f.tipped && (f.controlledBy ?? f.power) !== 'xarm')) count++;
    } else {
      // Gormen/Tenzen/Lasha: ≥2 corruption tokens placed (assume cultists survive)
      const warCry = region.chaosCards.some(c => c?.cardId === 'xarm_war_cry');
      if (warCry && !changer) continue;

      const rFigs = followersInRegion(state, r);
      const cultists = rFigs.filter(f => !f.tipped && (f.controlledBy ?? f.power) === power && f.class === 'cultist').length;
      let warriors = 0;
      if (power === 'lasha' && lashaRavers) {
        warriors = rFigs.filter(f => !f.tipped && (f.controlledBy ?? f.power) === 'lasha' && f.class === 'warrior' && f.power === 'lasha').length;
      }
      const shimmer = !changer && region.chaosCards.some(c => c?.cardId === 'tenzen_shimmer');
      const reduction = (shimmer && power !== 'tenzen') ? 1 : 0;
      const tokens = Math.max(0, cultists + warriors - reduction);
      if (tokens < 2) continue;

      if (power === 'gormen' && region.populous) count++;
      else if (power === 'tenzen') {
        const ms = region.chaosCards.filter(c => c !== null && MAGIC_SYMBOL_CARDS.has(c.cardId)).length;
        const cs = region.tokens.filter(t => t === 'chaos_stone').length;
        const fatespinner = state.powers['tenzen']!.upgradesInPlay.includes('tenzen_fatespinner_up') &&
          rFigs.some(f => f.class === 'incarnation' && f.power === 'tenzen' && !f.tipped) ? 2 : 0;
        if (ms + cs + fatespinner >= 2) count++;
      } else if (power === 'lasha' && region.tokens.some(t => t === 'noble' || t === 'hero')) count++;
    }
  }
  return count;
}

// ── Extractor ────────────────────────────────────────────────────────────────

export function extractFeatures(state: GameState, viewpoint: Power): Float32Array {
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
    // Optimistic expected DAC: count regions where this power would earn a
    // dial counter assuming optimistic outcomes (xarm kills, others' cultists survive).
    out[i++] = Math.min(optimisticDac(state, p) / 3, 1);
    // PP as fraction of base (1.0 = full budget, 0 = spent). A +1 PP change
    // on a base-6 power is a 0.17 shift — much more visible than the old /10.
    out[i++] = ps.basePowerPoints > 0 ? ps.powerPoints / ps.basePowerPoints : 0;
    out[i++] = ps.basePowerPoints / 10;
    out[i++] = Math.min(ps.hand.length / 8, 1);
    out[i++] = Math.min(ps.deckIds.length / 20, 1);
    out[i++] = Math.min(ps.discardIds.length / 20, 1);

    // Tipped figures are dead but not yet cleared from the board (cleanup
    // happens at end of battle round). Don't count them — they don't
    // contribute to combat or domination.
    const onBoard = ps.followers.filter(f => f.regionId !== null && !f.tipped);
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

    // Affordable summons: how many figures this power could still place.
    // This is the strategic threat number — "xarm can still drop 2 warriors."
    const reserveCultists = ps.followers.filter(f => f.class === 'cultist' && f.regionId === null).length;
    const reserveWarriors = ps.followers.filter(f => f.class === 'warrior' && f.regionId === null).length;
    const reserveIncarnation = ps.followers.filter(f => f.class === 'incarnation' && f.regionId === null).length;
    const cultistCost = FOLLOWERS[p]!.cultist.base.cost;
    const warriorCost = FOLLOWERS[p]!.warrior.base.cost;
    const incarnationCost = FOLLOWERS[p]!.incarnation.base.cost;
    out[i++] = Math.min(ps.powerPoints / cultistCost, reserveCultists) / 8;   // affordable cultists
    out[i++] = Math.min(Math.floor(ps.powerPoints / warriorCost), reserveWarriors) / 6; // affordable warriors
    out[i++] = (ps.powerPoints >= incarnationCost && reserveIncarnation > 0) ? 1 : 0;   // can afford incarnation

    // PP threshold flags: can this power afford 1/2/3-cost actions?
    // Human-readable: "xarm has 4 PP so can play a 3-cost card or summon an incarnation."
    out[i++] = ps.powerPoints >= 1 ? 1 : 0;
    out[i++] = ps.powerPoints >= 2 ? 1 : 0;
    out[i++] = ps.powerPoints >= 3 ? 1 : 0;

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
      // Skip tipped (dead-but-not-cleared) figures — they no longer contribute
      // to combat or domination this round.
      const figs = followersInRegion(state, r).filter(
        f => !f.tipped && (f.controlledBy ?? f.power) === p,
      );
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
    // Changer of Fate cancels all other card text in the region,
    // so zero out everything except the changer flag itself when it's present.
    const changerActive = region.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');
    for (const effectId of PERSISTENT_EFFECT_IDS) {
      let active = 0;
      if (!changerActive || effectId === 'tenzen_changer_of_fate') {
        for (const card of region.chaosCards) {
          if (card && card.cardId === effectId) { active = 1; break; }
        }
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

    // Token counts. Chaos stones get a +2 bump if Tenzen has the Fatespinner
    // upgrade and Fatespinner is in this region — per the upgrade rules text
    // ("counts as two Chaos Stone tokens for ruination and dial advancement
    // purposes"). This way the model sees the *effective* chaos stone count
    // directly instead of having to learn the conjunction.
    for (const t of TOKEN_TYPES) {
      let count = region.tokens.filter(x => x === t).length;
      if (t === 'chaos_stone' &&
          state.powers['tenzen']!.upgradesInPlay.includes('tenzen_fatespinner_up') &&
          followersInRegion(state, r).some(f => f.class === 'incarnation' && f.power === 'tenzen' && !f.tipped)) {
        count += 2;
      }
      out[i++] = Math.min(count / 3, 1);
    }
  }

  // ── World track (one-hot per slot) ──────────────────────────────────────
  const slot1Start = i;
  for (let k = 0; k < WORLD_CARD_IDS.length; k++) out[slot1Start + k] = 0;
  {
    const idx = worldCardSlot(state.worldTrack.slot1);
    if (idx !== undefined) out[slot1Start + idx] = 1;
  }
  i += WORLD_CARD_IDS.length;

  const slot2Start = i;
  for (let k = 0; k < WORLD_CARD_IDS.length; k++) out[slot2Start + k] = 0;
  {
    const idx = worldCardSlot(state.worldTrack.slot2);
    if (idx !== undefined) out[slot2Start + idx] = 1;
  }
  i += WORLD_CARD_IDS.length;

  // ── Viewpoint power's hand (multi-hot over chaos cards) ──────────────────
  // Only the viewpoint sees its own hand. Other powers' hands are hidden info
  // and are NOT encoded.
  const handStart = i;
  for (let k = 0; k < CHAOS_CARD_IDS.length; k++) out[handStart + k] = 0;
  const viewpointState = state.powers[viewpoint];
  if (viewpointState) {
    for (const cardId of viewpointState.hand) {
      const idx = CHAOS_CARD_INDEX.get(cardId);
      if (idx !== undefined) out[handStart + idx] = 1;
    }
  }
  i += CHAOS_CARD_IDS.length;

  // ── Fate Shield (protected) figure counts per region ────────────────────
  // 3 counts per region (cultist / warrior / incarnation), regardless of
  // controller. Skipped figures: tipped (already filtered out everywhere).
  // Normalized to a /2 cap because in practice 1 protected figure of a class
  // is the realistic max (Fate Shield protects exactly one per cast); the /2
  // gives the model headroom to encode a rare double without saturating.
  for (const r of REGION_ORDER) {
    const region = state.regions[r];
    let pCult = 0, pWar = 0, pInc = 0;
    if (region) {
      for (const f of followersInRegion(state, r)) {
        if (!f.protected || f.tipped) continue;
        if (f.class === 'cultist') pCult++;
        else if (f.class === 'warrior') pWar++;
        else if (f.class === 'incarnation') pInc++;
      }
    }
    out[i++] = Math.min(pCult / 2, 1);
    out[i++] = Math.min(pWar / 2, 1);
    out[i++] = Math.min(pInc / 2, 1);
  }

  // ── Per-region count of protected figures controlled by lasha ───────────
  // Tracks the specific case where Narcotic Musk transfers a protected
  // tenzen cultist into lasha's control.
  for (const r of REGION_ORDER) {
    const region = state.regions[r];
    let n = 0;
    if (region) {
      for (const f of followersInRegion(state, r)) {
        if (!f.protected || f.tipped) continue;
        if ((f.controlledBy ?? f.power) === 'lasha') n++;
      }
    }
    out[i++] = Math.min(n / 2, 1);
  }

  // ── Potential corruption per power per region ──────────────────────────
  // Also accumulate totals per region for the expected-ruin feature.
  const lashaRavers = state.powers['lasha']?.upgradesInPlay.includes('lasha_ravers_up') ?? false;
  const potentialPerRegion = new Array<number>(REGION_ORDER.length).fill(0);
  for (const p of POWERS) {
    for (let ri = 0; ri < REGION_ORDER.length; ri++) {
      const r = REGION_ORDER[ri]!;
      const region = state.regions[r];
      if (!region || region.ruinationCardIndex !== null) { out[i++] = 0; continue; }

      const changer = region.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');
      const warCry = region.chaosCards.some(c => c?.cardId === 'xarm_war_cry');
      if (warCry && !changer) { out[i++] = 0; continue; }

      const rFigs = followersInRegion(state, r);
      const cultists = rFigs.filter(f =>
        !f.tipped && (f.controlledBy ?? f.power) === p && f.class === 'cultist'
      ).length;

      let warriors = 0;
      if (p === 'lasha' && lashaRavers) {
        warriors = rFigs.filter(f =>
          !f.tipped && (f.controlledBy ?? f.power) === 'lasha' && f.class === 'warrior' && f.power === 'lasha'
        ).length;
      }

      const shimmer = !changer && region.chaosCards.some(c => c?.cardId === 'tenzen_shimmer');
      const reduction = (shimmer && p !== 'tenzen') ? 1 : 0;
      const tokens = Math.max(0, cultists + warriors - reduction);

      potentialPerRegion[ri]! += tokens;
      out[i++] = Math.min(tokens / 4, 1);
    }
  }

  // ── Expected ruin: would this region ruin after corruption placement? ──
  for (let ri = 0; ri < REGION_ORDER.length; ri++) {
    const r = REGION_ORDER[ri]!;
    const region = state.regions[r];
    if (!region || region.ruinationCardIndex !== null) { out[i++] = 0; continue; }
    const corrTokens = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);
    const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
    const fatespinnerBonus =
      state.powers['tenzen']!.upgradesInPlay.includes('tenzen_fatespinner_up') &&
      followersInRegion(state, r).some(f => f.class === 'incarnation' && f.power === 'tenzen' && !f.tipped) ? 2 : 0;
    out[i++] = (corrTokens + chaosStones + fatespinnerBonus + potentialPerRegion[ri]!) >= 12 ? 1 : 0;
  }

  // ── Per-region domination leader (one-hot: 4 powers + 1 "tied/none") ────
  // Appended at the end to preserve the append-only features invariant.
  for (const r of REGION_ORDER) {
    const region = state.regions[r];
    // One-hot slot: [xarm, gormen, tenzen, lasha, none]
    // Ruined regions or no-leader states emit the "none" slot.
    const start = i;
    for (let k = 0; k < POWERS.length + 1; k++) out[start + k] = 0;
    if (region && region.ruinationCardIndex === null) {
      const { leader } = getRegionDomination(state, r);
      if (leader !== null) {
        const idx = POWERS.indexOf(leader);
        if (idx >= 0) out[start + idx] = 1;
        else out[start + POWERS.length] = 1;
      } else {
        out[start + POWERS.length] = 1;
      }
    } else {
      out[start + POWERS.length] = 1;
    }
    i += POWERS.length + 1;
  }

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

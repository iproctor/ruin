import type { Action, FollowerClass, GameState, Power, RegionId } from '@ruin/engine';
import { CHAOS_CARDS } from '@ruin/engine';
import { REGION_ORDER } from './features.js';

/**
 * Canonical action enumeration for the policy head.
 *
 * Only `summoning_action` actions are canonicalized — that's where the action
 * space is huge and a policy head matters most. Other ActionKinds (battle hit
 * assignment, dial rewards, etc.) keep using UCB1 with no policy prior.
 *
 * Slot layout (acting power is implicit — the model uses the viewpoint hand
 * features and per-power state to know whose turn it is):
 *
 *   [0 .. 27)         summon_figure: (followerClass × region) — 3 × 9 = 27
 *   [27 .. 297)       play_card:     (cardId × region)        — 30 × 9 = 270
 *   [297]             pass                                    — 1
 *
 *   Total: 298 slots
 *
 * Multiple legal actions can map to the same slot (e.g. summoning any of
 * three reserve cultists into mittelreich = same canonical slot). The
 * inverseCanonicalAction function picks one concrete action per slot.
 */

export const FOLLOWER_CLASSES: FollowerClass[] = ['cultist', 'warrior', 'incarnation'];

// Sorted card ids — must match the ordering used in features.ts so models
// stay aligned. CHAOS_CARDS already lives in the engine.
export const CHAOS_CARD_IDS: string[] = CHAOS_CARDS.map(c => c.id).sort();
const CHAOS_CARD_INDEX = new Map(CHAOS_CARD_IDS.map((id, i) => [id, i]));
const REGION_INDEX = new Map(REGION_ORDER.map((id, i) => [id, i]));

const SUMMON_BLOCK = FOLLOWER_CLASSES.length * REGION_ORDER.length;       // 27
const CARD_BLOCK   = CHAOS_CARD_IDS.length * REGION_ORDER.length;         // 270
const PASS_INDEX   = SUMMON_BLOCK + CARD_BLOCK;                           // 297
export const ACTION_DIM = SUMMON_BLOCK + CARD_BLOCK + 1;                  // 298

/**
 * Map a legal summoning action to its canonical slot index.
 * Returns -1 for non-summoning actions or actions we can't canonicalize.
 */
export function canonicalActionIndex(action: Action, state?: GameState): number {
  if (action.kind === 'summoning_pass') return PASS_INDEX;

  if (action.kind === 'summoning_summon_figure') {
    const regionIdx = REGION_INDEX.get(action.toRegion);
    if (regionIdx === undefined) return -1;
    // Action stores followerId, not class. We need the class — derive from
    // the followerId (which has the form `${power}_${class}_${n}`) or look
    // up via state.
    let cls: FollowerClass | null = null;
    if (state) {
      const ps = state.powers[action.power];
      const f = ps?.followers.find(x => x.id === action.followerId);
      if (f) cls = f.class;
    }
    if (cls === null) {
      // Fallback: parse from id
      if (action.followerId.includes('_cultist_')) cls = 'cultist';
      else if (action.followerId.includes('_warrior_')) cls = 'warrior';
      else if (action.followerId.includes('_incarnation_')) cls = 'incarnation';
    }
    if (cls === null) return -1;
    const classIdx = FOLLOWER_CLASSES.indexOf(cls);
    return classIdx * REGION_ORDER.length + regionIdx;
  }

  if (action.kind === 'summoning_play_card') {
    const regionIdx = REGION_INDEX.get(action.toRegion);
    if (regionIdx === undefined) return -1;
    const cardIdx = CHAOS_CARD_INDEX.get(action.cardId);
    if (cardIdx === undefined) return -1;
    return SUMMON_BLOCK + cardIdx * REGION_ORDER.length + regionIdx;
  }

  return -1;
}

/**
 * Build a length-ACTION_DIM legality mask. Iterates the legal action set
 * and marks every reachable canonical slot.
 */
export function buildLegalMask(state: GameState, legalActions: Action[]): Uint8Array {
  const mask = new Uint8Array(ACTION_DIM);
  for (const a of legalActions) {
    const idx = canonicalActionIndex(a, state);
    if (idx >= 0) mask[idx] = 1;
  }
  return mask;
}

/**
 * Given a chosen canonical slot, pick a concrete legal Action that fills it.
 * Returns null if no legal action maps to that slot in the given state.
 *
 * For summon slots (multiple reserve followers of the same class are
 * interchangeable), picks the first matching one. Same for card plays where
 * multiple slots/regions could share the canonical index.
 */
export function inverseCanonicalAction(
  slot: number,
  state: GameState,
  legalActions: Action[],
): Action | null {
  for (const a of legalActions) {
    if (canonicalActionIndex(a, state) === slot) return a;
  }
  return null;
}

/** For diagnostics: human-readable label for a canonical slot. */
export function describeSlot(slot: number): string {
  if (slot === PASS_INDEX) return 'pass';
  if (slot < SUMMON_BLOCK) {
    const classIdx = Math.floor(slot / REGION_ORDER.length);
    const regionIdx = slot % REGION_ORDER.length;
    return `summon ${FOLLOWER_CLASSES[classIdx]} → ${REGION_ORDER[regionIdx]}`;
  }
  const cardSlot = slot - SUMMON_BLOCK;
  const cardIdx = Math.floor(cardSlot / REGION_ORDER.length);
  const regionIdx = cardSlot % REGION_ORDER.length;
  return `play ${CHAOS_CARD_IDS[cardIdx]} → ${REGION_ORDER[regionIdx]}`;
}

/**
 * Convenience: count of legal actions encoded by the canon for one state.
 * Used for sanity checks during data collection.
 */
export function countLegalSlots(state: GameState, legalActions: Action[]): number {
  let n = 0;
  const seen = new Set<number>();
  for (const a of legalActions) {
    const idx = canonicalActionIndex(a, state);
    if (idx >= 0 && !seen.has(idx)) {
      seen.add(idx);
      n++;
    }
  }
  return n;
}

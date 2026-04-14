/**
 * Obviously-good plays that should be made automatically before consulting MCTS.
 *
 * These are actions where the optimal play is deterministic and strictly
 * dominant — no board state makes them worse than not playing them. Burning
 * MCTS iterations on them wastes search budget and risks the value head
 * choosing a worse alternative.
 */

import type { GameState, Action, Power, RegionId } from '@ruin/engine';
import { followersInRegion, REGION_ORDER, CHAOS_CARDS } from '@ruin/engine';

/**
 * Returns an auto-play action if one exists, or null to fall back to MCTS.
 *
 * Currently handles:
 *   - Tenzen upgrade priority: Apprentices first (enables chaos-stone
 *     carrying → fast ruination), then Power of Fate (+1 PP/round).
 *   - Tenzen Siphon Power: 0-cost, steals 1 PP from each opponent with
 *     cultists in the region. Pick the region hitting the most opponents,
 *     breaking ties by highest total threat among hit opponents.
 */
export function getAutoPlay(state: GameState, power: Power): Action | null {
  if (power !== 'tenzen') return null;

  // Upgrade-choice forcing — lock in the Apprentices → +PP pick order so
  // MCTS doesn't wander into Fractals/Fatespinner early when the ruin
  // engine needs cultists-carrying-stones.
  if (state.pendingAction?.actionKind === 'upgrade_choice') {
    return bestTenzenUpgrade(state);
  }

  if (state.pendingAction?.actionKind !== 'summoning_action') return null;

  const hand = state.powers[power]?.hand;
  if (!hand || !hand.includes('tenzen_siphon_power')) return null;

  return bestSiphonPlay(state);
}

// Priority order for Tenzen's three dial upgrades.
// 1) Apprentices — cultists carry chaos stones into ruin targets.
// 2) Power of Fate — +1 PP/round, fuels more plays and summons.
// 3) Fatespinner — incarnation counts as 2 chaos stones for ruining.
// 4) Flood of Magic / Fractals — fallback.
const TENZEN_UPGRADE_PRIORITY: readonly string[] = [
  'tenzen_apprentices_up',
  'tenzen_power_of_fate',
  'tenzen_fatespinner_up',
  'tenzen_flood_of_magic',
  'tenzen_fractals_up',
];

function bestTenzenUpgrade(state: GameState): Action | null {
  const available = state.powers['tenzen']?.availableUpgradeIds ?? [];
  if (available.length === 0) return null;
  const pick = TENZEN_UPGRADE_PRIORITY.find(id => available.includes(id)) ?? available[0];
  if (!pick) return null;
  return { kind: 'upgrade_choice', power: 'tenzen' as Power, upgradeCardId: pick } as Action;
}

const ZERO_COST_CARD_IDS = new Set(
  CHAOS_CARDS.filter(c => c.power === 'tenzen' && c.cost === 0).map(c => c.id),
);

/**
 * When Tenzen has PP < 3 and 0-cost cards in hand, restrict legal actions
 * to only those 0-cost card plays. Forces Tenzen to flush cheap cards
 * (cycling the hand for better draws) before spending remaining PP on summons.
 *
 * Returns the filtered list, or the original list if the condition doesn't apply.
 */
export function forceZeroCostFlush(state: GameState, power: Power, actions: Action[]): Action[] {
  if (power !== 'tenzen') return actions;
  if (state.pendingAction?.actionKind !== 'summoning_action') return actions;

  const ps = state.powers[power];
  if (!ps || ps.powerPoints >= 3) return actions;

  // Does Tenzen have any 0-cost cards in hand?
  const hasZeroCost = ps.hand.some(c => ZERO_COST_CARD_IDS.has(c));
  if (!hasZeroCost) return actions;

  // Filter to only 0-cost card plays
  const zeroCostPlays = actions.filter(a =>
    a.kind === 'summoning_play_card' && ZERO_COST_CARD_IDS.has(a.cardId),
  );

  // If no legal 0-cost plays (all preconditions fail), fall back to full list
  return zeroCostPlays.length > 0 ? zeroCostPlays : actions;
}

function bestSiphonPlay(state: GameState): Action | null {
  type Candidate = { regionId: RegionId; opponents: number; threatSum: number };
  const candidates: Candidate[] = [];

  for (const regionId of REGION_ORDER) {
    const region = state.regions[regionId];
    if (!region) continue;
    if (region.ruinationCardIndex !== null) continue;

    // Siphon needs a card slot
    if (region.chaosCards.every(c => c !== null)) continue;

    // Count opponents with cultists in this region who have PP to steal
    let opponents = 0;
    let threatSum = 0;
    for (const p of state.activePowers) {
      if (p === 'tenzen') continue;
      const hasCultist = followersInRegion(state, regionId, p).some(f => f.class === 'cultist');
      if (hasCultist && state.powers[p]!.powerPoints > 0) {
        opponents++;
        threatSum += state.powers[p]!.threatValue;
      }
    }

    if (opponents > 0) {
      candidates.push({ regionId, opponents, threatSum });
    }
  }

  if (candidates.length === 0) return null;

  // Best: most opponents hit, then highest total threat (hurt the leaders)
  candidates.sort((a, b) => b.opponents - a.opponents || b.threatSum - a.threatSum);
  const best = candidates[0]!;

  // Find the first open slot
  const region = state.regions[best.regionId]!;
  const slotIndex = region.chaosCards[0] === null ? 0 : 1;

  return {
    kind: 'summoning_play_card',
    power: 'tenzen' as Power,
    cardId: 'tenzen_siphon_power',
    toRegion: best.regionId,
    slotIndex,
  } as Action;
}

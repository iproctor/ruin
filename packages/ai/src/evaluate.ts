import type { GameState, Power, RegionId } from '@ruin/engine';
import { REGIONS, getRegionDomination, getRegionResistance, getPowerDomination } from '@ruin/engine';

// Region IDs for iterating over the board
const ALL_REGIONS: RegionId[] = [
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

// Sum of all base region values
const TOTAL_BASE_CONQUEST = ALL_REGIONS.reduce(
  (sum, r) => sum + (REGIONS[r]?.baseValue ?? 0),
  0,
); // = 21

// Maximum figures any power can field
const MAX_FIGURES: Record<Power, number> = {
  xarm:   11,
  gormen: 12,
  tenzen: 12,
  lasha:  10,
};

// Actual dial lengths per power
const MAX_DIAL_POSITIONS: Record<Power, number> = {
  xarm:   9,
  gormen: 10,
  tenzen: 8,
  lasha:  7,
};

// Ruination threshold
const RUINATION_THRESHOLD = 12;

// Corruption level at which a region is "ripe" for lasha to sneak into
const LASHA_SNEAK_THRESHOLD = 7;

/**
 * Evaluate the game state from `power`'s perspective.
 * Returns a score in [0, 1] where 1 is best for `power`.
 */
export function evaluateState(state: GameState, power: Power): number {
  if (state.winners !== null) {
    return state.winners.includes(power) ? 1.0 : 0.0;
  }

  const ps = state.powers[power];
  if (ps === undefined) return 0.0;

  const myVP = ps.victoryPoints;

  // ── VP progress ───────────────────────────────────────────────────────────
  const vpProgress = Math.min(myVP / 50, 1.0);

  // ── VP relative lead ──────────────────────────────────────────────────────
  let maxOpponentVP = 0;
  for (const p of state.activePowers) {
    if (p === power) continue;
    const opVP = state.powers[p]?.victoryPoints ?? 0;
    if (opVP > maxOpponentVP) maxOpponentVP = opVP;
  }
  const vpLeadScore = Math.max(0, Math.min((myVP - maxOpponentVP + 50) / 100, 1.0));

  // ── Power points advantage ────────────────────────────────────────────────
  // Having more PP than opponents means you can act without them being able to
  // react — a tempo advantage. Normalise against max possible PP (~8-10).
  const myPP = ps.powerPoints;
  let maxOppPP = 0;
  for (const p of state.activePowers) {
    if (p === power) continue;
    const oppPP = state.powers[p]?.powerPoints ?? 0;
    if (oppPP > maxOppPP) maxOppPP = oppPP;
  }
  const ppAdvantage = Math.max(0, myPP - maxOppPP);
  const ppScore = Math.min(ppAdvantage / 6, 1.0);

  // ── Figures on board ──────────────────────────────────────────────────────
  const figuresOnBoard = ps.followers.filter(f => f.regionId !== null).length;
  const figureScore = figuresOnBoard / MAX_FIGURES[power];

  // ── Threat dial ───────────────────────────────────────────────────────────
  const maxPos = MAX_DIAL_POSITIONS[power];
  const dialFraction = (ps.dialPosition + Math.min(ps.dialCounters / 3, 0.9)) / maxPos;
  const dialScore = Math.min(dialFraction, 1.0);

  // ── Power-specific strategy ───────────────────────────────────────────────
  if (power === 'lasha') {
    return evaluateLasha(state, ps, vpProgress, vpLeadScore, figureScore, dialScore, ppScore);
  }
  if (power === 'xarm') {
    return evaluateXarm(state, ps, vpProgress, vpLeadScore, dialScore, ppScore);
  }
  if (power === 'gormen') {
    return evaluateGormen(state, ps, vpProgress, vpLeadScore, dialScore, ppScore);
  }

  // ── Domination control ────────────────────────────────────────────────────
  let dominationValue = 0;
  let pressureValue = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region || region.ruinationCardIndex !== null) continue;

    const nobles = region.tokens.filter(t => t === 'noble').length;
    const conquestValue = region.baseValue + nobles;
    const resistance = getRegionResistance(state, regionId);

    const { leader } = getRegionDomination(state, regionId);
    if (leader === power) dominationValue += conquestValue;

    const myDom = getPowerDomination(state, regionId, power);
    if (myDom > 0) {
      let maxOppDom = 0;
      for (const p of state.activePowers) {
        if (p === power) continue;
        const oppDom = getPowerDomination(state, regionId, p);
        if (oppDom > maxOppDom) maxOppDom = oppDom;
      }
      if (myDom >= maxOppDom) {
        pressureValue += Math.min(myDom / Math.max(resistance, 1), 1.2) * conquestValue;
      }
    }
  }

  const dominationScore = Math.min(dominationValue / TOTAL_BASE_CONQUEST, 1.0);
  const pressureScore = Math.min(pressureValue / TOTAL_BASE_CONQUEST, 1.0);

  // ── Ruination proximity ───────────────────────────────────────────────────
  let ruinationProximity = 0;
  let myCorruptionInPopulous = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region || region.ruinationCardIndex !== null) continue;
    if (!region.populous) continue;

    const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);
    const myCorr = region.corruptionTokens[power] ?? 0;
    ruinationProximity += Math.min(totalCorr / RUINATION_THRESHOLD, 1.0);
    myCorruptionInPopulous += myCorr;
  }

  const ruinationScore =
    0.5 * Math.min(ruinationProximity / 4, 1.0) +
    0.5 * Math.min(myCorruptionInPopulous / 12, 1.0);

  // ── Tenzen: magic-symbol card engine bonus ────────────────────────────────
  let magicCount = 0;
  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) continue;
    for (const card of region.chaosCards) {
      if (
        card?.playedBy === power &&
        (
          card.cardId === 'tenzen_changer_of_fate' ||
          card.cardId === 'tenzen_stasis_web' ||
          card.cardId === 'tenzen_persistence_matrix' ||
          card.cardId === 'tenzen_shimmer'
        )
      ) magicCount++;
    }
  }
  const tenzenCardScore = Math.min(magicCount / 6, 1.0);

  const raw =
    0.26 * vpProgress +
    0.17 * vpLeadScore +
    0.21 * dominationScore +
    0.11 * pressureScore +
    0.10 * ruinationScore +
    0.06 * dialScore +
    0.05 * ppScore +
    0.02 * figureScore +
    0.02 * tenzenCardScore;

  return Math.max(0.0, Math.min(1.0, raw));
}

/**
 * Lasha-specific evaluation.
 *
 * Lasha's strategy is to sneak corruption tokens into regions that are about
 * to ruin (via Depraved Infiltration), and to disrupt opponent domination in
 * those regions (via Hollow Pact / Narcotic Musk) so the ruination fires
 * without rewarding the opponent with domination VP first.
 *
 * Key signals:
 *  - Having corruption tokens in regions that are near or past ruination
 *  - The quality of those tokens: being the top or second-place holder
 *  - Having disruption cards (Hollow Pact) in contested high-corruption regions
 *  - Generic VP/lead/dial components still matter
 */
function evaluateLasha(
  state: GameState,
  ps: NonNullable<GameState['powers'][Power]>,
  vpProgress: number,
  vpLeadScore: number,
  figureScore: number,
  dialScore: number,
  ppScore: number,
): number {
  // ── Ruination participation score ─────────────────────────────────────────
  // Reward having corruption tokens in regions near or past ruination.
  // Being a top-2 holder in a high-corruption region is lasha's core win condition.
  let participationScore = 0;
  let disruptionScore = 0;
  let ruinedParticipation = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) continue;

    const myCorr = region.corruptionTokens['lasha'] ?? 0;
    const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);

    if (region.ruinationCardIndex !== null) {
      // Already ruined: every round scores VP based on token position.
      // Reward for having tokens here, weighted by our share.
      if (myCorr > 0 && totalCorr > 0) {
        const myShare = myCorr / totalCorr;
        // Check if we're first or second
        const sorted = [...state.activePowers].sort(
          (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0)
        );
        const myRank = sorted.indexOf('lasha');
        const rankBonus = myRank === 0 ? 1.0 : myRank === 1 ? 0.6 : 0.2;
        ruinedParticipation += rankBonus * Math.min(myShare * 2, 1.0);
      }
    } else if (totalCorr >= LASHA_SNEAK_THRESHOLD) {
      // Region is ripe for ruination — reward having a stake here.
      if (myCorr > 0) {
        const proximity = Math.min(totalCorr / RUINATION_THRESHOLD, 1.0);
        const myShare = myCorr / totalCorr;
        // Even 1-2 tokens is valuable if we get first/second
        const sorted = [...state.activePowers].sort(
          (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0)
        );
        const myRank = sorted.indexOf('lasha');
        const rankBonus = myRank === 0 ? 1.0 : myRank === 1 ? 0.7 : 0.3;
        participationScore += proximity * rankBonus * Math.min(myShare * 3, 1.0);
      }
    }

    // ── Disruption score: Hollow Pact in contested regions ───────────────────
    // Hollow Pact spoils opponent domination; best used where opponent is
    // about to score AND region is near ruination (so ruination fires instead).
    for (const card of region.chaosCards) {
      if (card?.playedBy === 'lasha' && card.cardId === 'lasha_hollow_pact') {
        // Value disruption more if opponents have significant presence here
        const oppFigures = region.placements.filter(
          f => (f.controlledBy ?? f.power) !== 'lasha'
        ).length;
        if (oppFigures > 0) {
          disruptionScore += Math.min(oppFigures / 4, 1.0) *
            Math.min((totalCorr + 1) / RUINATION_THRESHOLD, 1.0);
        }
      }
    }
  }

  // Normalise participation scores — max is all 9 regions scoring at 1.0
  const participationNorm = Math.min(participationScore / 3, 1.0);
  const ruinedNorm = Math.min(ruinedParticipation / 2, 1.0);
  const disruptionNorm = Math.min(disruptionScore / 3, 1.0);

  // Combine ruination signals: being in near-ruin regions matters most,
  // followed by already-ruined ongoing scoring.
  const ruinationComponent = 0.5 * participationNorm + 0.4 * ruinedNorm + 0.1 * disruptionNorm;

  // Lasha weights: ruination participation is primary.
  // PP advantage matters: extra PP means she can sneak Depraved Infiltration
  // into a region right before it ruins without opponents being able to react.
  const raw =
    0.26 * vpProgress +
    0.18 * vpLeadScore +
    0.33 * ruinationComponent +   // primary engine
    0.10 * ppScore +              // tempo: having PP when opponents don't
    0.08 * dialScore +
    0.05 * figureScore;

  return Math.max(0.0, Math.min(1.0, raw));
}

/**
 * Xarm-specific evaluation.
 *
 * Xarm wins by stacking high-attack figures in contested central regions and
 * farming dial counters from kills.  Every metric here flows from that premise:
 *
 *  1. Attack power in contested regions — the core kill engine.
 *     Heartseekers upgrade makes cultists (1 att / 1 PP) as efficient as
 *     warriors (2 att / 2 PP), so total attack dice is the key capacity metric.
 *  2. Dial progress — dial is the primary win path; weight it heavily.
 *  3. Domination of high-value central regions — secures VP between battles.
 *  4. Contested central positioning — being in mittelreich/almerida/normagne
 *     where the most valuable kills happen.
 *
 * Low weight given to PP advantage (xarm spends all PP each summoning phase
 * and doesn't benefit from tempo surplus the way lasha/tenzen do).
 */
function evaluateXarm(
  state: GameState,
  ps: NonNullable<GameState['powers'][Power]>,
  vpProgress: number,
  vpLeadScore: number,
  dialScore: number,
  ppScore: number,
): number {
  const hasHeartseekersUp = ps.upgradesInPlay.includes('xarm_heartseekers_up');

  // ── Attack power in contested regions ────────────────────────────────────
  // Sum all attack dice xarm can roll where enemies are present.
  // War Frenzy adds 2 free dice per region (even without xarm figures there).
  let totalAttack = 0;
  let contestedCentralFigs = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region || region.ruinationCardIndex !== null) continue;

    const myFigs = region.placements.filter(f => (f.controlledBy ?? f.power) === 'xarm');
    const hasEnemy = region.placements.some(f => (f.controlledBy ?? f.power) !== 'xarm');

    if (hasEnemy) {
      for (const fig of myFigs) {
        if (fig.class === 'cultist')     totalAttack += hasHeartseekersUp ? 1 : 0;
        else if (fig.class === 'warrior')     totalAttack += 2;
        else if (fig.class === 'incarnation') totalAttack += 4;
      }
      // War Frenzy fires even without xarm figures — treat as ~1.5 expected hits/region
      if (region.chaosCards.some(c => c?.cardId === 'xarm_war_frenzy')) totalAttack += 2;

      // Central-region bonus: weight contested presence by region value
      const baseVal = REGIONS[regionId]?.baseValue ?? 1;
      if (baseVal >= 3) contestedCentralFigs += myFigs.length * baseVal;
    }
  }

  // Max realistic attack ~16 (incarnation 4 + 4 warriors 8 + cultists 4 + frenzy 4)
  const attackScore = Math.min(totalAttack / 14, 1.0);
  // Max central contested ~5 figs × val 5 = 25
  const centralScore = Math.min(contestedCentralFigs / 20, 1.0);

  // ── Domination of high-value regions ─────────────────────────────────────
  let dominationValue = 0;
  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region || region.ruinationCardIndex !== null) continue;
    const nobles = region.tokens.filter(t => t === 'noble').length;
    const { leader } = getRegionDomination(state, regionId);
    if (leader === 'xarm') dominationValue += region.baseValue + nobles;
  }
  const dominationScore = Math.min(dominationValue / TOTAL_BASE_CONQUEST, 1.0);

  // Dial is the primary win condition: advance it by kills → dial counters.
  // Weight it much higher than generic powers.
  const raw =
    0.20 * vpProgress +
    0.15 * vpLeadScore +
    0.18 * dialScore +        // was 0.01 — dial is a real win condition for xarm
    0.22 * attackScore +      // stacked attack dice in contested regions
    0.15 * centralScore +     // contested central positioning (mittelreich/almerida/normagne)
    0.08 * dominationScore +  // holding regions between battles
    0.02 * ppScore;

  return Math.max(0.0, Math.min(1.0, raw));
}

/**
 * Gormen-specific evaluation.
 *
 * Gormen wins through infection: spread cultists across many distinct regions
 * to maximize corruption placement, use Pandemic (-2 resistance) to dominate
 * cheaply, Pestilent Aura (corruption tokens = domination), Death's Perfume
 * (dominating → +2 corruption → ruination cascade). Provender of Rot scores
 * VP on every ruination everywhere, so gormen wants ALL regions to ruin.
 *
 * Key signals:
 *  - Cultist spread: cultists in many unique regions
 *  - Corruption depth: high own-corruption in near-ruin regions
 *  - Aura synergy: Pestilent Aura active where gormen has deep corruption
 *  - Pandemic leverage: enabling domination in high-resistance populous regions
 */
function evaluateGormen(
  state: GameState,
  ps: NonNullable<GameState['powers'][Power]>,
  vpProgress: number,
  vpLeadScore: number,
  dialScore: number,
  ppScore: number,
): number {
  // ── Cultist spread ────────────────────────────────────────────────────────
  const uniqueRegionsWithCultists = ALL_REGIONS.filter(regionId => {
    const region = state.regions[regionId];
    return region && region.placements.some(f => f.class === 'cultist' && f.power === 'gormen');
  }).length;
  const spreadScore = Math.min(uniqueRegionsWithCultists / 6, 1.0);

  // ── Corruption depth, domination, and card synergy ────────────────────────
  let depthScore = 0;
  let dominationValue = 0;
  let pandemicLeverage = 0;
  let auraScore = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) continue;

    const myCorr = region.corruptionTokens['gormen'] ?? 0;
    const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);

    if (region.ruinationCardIndex !== null) {
      if (myCorr > 0 && totalCorr > 0) {
        const sorted = [...state.activePowers].sort(
          (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0)
        );
        const myRank = sorted.indexOf('gormen');
        const rankBonus = myRank === 0 ? 1.0 : myRank === 1 ? 0.6 : 0.0;
        depthScore += rankBonus;
      }
    } else {
      const proximity = Math.min(totalCorr / RUINATION_THRESHOLD, 1.0);
      if (myCorr > 0) depthScore += proximity * Math.min(myCorr / 4, 1.0);

      const nobles = region.tokens.filter(t => t === 'noble').length;
      const { leader } = getRegionDomination(state, regionId);
      if (leader === 'gormen') dominationValue += region.baseValue + nobles;

      const hasPandemic = region.chaosCards.some(c => c?.cardId === 'gormen_pandemic');
      if (hasPandemic && region.populous) pandemicLeverage++;

      const hasAura = region.chaosCards.some(c => c?.cardId === 'gormen_pestilent_aura');
      if (hasAura && myCorr > 0) auraScore += Math.min(myCorr / 5, 1.0);
    }
  }

  const depthNorm = Math.min(depthScore / 4, 1.0);
  const dominationScore = Math.min(dominationValue / TOTAL_BASE_CONQUEST, 1.0);
  const pandemicScore = Math.min(pandemicLeverage / 3, 1.0);
  const auraNorm = Math.min(auraScore / 3, 1.0);

  const infectionScore = 0.35 * spreadScore + 0.35 * depthNorm + 0.20 * auraNorm + 0.10 * pandemicScore;

  const raw =
    0.26 * vpProgress +
    0.17 * vpLeadScore +
    0.30 * infectionScore +
    0.15 * dominationScore +
    0.06 * ppScore +
    0.06 * dialScore;

  return Math.max(0.0, Math.min(1.0, raw));
}

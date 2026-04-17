import type { GameState, Power, RegionId } from '@ruin/engine';
import { REGIONS, ADJACENCY, CHAOS_CARDS, THREAT_DIALS, RUINATION_CARDS, getRegionDomination, getRegionResistance, getPowerDomination, followersInRegion } from '@ruin/engine';
import { evaluateLearned, hasModel } from './learn/evaluator.js';

// If a learned model has been loaded (via loadModel in a server/script entry
// point), it takes over as the evaluator. The hand-tuned code below serves as
// the bootstrap evaluator for the first round of self-play data collection.

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

  // Power-specific handmade evaluators for early game. The learned model's
  // evaluation is too flat to guide MCTS effectively.
  // Env vars control cutoff rounds (0 = disabled).
  const tenzenCutoff = parseInt(process.env['TENZEN_EVAL_CUTOFF'] ?? '4', 10);
  if (power === 'tenzen' && tenzenCutoff > 0 && state.round <= tenzenCutoff) {
    return evaluateTenzen(state);
  }
  const gormenCutoff = parseInt(process.env['GORMEN_EVAL_CUTOFF'] ?? '0', 10);
  if (power === 'gormen' && gormenCutoff > 0 && state.round <= gormenCutoff) {
    return evaluateGormenHandmade(state);
  }

  if (hasModel()) {
    return evaluateLearned(state, power);
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
        const oppFigures = followersInRegion(state, regionId).filter(
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

    const figs = followersInRegion(state, regionId);
    const myFigs = figs.filter(f => (f.controlledBy ?? f.power) === 'xarm');
    const hasEnemy = figs.some(f => (f.controlledBy ?? f.power) !== 'xarm');

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
    return region && followersInRegion(state, regionId).some(f => f.class === 'cultist' && f.power === 'gormen');
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

// ─── Magic symbol card lookup ──────────────────────────────────────────────

const MAGIC_SYMBOL_CARD_IDS = new Set(
  CHAOS_CARDS.filter(c => c.hasMagicSymbol).map(c => c.id),
);

/**
 * Tenzen-specific evaluation.
 *
 * Projects discounted ruination VP per region based on cultist count,
 * corruption progress, and enemy figures. The evaluator fires at
 * start-of-round (after end phase), so chaos card slots are empty —
 * only persistent state (tokens, figures, corruption) is visible.
 * Card effects are handled by MCTS rollouts, not the evaluator.
 */
function evaluateTenzen(state: GameState): number {
  const ps = state.powers['tenzen']!;
  const hasFatespinner = ps.upgradesInPlay.includes('tenzen_fatespinner_up');
  const hasApprentices = ps.upgradesInPlay.includes('tenzen_apprentices_up');
  const xarmHasHeartseekers = state.powers['xarm']?.upgradesInPlay.includes('xarm_heartseekers_up') ?? false;

  const TIME_DISCOUNT = parseFloat(process.env['TENZEN_TIME_DISCOUNT'] ?? '0.8');
  const nextCard = RUINATION_CARDS[state.ruinationCardsUsed] ?? null;

  let projectedVP = 0;
  let ruinParticipation = 0;
  let totalCultistsOnBoard = 0;
  let dacRegions = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) continue;

    const myCorr = region.corruptionTokens['tenzen'] ?? 0;
    const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);

    if (region.ruinationCardIndex !== null) {
      if (myCorr > 0 && totalCorr > 0) {
        const sorted = [...state.activePowers].sort(
          (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0),
        );
        const rank = sorted.indexOf('tenzen');
        ruinParticipation += rank === 0 ? 1.0 : rank === 1 ? 0.6 : 0.2;
      }
      continue;
    }

    const rFigs = followersInRegion(state, regionId);
    const myCultists = rFigs.filter(
      f => !f.tipped && (f.controlledBy ?? f.power) === 'tenzen' && f.class === 'cultist',
    ).length;
    totalCultistsOnBoard += myCultists;

    if (myCultists === 0 && myCorr === 0) continue;

    const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
    const nobles = region.tokens.filter(t => t === 'noble').length;
    const conquestValue = region.baseValue + nobles;

    const fatespinnerHere = hasFatespinner &&
      rFigs.some(f => f.class === 'incarnation' && f.power === 'tenzen' && !f.tipped);
    const fatespinnerBonus = fatespinnerHere ? 2 : 0;
    const ruinContribution = totalCorr + chaosStones + fatespinnerBonus;
    const remaining = RUINATION_THRESHOLD - ruinContribution;

    // Enemy figures = expected cultist losses per round.
    let enemyDice = 0;
    for (const f of rFigs) {
      if (f.tipped) continue;
      const p = (f.controlledBy ?? f.power) as Power;
      if (p === 'tenzen') continue;
      if (f.class === 'incarnation') enemyDice += 3;
      else if (f.class === 'warrior') enemyDice += 2;
      else if (f.class === 'cultist' && p === 'xarm' && xarmHasHeartseekers) enemyDice += 1;
    }
    const expectedKills = enemyDice * 0.33;
    const effectiveCultists = Math.max(0, myCultists - expectedKills);

    // Project rounds to ruin.
    let roundsToRuin: number;
    if (remaining <= 0) {
      roundsToRuin = 0;
    } else if (effectiveCultists > 0) {
      roundsToRuin = remaining / effectiveCultists;
    } else {
      roundsToRuin = 20;
    }

    // VP from ruination: rank-based from the next ruination card.
    const sorted = [...state.activePowers].sort(
      (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0),
    );
    const rank = sorted.indexOf('tenzen');
    const vpEntry = nextCard?.endPhaseVP[regionId];
    const ruinVP = vpEntry
      ? (rank === 0 ? vpEntry.first : rank === 1 ? vpEntry.second : 0)
      : conquestValue;
    const ruinersBonus = nextCard ? nextCard.ruinersScore : 3;
    const totalRuinVP = ruinVP + (myCorr > 0 ? ruinersBonus : 0);
    const discountedRuinVP = totalRuinVP * Math.pow(TIME_DISCOUNT, roundsToRuin);

    // Domination VP (per-round income).
    const { leader } = getRegionDomination(state, regionId);
    const domVP = leader === 'tenzen' ? conquestValue : 0;

    // DAC: ≥2 cultists + ≥2 chaos stones (only tokens persist across rounds).
    let dacBonus = 0;
    if (myCultists >= 2 && chaosStones + fatespinnerBonus >= 2) {
      dacBonus = 3;
      dacRegions++;
    } else if (myCultists >= 2 && chaosStones + fatespinnerBonus >= 1) {
      dacBonus = 1;
    }

    // Cultist presence: each cultist has standalone value.
    const presenceValue = myCultists * 1.5;

    projectedVP += discountedRuinVP + domVP * 0.5 + dacBonus + presenceValue;
  }

  // Non-region scalars.
  // Dial is only valuable as a path to Apprentices upgrade.
  // Once obtained, further dial advancement is marginal.
  const needsApprentices = !hasApprentices;
  const apprenticeProgress = needsApprentices ? Math.min(ps.dialPosition / 4, 1.0) : 0;

  const vpProgress = Math.min(ps.victoryPoints / 50, 1.0);
  let maxOpponentVP = 0;
  let oppHandSum = 0;
  let oppCount = 0;
  for (const p of state.activePowers) {
    if (p === 'tenzen') continue;
    const opPS = state.powers[p];
    if (!opPS) continue;
    if (opPS.victoryPoints > maxOpponentVP) maxOpponentVP = opPS.victoryPoints;
    oppHandSum += opPS.hand.length;
    oppCount++;
  }
  const vpLeadScore = Math.max(0, Math.min((ps.victoryPoints - maxOpponentVP + 50) / 100, 1.0));
  const avgOppHand = oppCount > 0 ? oppHandSum / oppCount : 5;
  const handDepletionScore = Math.max(0, Math.min((5 - avgOppHand) / 5, 1.0));

  const regionScore = Math.min(projectedVP / 30, 1.0);
  const ruinScore = Math.min(ruinParticipation / 3, 1.0);
  const cultistScore = Math.min(totalCultistsOnBoard / 8, 1.0);

  const raw =
    0.40 * regionScore +
    0.10 * ruinScore +
    0.15 * vpProgress +
    0.07 * vpLeadScore +
    0.03 * handDepletionScore +
    0.05 * apprenticeProgress +
    0.07 * (hasApprentices ? 1 : 0) +
    0.10 * cultistScore +
    0.03 * Math.min(dacRegions / 2, 1.0);

  return Math.max(0.0, Math.min(1.0, raw));
}

/**
 * Gormen-specific handmade evaluator.
 *
 * Strategy (from guide):
 *   - VP is everything. Win by VP or don't win.
 *   - Spread corruption across multiple regions (don't put all eggs in one basket)
 *   - Dominate populous regions (high value + DAC trigger)
 *   - Get Provender of Rot ASAP (+3 VP per ruination anywhere)
 *   - Use cheap warriors (1 PP) to defend and kill enemy cultists
 *   - Don't chase dial — one tick per round is fine
 *   - Pestilent Aura + corruption tokens = domination without figures at risk
 *   - Pandemic (-2 resistance) enables domination of tough populous regions
 */
function evaluateGormenHandmade(state: GameState): number {
  const ps = state.powers['gormen']!;

  // ── Strategy: pick 2-3 populous/high-value regions, stack cultists +
  // warriors + corruption, dominate every round for steady VP, slowly ruin.
  // Don't spread thin. Warriors are cheap (1 PP) and essential for defense
  // and domination (+1 each).

  // ── Single pass: score each region as a "stronghold" ───────────────────
  // A stronghold is a non-ruined region where Gormen has concentrated force.
  // Score each region by how good a stronghold it is, then take the best 2-3.
  const regionScores: number[] = [];
  let ruinParticipation = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) { regionScores.push(0); continue; }

    const myCorr = region.corruptionTokens['gormen'] ?? 0;
    const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);

    // Already ruined: score by our ranking
    if (region.ruinationCardIndex !== null) {
      if (myCorr > 0 && totalCorr > 0) {
        const sorted = [...state.activePowers].sort(
          (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0),
        );
        const rank = sorted.indexOf('gormen');
        ruinParticipation += rank === 0 ? 1.0 : rank === 1 ? 0.6 : 0.2;
      }
      regionScores.push(0);
      continue;
    }

    const rFigs = followersInRegion(state, regionId);
    const myCultists = rFigs.filter(
      f => !f.tipped && (f.controlledBy ?? f.power) === 'gormen' && f.class === 'cultist',
    ).length;
    const myWarriors = rFigs.filter(
      f => !f.tipped && (f.controlledBy ?? f.power) === 'gormen' && f.class === 'warrior',
    ).length;
    const myTotal = myCultists + myWarriors;

    if (myTotal === 0 && myCorr === 0) { regionScores.push(0); continue; }

    const nobles = region.tokens.filter(t => t === 'noble').length;
    const conquestValue = region.baseValue + nobles;

    // Actual domination value (respects Hollow Pact, Aura, card costs, etc.)
    const myDom = getPowerDomination(state, regionId, 'gormen');

    // Base: region value × domination strength (superlinear)
    let score = conquestValue * Math.pow(myDom, 1.3);

    // Populous bonus: these are the money regions for domination VP + DAC
    if (region.populous) score *= 1.5;

    // Cultists are the corruption engine. Each cultist places 1 token per
    // round in populous (up to 3 — more is wasted since the DAC trigger caps
    // the useful contribution). Target formation: 3 cultists in a populous
    // region — that gets both the linear reward and a big shape bonus.
    const effectiveCultists = Math.min(myCultists, 3);
    score += effectiveCultists * conquestValue * 0.5;
    if (region.populous && myCultists >= 3) score += 4;

    // Warriors: small bonus only. They already count toward myDom above, so
    // a big extra reward here double-counts and steers play toward "stack
    // warriors" (which don't place corruption and don't ruin).
    score += myWarriors * conquestValue * 0.15;

    // Corruption already placed: progress toward ruination. The final tokens
    // are disproportionately valuable — they cash the stronghold into VP.
    if (myCorr > 0) {
      score += myCorr * 2;
      if (totalCorr >= 8) score += (totalCorr / 12) * conquestValue;
      if (totalCorr >= 10) score += conquestValue;           // near-ruin
    }

    // Pandemic: -2 resistance makes domination much easier
    const hasPandemic = region.chaosCards.some(c => c?.cardId === 'gormen_pandemic');
    if (hasPandemic && region.populous) score += 4;

    // Death's Perfume: +2 corruption on successful domination — the
    // stronghold accelerator. Cashing a 3-cultist populous region into a
    // ruin in ~2-3 rounds hinges on this card being in play there.
    const deathsPerfume = region.chaosCards.some(c => c?.cardId === 'gormen_deaths_perfume');
    if (deathsPerfume && myTotal > 0) score += 4;

    // Vile Consumption: at end of corruption phase, removes all Gormen figures
    // here and places floor(removed/2) corruption. Valuable only when the
    // burst actually triggers ruin — otherwise it destroys the stronghold.
    const vileConsumption = region.chaosCards.some(c => c?.cardId === 'gormen_vile_consumption');
    if (vileConsumption) {
      const burst = Math.floor(myTotal / 2);
      if (burst > 0 && totalCorr + burst >= 12) score += conquestValue * 1.5;
    }

    // Rain of Pus / Inevitable Rot in region
    const hasRot = region.chaosCards.some(c => c?.cardId === 'gormen_inevitable_rot');
    if (hasRot && myCorr > 0) score += 3;

    // War Cry penalty
    const warCry = region.chaosCards.some(c => c?.cardId === 'xarm_war_cry');
    const changer = region.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');
    if (warCry && !changer) score *= 0.3;

    regionScores.push(score);
  }

  // Take the top 3 stronghold scores — reward concentration over spread
  const sortedScores = [...regionScores].sort((a, b) => b - a);
  const top3 = sortedScores[0]! + sortedScores[1]! * 0.8 + sortedScores[2]! * 0.5;
  // Normalize: a great stronghold (4 figures in Mittelreich value 5) scores ~40
  const strongholdScore = Math.min(top3 / 60, 1.0);

  // Provender of Rot
  const hasProvender = ps.upgradesInPlay.includes('gormen_provender_of_rot');
  const provenderScore = hasProvender ? 1.0 : 0.0;

  // VP progress
  const vpProgress = Math.min(ps.victoryPoints / 50, 1.0);
  let maxOpponentVP = 0;
  for (const p of state.activePowers) {
    if (p === 'gormen') continue;
    const opVP = state.powers[p]?.victoryPoints ?? 0;
    if (opVP > maxOpponentVP) maxOpponentVP = opVP;
  }
  const vpLeadScore = Math.max(0, Math.min((ps.victoryPoints - maxOpponentVP + 50) / 100, 1.0));

  // Ruination participation (already ruined regions)
  const ruinScore = Math.min(ruinParticipation / 3, 1.0);

  // Warriors on board: small incentive only. Warriors already count toward
  // stronghold domination value; piling them on beyond that doesn't help
  // ruin (they don't place corruption).
  const warriorsOnBoard = ps.followers.filter(
    f => f.regionId !== null && f.class === 'warrior',
  ).length;
  const warriorScore = Math.min(warriorsOnBoard / 3, 1.0);

  // Cultists on board: the corruption engine. Target ~6 (two 3-cultist
  // strongholds).
  const cultistsOnBoard = ps.followers.filter(
    f => f.regionId !== null && f.class === 'cultist',
  ).length;
  const cultistScore = Math.min(cultistsOnBoard / 6, 1.0);

  const raw =
    0.30 * strongholdScore +   // concentrated force in 2-3 valuable regions
    0.20 * vpProgress +        // VP is everything
    0.10 * vpLeadScore +       // relative lead
    0.10 * ruinScore +         // position in ruined regions
    0.05 * warriorScore +      // small — warriors are already in stronghold via myDom
    0.10 * cultistScore +      // corruption engine — aim for 6 deployed
    0.10 * provenderScore +    // Provender of Rot
    0.05 * Math.min(ps.followers.filter(f => f.regionId !== null).length / 8, 1.0); // figures deployed

  return Math.max(0.0, Math.min(1.0, raw));
}

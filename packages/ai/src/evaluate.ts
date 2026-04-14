import type { GameState, Power, RegionId } from '@ruin/engine';
import { REGIONS, ADJACENCY, CHAOS_CARDS, THREAT_DIALS, getRegionDomination, getRegionResistance, getPowerDomination, followersInRegion } from '@ruin/engine';
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
  const tenzenCutoff = parseInt(process.env['TENZEN_EVAL_CUTOFF'] ?? '2', 10);
  if (power === 'tenzen' && tenzenCutoff > 0 && state.round <= tenzenCutoff) {
    return evaluateTenzen(state);
  }
  const gormenCutoff = parseInt(process.env['GORMEN_EVAL_CUTOFF'] ?? '2', 10);
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
 * Tenzen-specific evaluation for rounds 1-4.
 *
 * Strategy priorities (from strategy guide):
 *   1. Get 8 cultists on board, spread across regions for DAC flexibility
 *   2. Play 3-4 cards per turn — cycle the deck aggressively
 *   3. Don't waste PP on warriors/incarnation
 *   4. Get Apprentices upgrade ASAP (carry chaos stones)
 *   5. Set up DAC conditions: ≥2 cultists in regions with ≥2 magic+chaos
 *   6. Dominate and ruin where possible — both VP and dial are viable
 *   7. Use Stasis Web to protect regions, Teleport for repositioning
 */
function evaluateTenzen(state: GameState): number {
  const ps = state.powers['tenzen']!;
  const hasFatespinner = ps.upgradesInPlay.includes('tenzen_fatespinner_up');
  const hasApprentices = ps.upgradesInPlay.includes('tenzen_apprentices_up');
  const xarmHasHeartseekers = state.powers['xarm']?.upgradesInPlay.includes('xarm_heartseekers_up') ?? false;

  // ── Single pass over regions ───────────────────────────────────────────
  let cultistsOnBoard = 0;
  let safeCultists = 0;       // cultists NOT threatened by Xarm attack dice
  let threatenedCultists = 0; // cultists in regions where Xarm can attack
  let regionsWithCultists = 0;
  let dacReadyRegions = 0;
  let nearDacRegions = 0;
  let stoneCultistSynergy = 0;
  let stasisProtectedPiles = 0; // regions with Stasis Web + ≥2 cultists
  let dominationValue = 0;
  let ruinParticipation = 0;

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) continue;

    // Ruination participation (works on ruined regions too)
    const myCorr = region.corruptionTokens['tenzen'] ?? 0;
    const totalCorr = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);
    if (myCorr > 0) {
      if (region.ruinationCardIndex !== null) {
        const sorted = [...state.activePowers].sort(
          (a, b) => (region.corruptionTokens[b] ?? 0) - (region.corruptionTokens[a] ?? 0),
        );
        const rank = sorted.indexOf('tenzen');
        ruinParticipation += rank === 0 ? 1.0 : rank === 1 ? 0.6 : 0.2;
      } else {
        ruinParticipation += Math.min(totalCorr / 12, 1.0) * Math.min(myCorr / 4, 1.0);
      }
    }

    if (region.ruinationCardIndex !== null) continue;

    const rFigs = followersInRegion(state, regionId);
    const myCultists = rFigs.filter(
      f => !f.tipped && (f.controlledBy ?? f.power) === 'tenzen' && f.class === 'cultist',
    ).length;

    if (myCultists === 0) continue;

    cultistsOnBoard += myCultists;
    regionsWithCultists++;

    // ── Defense: is this region threatened by Xarm? ──────────────────────
    const hasStasis = region.chaosCards.some(c => c?.cardId === 'tenzen_stasis_web');
    const changer = region.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');
    const hasEcstasy = !changer && region.chaosCards.some(c => c?.cardId === 'lasha_ecstasy');

    let xarmAttack = 0;
    if (!hasEcstasy) {
      const hasWarFrenzy = !changer && region.chaosCards.some(c => c?.cardId === 'xarm_war_frenzy');
      if (hasWarFrenzy) xarmAttack += 2;
      for (const f of rFigs) {
        if (f.tipped || (f.controlledBy ?? f.power) !== 'xarm') continue;
        if (f.class === 'warrior' || f.class === 'incarnation') xarmAttack += 2;
        else if (f.class === 'cultist' && xarmHasHeartseekers) xarmAttack += 1;
      }
    }

    if (xarmAttack > 0) {
      threatenedCultists += myCultists;
    } else {
      safeCultists += myCultists;
    }

    // Stasis Web protecting a cultist pile is very valuable
    if (hasStasis && myCultists >= 2) stasisProtectedPiles++;

    // ── DAC readiness ────────────────────────────────────────────────────
    const warCry = region.chaosCards.some(c => c?.cardId === 'xarm_war_cry');
    if (!warCry || changer) {
      const magicSymbols = region.chaosCards.filter(
        c => c !== null && MAGIC_SYMBOL_CARD_IDS.has(c.cardId),
      ).length;
      const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
      const fatespinnerBonus = hasFatespinner &&
        rFigs.some(f => f.class === 'incarnation' && f.power === 'tenzen' && !f.tipped) ? 2 : 0;
      // Cap magic total at 2 — DAC threshold. Beyond 2 is redundant.
      const magicTotal = Math.min(magicSymbols + chaosStones + fatespinnerBonus, 2);

      // Reachability: Tenzen needs cultists here or adjacent to threaten this region.
      // Without reach, magic symbols/stones are wasted — no path to place corruption.
      const adjacent = ADJACENCY[regionId] ?? [];
      const hasReach = myCultists > 0 || adjacent.some(r => {
        const adj = state.regions[r];
        if (!adj) return false;
        return followersInRegion(state, r).some(
          f => !f.tipped && (f.controlledBy ?? f.power) === 'tenzen' && f.class === 'cultist',
        );
      });

      if (hasReach) {
        if (myCultists >= 2 && magicTotal >= 2) dacReadyRegions++;
        else if ((myCultists >= 2 && magicTotal >= 1) || (myCultists >= 1 && magicTotal >= 2)) nearDacRegions++;

        // Chaos stones near cultists — only useful in regions we can reach
        // AND when the region isn't already at the DAC threshold.
        if (chaosStones > 0 && magicTotal < 2) {
          stoneCultistSynergy += Math.min(myCultists / 2, 1);
        }
      }
    }

    // ── Domination ───────────────────────────────────────────────────────
    const nobles = region.tokens.filter(t => t === 'noble').length;
    const { leader } = getRegionDomination(state, regionId);
    if (leader === 'tenzen') dominationValue += region.baseValue + nobles;
  }

  // ── Composite scores ──────────────────────────────────────────────────

  // Cultists: safe cultists are worth full value, threatened ones half
  const effectiveCultists = safeCultists + threatenedCultists * 0.5;
  const cultistScore = Math.min(effectiveCultists / 8, 1.0);

  const spreadScore = Math.min(regionsWithCultists / 4, 1.0);

  // DAC engine — ready regions weighted higher, near-ready gives partial
  const dacScore = Math.min(dacReadyRegions / 3, 1.0) + 0.3 * Math.min(nearDacRegions / 3, 1.0);

  const stoneScore = Math.min(stoneCultistSynergy / 4, 1.0);

  // Defense: Stasis-protected piles are strongholds
  const defenseScore = Math.min(stasisProtectedPiles / 2, 1.0);

  // Threat penalty: fraction of cultists that are threatened
  const threatPenalty = cultistsOnBoard > 0
    ? (threatenedCultists / cultistsOnBoard) * 0.15
    : 0;

  const upgradeScore = hasApprentices ? 1.0 : 0.0;

  const maxDialPos = THREAT_DIALS['tenzen'].length - 1;
  const dialFraction = (ps.dialPosition + Math.min(ps.dialCounters / 3, 0.9)) / maxDialPos;
  const dialScore = Math.min(dialFraction, 1.0);

  const vpProgress = Math.min(ps.victoryPoints / 50, 1.0);
  let maxOpponentVP = 0;
  for (const p of state.activePowers) {
    if (p === 'tenzen') continue;
    const opVP = state.powers[p]?.victoryPoints ?? 0;
    if (opVP > maxOpponentVP) maxOpponentVP = opVP;
  }
  const vpLeadScore = Math.max(0, Math.min((ps.victoryPoints - maxOpponentVP + 50) / 100, 1.0));

  const dominationScore = Math.min(dominationValue / TOTAL_BASE_CONQUEST, 1.0);
  const ruinScore = Math.min(ruinParticipation / 3, 1.0);

  const fightingUnitsOnBoard = ps.followers.filter(
    f => f.regionId !== null && (f.class === 'warrior' || f.class === 'incarnation'),
  ).length;
  const noCombatPenalty = fightingUnitsOnBoard > 0 ? -0.03 * fightingUnitsOnBoard : 0;

  const raw =
    0.20 * dacScore +          // DAC-ready regions
    0.16 * cultistScore +      // effective cultists (safe > threatened)
    0.10 * spreadScore +       // cultists in many regions
    0.10 * defenseScore +      // Stasis-protected cultist piles
    0.08 * stoneScore +        // chaos stones near cultists
    0.07 * upgradeScore +      // Apprentices upgrade
    0.07 * dialScore +         // dial progress
    0.07 * vpProgress +        // VP progress
    0.05 * vpLeadScore +       // VP relative to opponents
    0.05 * dominationScore +   // current domination
    0.05 * ruinScore +         // ruination participation
    - threatPenalty +          // penalize exposed cultists
    noCombatPenalty;

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

    // Warriors add battle dice to defend the stronghold
    score += myWarriors * conquestValue * 0.5;

    // Exactly 2 cultists in a populous region = DAC trigger (2+ corruption
    // tokens placed in populous). Sweet spot — any more is over-investment.
    if (region.populous && myCultists === 2) score += 3;

    // Corruption already placed: progress toward ruination
    if (myCorr > 0) {
      score += myCorr * 2;
      // Near-ruin bonus: close to paying off
      if (totalCorr >= 8) score += (totalCorr / 12) * conquestValue;
    }

    // Pandemic: -2 resistance makes domination much easier
    const hasPandemic = region.chaosCards.some(c => c?.cardId === 'gormen_pandemic');
    if (hasPandemic && region.populous) score += 4;

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
  const hasProvender = ps.upgradesInPlay.includes('gormen_provender_up');
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

  // Warriors on board (cheap defense)
  const warriorsOnBoard = ps.followers.filter(
    f => f.regionId !== null && f.class === 'warrior',
  ).length;
  const warriorScore = Math.min(warriorsOnBoard / 3, 1.0);

  const raw =
    0.30 * strongholdScore +   // concentrated force in 2-3 valuable regions
    0.20 * vpProgress +        // VP is everything
    0.10 * vpLeadScore +       // relative lead
    0.10 * ruinScore +         // position in ruined regions
    0.10 * warriorScore +      // warriors for defense + domination
    0.10 * provenderScore +    // Provender of Rot
    0.10 * Math.min(ps.followers.filter(f => f.regionId !== null).length / 8, 1.0); // figures deployed

  return Math.max(0.0, Math.min(1.0, raw));
}

import type { GameState, Power, RegionId } from '../types.js';
import {
  REGION_ORDER, FOLLOWERS, UPGRADES, UPGRADE_BY_ID, RUINATION_CARDS, CARD_BY_ID,
  REGIONS, POWER_ORDER,
  CORRUPTION_RUIN_THRESHOLD, MAX_RUINATION_CARDS,
} from '../constants.js';
import {
  isWorldCardActive, isRuined, countToken,
  magicSymbolCount, totalCorruption, followersInRegion,
} from '../helpers.js';
import { GameLog } from '../gameLog.js';

// ─── Public helper ────────────────────────────────────────────────────────────

/**
 * Returns the power currently leading domination in a region, or null if the
 * region is ruined, nobody has any presence, or there is a tie for the lead.
 */
export function getRegionDominationLeader(state: GameState, regionId: RegionId): Power | null {
  return getRegionDomination(state, regionId).leader;
}

/** Returns the true current resistance for a region, accounting for all card/world-card effects. */
export function getRegionResistance(state: GameState, regionId: RegionId): number {
  const changerOfFateActive = state.regions[regionId]!.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');
  return calcResistance(state, regionId, changerOfFateActive);
}

/**
 * Returns the raw domination value for a specific power in a region.
 * Useful for AI evaluation: knowing HOW CLOSE a power is to winning a region.
 */
export function getPowerDomination(state: GameState, regionId: RegionId, power: Power): number {
  const region = state.regions[regionId]!;
  if (region.ruinationCardIndex !== null) return 0;
  const changerOfFateActive = regionCardActive(state, regionId, 'tenzen_changer_of_fate');
  return calcDomination(state, regionId, power, changerOfFateActive);
}

/**
 * Preview which non-Xarm powers would earn a Dial Advancement Counter in this
 * region if the upcoming corruption phase ran now with every current cultist
 * (and Musk-controlled cultist) surviving. Returned in standard POWER_ORDER.
 *
 * Accounts for:
 *   - Narcotic Musk (follower's `controlledBy`)
 *   - Lasha Ravers upgrade (warriors lay corruption as if cultists)
 *   - Tenzen Shimmer (one enemy cultist per region doesn't count)
 *   - Xarm War Cry (blocks all corruption in region)
 *   - Tenzen Changer of Fate (suspends region card effects)
 *   - Gormen Vile Consumption (adds floor(gormen-figs / 2) more corruption)
 *   - Tenzen Fatespinner upgrade (counts as 2 chaos stones for the condition)
 *
 * Xarm's DAC condition fires in the battle phase, not during corruption, so
 * Xarm is never returned.
 */
export function previewDialAdvancementEarners(
  state: GameState,
  regionId: RegionId,
): Power[] {
  const region = state.regions[regionId]!;
  if (isRuined(region)) return [];

  const changerOfFateActive = regionCardActive(state, regionId, 'tenzen_changer_of_fate');
  // War Cry blocks corruption (and therefore DAC earning), but Changer of
  // Fate cancels the text of every other card in the region — including
  // War Cry. Only honor War Cry when Changer of Fate is absent.
  if (!changerOfFateActive && regionCardActive(state, regionId, 'xarm_war_cry')) return [];

  const earners: Power[] = [];
  for (const power of POWER_ORDER) {
    if (power === 'xarm') continue;
    if (!state.activePowers.includes(power)) continue;

    let tokens = corruptionTokensToPlace(state, regionId, power, changerOfFateActive);

    if (power === 'gormen' && !changerOfFateActive &&
        regionCardActive(state, regionId, 'gormen_vile_consumption')) {
      const gormenFigures = followersInRegion(state, regionId).filter(f => f.power === 'gormen').length;
      tokens += Math.floor(gormenFigures / 2);
    }

    if (tokens < 2) continue;

    let qualifies = false;
    switch (power) {
      case 'gormen':
        qualifies = REGIONS[regionId]!.populous;
        break;
      case 'tenzen': {
        const magicCount = magicSymbolCount(state, regionId);
        const chaosStones = countToken(region, 'chaos_stone');
        const hasFatespinnerInRegion = followersInRegion(state, regionId)
          .some(f => f.class === 'incarnation' && f.power === 'tenzen');
        const fatespinnerBonus = hasFatespinnerInRegion &&
          state.powers['tenzen']!.upgradesInPlay.includes('tenzen_fatespinner_up') ? 2 : 0;
        qualifies = magicCount + chaosStones + fatespinnerBonus >= 2;
        break;
      }
      case 'lasha':
        qualifies = region.tokens.some(t => t === 'noble' || t === 'hero');
        break;
    }
    if (qualifies) earners.push(power);
  }
  return earners;
}

/** Returns the leading power and their domination value, or null if ruined/tied/zero. */
export function getRegionDomination(
  state: GameState,
  regionId: RegionId,
): { leader: Power | null; value: number } {
  const region = state.regions[regionId]!;
  if (region.ruinationCardIndex !== null) return { leader: null, value: 0 };
  const changerOfFateActive = regionCardActive(state, regionId, 'tenzen_changer_of_fate');
  const domValues = new Map<Power, number>();
  // Compute for all active powers, plus any power with a presence in the region
  // that might not be in activePowers (e.g. figures from card effects)
  const powersToCheck = new Set<Power>(state.activePowers);
  for (const f of followersInRegion(state, regionId)) {
    const p = (f.controlledBy ?? f.power) as Power;
    if (state.powers[p]) powersToCheck.add(p);
  }
  for (const slot of region.chaosCards) {
    if (slot && state.powers[slot.playedBy]) powersToCheck.add(slot.playedBy);
  }
  for (const power of powersToCheck) {
    domValues.set(power, calcDomination(state, regionId, power, changerOfFateActive));
  }
  const vals = Array.from(domValues.values());
  const maxDom = vals.length ? Math.max(...vals) : 0;
  if (maxDom === 0) return { leader: null, value: 0 };
  const resistance = calcResistance(state, regionId, changerOfFateActive);
  if (maxDom <= resistance) return { leader: null, value: 0 };
  const leaders = Array.from(powersToCheck).filter(p => domValues.get(p) === maxDom);
  return { leader: leaders.length === 1 ? leaders[0]! : null, value: maxDom };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function resolveCorruptionPhase(
  state: GameState,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s = state;

  // Snapshot corruption tokens BEFORE any phase work. Used at ruination time
  // to determine "ruiners" = anyone whose token count increased this round
  // (from any source: Heartrippers in battle, Depraved Infiltration in
  // summoning, Death's Perfume in domination, normal cultists, Plague Bloom).
  const corruptionSnapshot: Record<string, Record<Power, number>> = {};
  for (const regionId of REGION_ORDER) {
    corruptionSnapshot[regionId] = { ...s.regions[regionId]!.corruptionTokens };
  }

  // Step 1: Domination
  ({ state: s } = resolveDomination(s, log));

  // Step 2: Corruption placement + ruination checks
  ({ state: s } = resolveCorruption(s, log, corruptionSnapshot));

  s = { ...s, phase: 'end', pendingAction: null };
  return { state: s, log };
}

// ─── Step 1: Domination ────────────────────────────────────────────────────────

function resolveDomination(
  state: GameState,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;

    // Ruined regions skip domination
    if (isRuined(region)) continue;

    const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

    // Calculate domination value per power
    const domValues = new Map<Power, number>();
    for (const power of s.activePowers) {
      const val = calcDomination(s, regionId, power, changerOfFateActive);
      domValues.set(power, val);
    }

    // Find highest domination value
    const maxDom = Math.max(...domValues.values());
    if (maxDom === 0) continue;

    const leaders = s.activePowers.filter(p => domValues.get(p) === maxDom);
    if (leaders.length > 1) {
      const resistance = calcResistance(s, regionId, changerOfFateActive);
      log.emit({ type: 'domination_result', regionId, power: null, value: maxDom, resistance, conquered: false, vp: 0 });
      continue;
    }

    const winner = leaders[0]!;
    const resistance = calcResistance(s, regionId, changerOfFateActive);

    if (maxDom > resistance) {
      const conquestValue = calcConquestValue(s, regionId);
      s = log.apply(s, { type: 'domination_result', regionId, power: winner, value: maxDom, resistance, conquered: true, vp: conquestValue });

      // Gormen Death's Perfume: place 2 corruption tokens on domination
      if (!changerOfFateActive && winner === 'gormen' &&
          regionCardActive(s, regionId, 'gormen_deaths_perfume')) {
        s = log.apply(s, { type: 'deaths_perfume', regionId, tokens: 2 });
      }
    } else {
      log.emit({ type: 'domination_failed', regionId, power: winner, value: maxDom, resistance });
    }
  }

  return { state: s, log };
}

function calcDomination(
  state: GameState,
  regionId: RegionId,
  power: Power,
  changerOfFateActive: boolean,
): number {
  const region = state.regions[regionId]!;

  // Lasha Hollow Pact: enemy figures contribute 0 domination
  const hollowPact = !changerOfFateActive && regionCardActive(state, regionId, 'lasha_hollow_pact');

  // Sum of chaos card costs for this power
  let cardCostSum = 0;
  for (const slot of region.chaosCards) {
    if (slot === null) continue;
    if (slot.playedBy === power) {
      const def = CARD_BY_ID[slot.cardId];
      cardCostSum += def?.cost ?? 0;
    }
  }

  // Figure count
  const figures = followersInRegion(state, regionId, power);

  if (hollowPact && power !== 'lasha') {
    // Hollow Pact: enemies contribute 0 figures
    return cardCostSum; // only card costs, no figure contribution
  }

  let figureValue: number;

  // Xarm Altar: use sum of attack values instead of count
  const altarActive = !changerOfFateActive && regionCardActive(state, regionId, 'xarm_the_red_throne');
  if (altarActive && power === 'xarm') {
    figureValue = figures.reduce((sum, f) => {
      const def = FOLLOWERS[f.power as Power]![f.class]!;
      const isUpgraded = state.powers[f.power as Power]!.upgradesInPlay.some(u =>
        u && UPGRADES.find(up => up.id === u)?.upgradeType === f.class
      );
      // Heartgrinder upgrade: counts as 4 for domination (= attack 4)
      const atk = isUpgraded ? def.upgraded.attack : def.base.attack;
      return sum + atk;
    }, 0);
  } else {
    figureValue = figures.length;

    // Gormen Plaguebringers upgrade: each warrior counts as 2
    if (power === 'gormen' && state.powers['gormen']!.upgradesInPlay.includes('gormen_plaguebringers_up')) {
      const warriors = figures.filter(f => f.class === 'warrior' && f.power === 'gormen').length;
      const nonWarriors = figures.filter(f => !(f.class === 'warrior' && f.power === 'gormen')).length;
      figureValue = warriors * 2 + nonWarriors;
    }

    // Xarm Heartgrinder upgrade: single Heartgrinder counts as 4
    if (power === 'xarm' && state.powers['xarm']!.upgradesInPlay.includes('xarm_heartgrinder_up')) {
      const hasHeartgrinder = figures.some(f => f.class === 'incarnation' && f.power === 'xarm');
      if (hasHeartgrinder) {
        const others = figures.filter(f => !(f.class === 'incarnation' && f.power === 'xarm')).length;
        figureValue = 4 + others;
      }
    }
  }

  // Gormen Pestilent Aura: +1 per own corruption token
  let bonus = 0;
  if (!changerOfFateActive && power === 'gormen' && regionCardActive(state, regionId, 'gormen_pestilent_aura')) {
    bonus += region.corruptionTokens['gormen'] ?? 0;
  }

  // Lasha Sweet Deceit: +2 per Noble and Hero token
  if (!changerOfFateActive && power === 'lasha' && regionCardActive(state, regionId, 'lasha_sweet_lies')) {
    const nobles = region.tokens.filter(t => t === 'noble').length;
    const heroes = region.tokens.filter(t => t === 'hero').length;
    bonus += (nobles + heroes) * 2;
  }

  return cardCostSum + figureValue + bonus;
}

function calcResistance(
  state: GameState,
  regionId: RegionId,
  changerOfFateActive: boolean,
): number {
  const region = state.regions[regionId]!;
  let resistance = region.baseValue;

  // Ratmen tokens: -1 each
  const ratmen = region.tokens.filter(t => t === 'ratmen').length;
  resistance -= ratmen;

  // Gormen Epidemic: -2
  if (!changerOfFateActive && regionCardActive(state, regionId, 'gormen_pandemic')) {
    resistance -= 2;
  }

  // Fortification world card: +1 per peasant
  if (isWorldCardActive(state, 'raise_the_militia')) {
    const peasants = region.tokens.filter(t => t === 'peasant').length;
    resistance += peasants;
  }

  return Math.max(0, resistance);
}

function calcConquestValue(state: GameState, regionId: RegionId): number {
  const region = state.regions[regionId]!;
  let value = region.baseValue;

  // Noble tokens: +1 each
  const nobles = region.tokens.filter(t => t === 'noble').length;
  value += nobles;

  return value;
}

// ─── Step 2: Corruption placement + ruination ─────────────────────────────────

function resolveCorruption(
  state: GameState,
  log: GameLog,
  corruptionSnapshot: Record<string, Record<Power, number>>,
): { state: GameState; log: GameLog } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;

    // Ruined or scorched regions skip corruption placement
    if (isRuined(region)) continue;

    const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');
    // Changer of Fate cancels the text of every other card in the region —
    // when present, War Cry's no-corruption-placement clause is suppressed.
    if (!changerOfFateActive && regionCardActive(s, regionId, 'xarm_war_cry')) {
      log.emit({ type: 'war_cry_block', regionId });
      continue;
    }

    for (const power of s.activePowers) {
      const tokensToPlace = corruptionTokensToPlace(s, regionId, power, changerOfFateActive);
      if (tokensToPlace === 0) continue;

      s = log.apply(s, { type: 'corruption_placement', regionId, power, tokens: tokensToPlace });

      // Dial advancement counters
      s = checkDialAdvancement(s, regionId, power, tokensToPlace, changerOfFateActive, log);
    }

    // Gormen Plague Bloom: after corruption placement, remove Gormen figures and
    // place 1 corruption token per 2 figures removed (before ruination check).
    if (!changerOfFateActive && regionCardActive(s, regionId, 'gormen_vile_consumption')) {
      const gormenFigures = followersInRegion(s, regionId).filter(f => f.power === 'gormen');
      if (gormenFigures.length > 0) {
        const tokensToPlace = Math.floor(gormenFigures.length / 2);
        s = log.apply(s, { type: 'vile_consumption', regionId, figuresRemoved: gormenFigures.length, tokensPlaced: tokensToPlace });
      }
    }

    // Check ruination — "ruiners" are all powers whose corruption count in
    // this region increased since the start of the corruption phase (the
    // snapshot). This correctly credits Heartrippers (battle), Depraved
    // Infiltration (summoning), Death's Perfume (domination), normal cultists,
    // and Plague Bloom — any source.
    const total = totalCorruption(s.regions[regionId]!);
    if (total >= CORRUPTION_RUIN_THRESHOLD) {
      const snap = corruptionSnapshot[regionId]!;
      const current = s.regions[regionId]!.corruptionTokens;
      const placedBy = new Set<Power>(
        s.activePowers.filter(p => current[p] > snap[p]),
      );
      s = applyRuination(s, regionId, placedBy, log);
    }
  }

  return { state: s, log };
}

/** Number of corruption tokens a power places in a region this corruption step. */
function corruptionTokensToPlace(
  state: GameState,
  regionId: RegionId,
  power: Power,
  changerOfFateActive: boolean,
): number {
  // Count cultists (and Lasha warriors if Ravers upgrade active)
  const powerFigs = followersInRegion(state, regionId, power);
  const cultists = powerFigs.filter(f => f.class === 'cultist').length;

  let warriors = 0;
  if (power === 'lasha' && state.powers['lasha']!.upgradesInPlay.includes('lasha_ravers_up')) {
    warriors = powerFigs.filter(f => f.class === 'warrior' && f.power === 'lasha').length;
  }

  // Tenzen Kaleidoscope: one cultist per opponent doesn't count
  let reduction = 0;
  if (!changerOfFateActive && regionCardActive(state, regionId, 'tenzen_shimmer') && power !== 'tenzen') {
    reduction = 1;
  }

  return Math.max(0, cultists + warriors - reduction);
}

/** Check and award dial advancement counters for a power's corruption placement. */
function checkDialAdvancement(
  state: GameState,
  regionId: RegionId,
  power: Power,
  tokensPlaced: number,
  _changerOfFateActive: boolean,
  log: GameLog,
): GameState {
  let s = state;
  const region = s.regions[regionId]!;

  if (tokensPlaced < 2) return s;

  let earnedCounter = false;

  switch (power) {
    case 'gormen': {
      // Gormen: 2+ tokens placed in a Populous region
      if (region.populous) earnedCounter = true;
      break;
    }
    case 'tenzen': {
      // Tenzen: 2+ tokens in region with 2+ combined magic symbols + chaos stones
      const magicCount = magicSymbolCount(s, regionId);
      const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
      // Tenzen Fatespinner upgrade: counts as 2 chaos stones
      const fatespinnerBonus = s.powers['tenzen']!.upgradesInPlay.includes('tenzen_fatespinner_up') &&
        followersInRegion(s, regionId).some(f => f.class === 'incarnation' && f.power === 'tenzen') ? 2 : 0;
      if (magicCount + chaosStones + fatespinnerBonus >= 2) earnedCounter = true;
      break;
    }
    case 'lasha': {
      // Lasha: 2+ tokens in region with Noble or Hero token
      const hasNobleOrHero = region.tokens.some(t => t === 'noble' || t === 'hero');
      if (hasNobleOrHero) earnedCounter = true;
      break;
    }
    case 'xarm':
      // Xarm's condition is during battle phase, not corruption phase
      break;
  }

  if (earnedCounter) {
    s = log.apply(s, { type: 'dial_counter', regionId, power });
  }

  return s;
}

// ─── Ruination ────────────────────────────────────────────────────────────────

function applyRuination(
  state: GameState,
  regionId: RegionId,
  placedBy: Set<Power>,
  log: GameLog,
): GameState {
  let s = state;
  const nextCardIndex = s.ruinationCardsUsed + 1;

  if (nextCardIndex > MAX_RUINATION_CARDS) {
    log.emit({ type: 'ruination_blocked', regionId });
    return s;
  }

  const card = RUINATION_CARDS[nextCardIndex - 1]!;
  s = log.apply(s, { type: 'ruination', regionId, cardIndex: nextCardIndex, ruiners: [...placedBy], ruinerVP: card.ruinersScore });

  // Gormen Provender of Ruin upgrade: +3 VP on any ruination
  for (const power of s.activePowers) {
    if (s.powers[power]!.upgradesInPlay.includes('gormen_provender_of_rot')) {
      s = log.apply(s, { type: 'provender_score', power, vp: 3 });
    }
  }

  return s;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function regionCardActive(state: GameState, regionId: RegionId, cardId: string): boolean {
  return state.regions[regionId]!.chaosCards.some(c => c?.cardId === cardId);
}

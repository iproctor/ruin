import type { GameState, Power, RegionId } from '../types.js';
import {
  REGION_ORDER, FOLLOWERS, UPGRADES, RUINATION_CARDS, CARD_BY_ID,
  CORRUPTION_RUIN_THRESHOLD, MAX_RUINATION_CARDS,
} from '../constants.js';
import {
  updatePower, updateRegion, scoreVP, isWorldCardActive, isRuined,
  magicSymbolCount, totalCorruption,
} from '../helpers.js';

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
  const nullWeave = state.regions[regionId]!.chaosCards.some(c => c?.cardId === 'tenzen_changer_of_fate');
  return calcResistance(state, regionId, nullWeave);
}

/** Returns the leading power and their domination value, or null if ruined/tied/zero. */
export function getRegionDomination(
  state: GameState,
  regionId: RegionId,
): { leader: Power | null; value: number } {
  const region = state.regions[regionId]!;
  if (region.ruinationCardIndex !== null) return { leader: null, value: 0 };
  const nullWeave = regionCardActive(state, regionId, 'tenzen_changer_of_fate');
  const domValues = new Map<Power, number>();
  // Compute for all active powers, plus any power with a presence in the region
  // that might not be in activePowers (e.g. figures from card effects)
  const powersToCheck = new Set<Power>(state.activePowers);
  for (const f of region.placements) {
    const p = (f.controlledBy ?? f.power) as Power;
    if (state.powers[p]) powersToCheck.add(p);
  }
  for (const slot of region.chaosCards) {
    if (slot && state.powers[slot.playedBy]) powersToCheck.add(slot.playedBy);
  }
  for (const power of powersToCheck) {
    domValues.set(power, calcDomination(state, regionId, power, nullWeave));
  }
  const vals = Array.from(domValues.values());
  const maxDom = vals.length ? Math.max(...vals) : 0;
  if (maxDom === 0) return { leader: null, value: 0 };
  const resistance = calcResistance(state, regionId, nullWeave);
  if (maxDom <= resistance) return { leader: null, value: 0 };
  const leaders = Array.from(powersToCheck).filter(p => domValues.get(p) === maxDom);
  return { leader: leaders.length === 1 ? leaders[0]! : null, value: maxDom };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function resolveCorruptionPhase(
  state: GameState,
): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s = state;

  // Step 1: Domination
  ({ state: s } = resolveDomination(s, log));

  // Step 2: Corruption placement + ruination checks
  ({ state: s } = resolveCorruption(s, log));

  s = { ...s, phase: 'end', pendingAction: null };
  return { state: s, log };
}

// ─── Step 1: Domination ────────────────────────────────────────────────────────

function resolveDomination(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;

    // Ruined regions skip domination
    if (isRuined(region)) continue;

    const nullWeave = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

    // Calculate domination value per power
    const domValues = new Map<Power, number>();
    for (const power of s.activePowers) {
      const val = calcDomination(s, regionId, power, nullWeave);
      domValues.set(power, val);
    }

    // Find highest domination value
    const maxDom = Math.max(...domValues.values());
    if (maxDom === 0) continue;

    const leaders = s.activePowers.filter(p => domValues.get(p) === maxDom);
    if (leaders.length > 1) {
      log.push(`${regionId}: Tied domination (${maxDom}) — no conquest.`);
      continue;
    }

    const winner = leaders[0]!;
    const resistance = calcResistance(s, regionId, nullWeave);

    if (maxDom > resistance) {
      const conquestValue = calcConquestValue(s, regionId);
      s = scoreVP(s, winner, conquestValue);
      log.push(`${regionId}: ${winner} dominates (${maxDom} vs resistance ${resistance}) — scores ${conquestValue} VP.`);

      // Gormen Death's Perfume: place 2 corruption tokens on domination
      if (!nullWeave && winner === 'gormen' &&
          regionCardActive(s, regionId, 'gormen_deaths_perfume')) {
        for (let i = 0; i < 2; i++) {
          s = updateRegion(s, regionId, {
            corruptionTokens: {
              ...s.regions[regionId]!.corruptionTokens,
              gormen: s.regions[regionId]!.corruptionTokens.gormen + 1,
            },
          });
        }
        log.push(`${regionId}: Gormen Death's Perfume — 2 corruption tokens placed.`);
      }
    } else {
      log.push(`${regionId}: ${winner} has highest domination (${maxDom}) but does not exceed resistance (${resistance}).`);
    }
  }

  return { state: s, log };
}

function calcDomination(
  state: GameState,
  regionId: RegionId,
  power: Power,
  nullWeave: boolean,
): number {
  const region = state.regions[regionId]!;

  // Lasha Hollow Pact: enemy figures contribute 0 domination
  const hollowPact = !nullWeave && regionCardActive(state, regionId, 'lasha_hollow_pact');

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
  const figures = region.placements.filter(f => (f.controlledBy ?? f.power) === power);

  if (hollowPact && power !== 'lasha') {
    // Hollow Pact: enemies contribute 0 figures
    return cardCostSum; // only card costs, no figure contribution
  }

  let figureValue: number;

  // Xarm Altar: use sum of attack values instead of count
  const altarActive = !nullWeave && regionCardActive(state, regionId, 'xarm_the_red_throne');
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
  if (!nullWeave && power === 'gormen' && regionCardActive(state, regionId, 'gormen_pestilent_aura')) {
    bonus += region.corruptionTokens['gormen'] ?? 0;
  }

  // Lasha Sweet Deceit: +2 per Noble and Hero token
  if (!nullWeave && power === 'lasha' && regionCardActive(state, regionId, 'lasha_sweet_lies')) {
    const nobles = region.tokens.filter(t => t === 'noble').length;
    const heroes = region.tokens.filter(t => t === 'hero').length;
    bonus += (nobles + heroes) * 2;
  }

  return cardCostSum + figureValue + bonus;
}

function calcResistance(
  state: GameState,
  regionId: RegionId,
  nullWeave: boolean,
): number {
  const region = state.regions[regionId]!;
  let resistance = region.baseValue;

  // Ratmen tokens: -1 each
  const ratmen = region.tokens.filter(t => t === 'ratmen').length;
  resistance -= ratmen;

  // Gormen Epidemic: -2
  if (!nullWeave && regionCardActive(state, regionId, 'gormen_pandemic')) {
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
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;

  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;

    // Ruined or scorched regions skip corruption placement
    if (isRuined(region)) continue;
    if (regionCardActive(s, regionId, 'xarm_war_cry')) {
      log.push(`${regionId}: Scorched Earth — no corruption tokens placed.`);
      continue;
    }

    // Track who places tokens this step (for dial advancement and ruiner scoring)
    const placedBy = new Set<Power>();
    const nullWeave = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

    for (const power of s.activePowers) {
      const tokensToPlace = corruptionTokensToPlace(s, regionId, power, nullWeave);
      if (tokensToPlace === 0) continue;

      s = updateRegion(s, regionId, {
        corruptionTokens: {
          ...s.regions[regionId]!.corruptionTokens,
          [power]: s.regions[regionId]!.corruptionTokens[power] + tokensToPlace,
        },
      });
      placedBy.add(power);
      log.push(`${regionId}: ${power} places ${tokensToPlace} corruption token(s).`);

      // Dial advancement counters
      s = checkDialAdvancement(s, regionId, power, tokensToPlace, nullWeave, log);
    }

    // Gormen Plague Bloom: after corruption placement, remove Gormen figures and
    // place 1 corruption token per 2 figures removed (before ruination check).
    if (!nullWeave && regionCardActive(s, regionId, 'gormen_vile_consumption')) {
      const gormenFigures = s.regions[regionId]!.placements.filter(f => f.power === 'gormen');
      if (gormenFigures.length > 0) {
        const tokensToPlace = Math.floor(gormenFigures.length / 2);
        s = updateRegion(s, regionId, {
          placements: s.regions[regionId]!.placements.filter(f => f.power !== 'gormen'),
          corruptionTokens: tokensToPlace > 0 ? {
            ...s.regions[regionId]!.corruptionTokens,
            gormen: s.regions[regionId]!.corruptionTokens.gormen + tokensToPlace,
          } : s.regions[regionId]!.corruptionTokens,
        });
        s = updatePower(s, 'gormen', {
          followers: s.powers['gormen']!.followers.map(f =>
            gormenFigures.some(gf => gf.id === f.id) ? { ...f, regionId: null } : f
          ),
        });
        if (tokensToPlace > 0) placedBy.add('gormen');
        log.push(`${regionId}: Plague Bloom — ${gormenFigures.length} Gormen figures removed, ${tokensToPlace} corruption token(s) placed.`);
      }
    }

    // Check ruination
    const total = totalCorruption(s.regions[regionId]!);
    if (total >= CORRUPTION_RUIN_THRESHOLD) {
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
  nullWeave: boolean,
): number {
  const region = state.regions[regionId]!;

  // Count cultists (and Lasha warriors if Ravers upgrade active)
  const cultists = region.placements.filter(f =>
    (f.controlledBy ?? f.power) === power && f.class === 'cultist'
  ).length;

  let warriors = 0;
  if (power === 'lasha' && state.powers['lasha']!.upgradesInPlay.includes('lasha_ravers_up')) {
    warriors = region.placements.filter(f =>
      (f.controlledBy ?? f.power) === 'lasha' && f.class === 'warrior' && f.power === 'lasha'
    ).length;
  }

  // Tenzen Kaleidoscope: one cultist per opponent doesn't count
  let reduction = 0;
  if (!nullWeave && regionCardActive(state, regionId, 'tenzen_shimmer') && power !== 'tenzen') {
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
  _nullWeave: boolean,
  log: string[],
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
        region.placements.some(f => f.class === 'incarnation' && f.power === 'tenzen') ? 2 : 0;
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
    s = updatePower(s, power, { dialCounters: s.powers[power]!.dialCounters + 1 });
    log.push(`${regionId}: ${power} earns a dial advancement counter.`);
  }

  return s;
}

// ─── Ruination ────────────────────────────────────────────────────────────────

function applyRuination(
  state: GameState,
  regionId: RegionId,
  placedBy: Set<Power>,
  log: string[],
): GameState {
  let s = state;
  const nextCardIndex = s.ruinationCardsUsed + 1;

  if (nextCardIndex > MAX_RUINATION_CARDS) {
    log.push(`${regionId}: Would be ruined but no ruination cards remain.`);
    return s;
  }

  const card = RUINATION_CARDS[nextCardIndex - 1]!;
  s = { ...s, ruinationCardsUsed: nextCardIndex };
  s = updateRegion(s, regionId, { ruinationCardIndex: nextCardIndex });

  // Score ruiners VP
  for (const power of placedBy) {
    s = scoreVP(s, power, card.ruinersScore);
  }
  log.push(`${regionId}: RUINED (card ${nextCardIndex}). Ruiners score ${card.ruinersScore} VP each.`);

  // Gormen Provender of Ruin upgrade: +3 VP on any ruination
  for (const power of s.activePowers) {
    if (s.powers[power]!.upgradesInPlay.includes('gormen_provender_of_rot')) {
      s = scoreVP(s, power, 3);
      log.push(`Gormen Provender of Ruin: ${power} scores 3 VP.`);
    }
  }

  return s;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function regionCardActive(state: GameState, regionId: RegionId, cardId: string): boolean {
  return state.regions[regionId]!.chaosCards.some(c => c?.cardId === cardId);
}

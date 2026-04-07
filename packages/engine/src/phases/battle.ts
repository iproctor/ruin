import type {
  GameState, Power, RegionId, FollowerInstance,
  CorruptionHarvestChoiceAction, BattleNextStep, BattleHitAssignmentAction,
} from '../types.js';
import {
  REGION_ORDER, FOLLOWERS, UPGRADES,
} from '../constants.js';
import {
  updatePower, updateRegion, isWorldCardActive,
} from '../helpers.js';
import { rollWithExplosions, countHits, makeRng, shuffle } from '../dice.js';
import type { ApplyResult } from '../reducers.js';

// ─── Entry point ─────────────────────────────────────────────────────────────

export function resolveBattlePhase(
  state: GameState,
): { state: GameState; log: string[] } {
  const s: GameState = {
    ...state,
    phase: 'battle',
    battleState: {
      regionOrder: [...REGION_ORDER],
      currentRegionIndex: 0,
      log: [],
      nextStep: null,
    },
  };
  const log: string[] = [];
  return resolveFromRegion(s, 0, log);
}

/** Resume after a Corruption's Harvest choice has been submitted. */
export function applyCorruptionHarvestChoice(
  state: GameState,
  action: CorruptionHarvestChoiceAction,
): { state: GameState; log: string[] } {
  const log: string[] = [];
  let s: GameState = { ...state, pendingAction: null };
  const { regionId, followerIds } = action;

  // Kill each chosen figure
  for (const fId of followerIds) {
    const r = killFollower(s, regionId, fId, 'gormen', log);
    s = r.state;
  }

  // Advance past this region
  const idx = s.battleState!.currentRegionIndex;
  return resolveFromRegion(s, idx + 1, log);
}

/** Resume after a battle hit assignment choice has been submitted. */
export function applyBattleHitAssignment(
  state: GameState,
  action: BattleHitAssignmentAction,
): ApplyResult {
  const log: string[] = [];
  let s: GameState = { ...state, pendingAction: null };

  const { regionId, followerIds, power: attacker } = action;
  const ctx = state.pendingAction!.context;
  const nullWeaveActive = ctx['nullWeaveActive'] as boolean;

  // Apply kills for each chosen follower
  for (const fId of followerIds) {
    const figure = s.regions[regionId]!.placements.find(f => f.id === fId);
    if (!figure) continue;

    // Mark as tipped in region
    s = updateRegion(s, regionId, {
      placements: s.regions[regionId]!.placements.map(f =>
        f.id === fId ? { ...f, tipped: true } : f
      ),
    });
    // Mark as tipped in power's followers array
    const owner = figure.power as Power;
    s = updatePower(s, owner, {
      followers: s.powers[owner]!.followers.map(f =>
        f.id === fId ? { ...f, tipped: true } : f
      ),
    });
    log.push(`${regionId}: ${attacker} kills ${figure.power} ${figure.class} (${fId}).`);

    // Xarm Heart Offering: draw a chaos card per kill
    if (!nullWeaveActive && regionCardActive(s, regionId, 'xarm_heart_offering') && attacker === 'xarm') {
      s = drawCardForPower(s, 'xarm', log);
    }

    // Xarm Heartrippers upgrade: place 1 corruption token per warrior kill
    if (attacker === 'xarm' &&
        s.powers['xarm']!.upgradesInPlay.includes('xarm_heartrippers_up') &&
        s.regions[regionId]!.placements.some(f => (f.controlledBy ?? f.power) === 'xarm' && f.class === 'warrior')) {
      s = updateRegion(s, regionId, {
        corruptionTokens: {
          ...s.regions[regionId]!.corruptionTokens,
          xarm: s.regions[regionId]!.corruptionTokens.xarm + 1,
        },
      });
      log.push(`${regionId}: Xarm Heartrippers place 1 corruption token.`);
    }

    // Tenzen Recursive Pattern: mark for persistence if Tenzen killed a figure
    if (attacker === 'tenzen' && !nullWeaveActive) {
      const slots = s.regions[regionId]!.chaosCards;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot?.cardId === 'tenzen_recursive_pattern' && slot.playedBy === 'tenzen') {
          const newSlots = [...slots] as typeof slots;
          newSlots[i as 0 | 1] = { ...slot, persistNextRound: true };
          s = updateRegion(s, regionId, { chaosCards: newSlots });
        }
      }
    }
  }

  // Get and clear nextStep from battleState
  const nextStep = s.battleState!.nextStep;
  s = { ...s, battleState: { ...s.battleState!, nextStep: null } };

  // Resume based on next step type
  if (nextStep === null) {
    // Shouldn't happen, but fall through to post_normal
    return runPostNormal(s, regionId, log);
  }

  let result: { state: GameState; log: string[] };
  switch (nextStep.type) {
    case 'normal_battle':
      result = runNormalBattle(s, regionId, nextStep.powerIndex, log);
      break;
    case 'undying_fury':
      result = runUndyingFury(s, regionId, nextStep.powerIndex, log);
      break;
    case 'post_normal':
      result = runPostNormal(s, regionId, log);
      break;
    case 'post_undying':
      result = runPostUndying(s, regionId, log);
      break;
  }

  // If the current region finished without a new pause, advance to the next region
  if (!result.state.pendingAction && result.state.phase === 'battle') {
    const nextIdx = result.state.battleState!.currentRegionIndex + 1;
    return resolveFromRegion(result.state, nextIdx, result.log);
  }

  return result;
}

// ─── Region iteration ─────────────────────────────────────────────────────────

function resolveFromRegion(
  state: GameState,
  startIdx: number,
  outerLog: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const regions = REGION_ORDER;

  for (let i = startIdx; i < regions.length; i++) {
    const regionId = regions[i]!;
    s = { ...s, battleState: s.battleState ? { ...s.battleState, currentRegionIndex: i } : null };

    const result = resolveRegion(s, regionId, outerLog);
    s = result.state;
    outerLog = result.log;

    if (s.pendingAction !== null) {
      // Pause for interactive choice — caller will resume
      return { state: s, log: outerLog };
    }
  }

  // All regions done — apply end-of-battle effects then move to corruption
  return finalizeBattle(s, outerLog);
}

// ─── Single-region resolution ─────────────────────────────────────────────────

function resolveRegion(
  state: GameState,
  regionId: RegionId,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const region = s.regions[regionId]!;
  const activePowers = s.activePowers;

  // Determine which powers have figures here (controlling = controlledBy ?? power)
  const powersPresent = activePowers.filter(p =>
    region.placements.some(f => (f.controlledBy ?? f.power) === p)
  );

  // War Zone: no battles if event token in region
  if (isWorldCardActive(s, 'war_zone') && region.tokens.includes('event')) {
    return { state: s, log };
  }

  // Check if any power can roll dice (attack > 0 or War Frenzy present)
  const hasWarFrenzy = regionCardActive(s, regionId, 'xarm_war_frenzy');
  const xarmPresent = powersPresent.includes('xarm');

  const powersThatCanRoll = powersPresent.filter(p => {
    const totalAttack = getTotalAttack(s, regionId, p);
    return totalAttack > 0 || (p === 'xarm' && hasWarFrenzy);
  });

  // Battle occurs if someone can roll and there are targets
  const hasPeasants = region.tokens.includes('peasant');
  const hasEnemyTargets = (attacker: Power) =>
    powersPresent.some(p => p !== attacker) || hasPeasants;

  const battleOccurs = powersThatCanRoll.some(p => hasEnemyTargets(p));
  if (!battleOccurs) return { state: s, log };

  // Detect card effects (Null Weave cancels all other card text)
  const nullWeaveActive = regionCardActive(s, regionId, 'tenzen_null_weave');

  // ── Beginning-of-battle: Rapture upgrade (Lasha) ─────────────────────────
  // Auto-control weakest enemy Cultist or Warrior until end of round
  if (!nullWeaveActive && powersPresent.includes('lasha') &&
      s.powers['lasha']!.upgradesInPlay.includes('lasha_rapture_up')) {
    const rapture = s.regions[regionId]!.placements.find(
      f => f.class === 'incarnation' && (f.controlledBy ?? f.power) === 'lasha'
    );
    if (rapture) {
      const target = s.regions[regionId]!.placements.find(f => {
        const ctrl = f.controlledBy ?? f.power;
        return ctrl !== 'lasha' && (f.class === 'cultist' || f.class === 'warrior');
      });
      if (target) {
        s = updateRegion(s, regionId, {
          placements: s.regions[regionId]!.placements.map(f =>
            f.id === target.id ? { ...f, controlledBy: 'lasha' } : f
          ),
        });
        s = updatePower(s, target.power as Power, {
          followers: s.powers[target.power as Power]!.followers.map(f =>
            f.id === target.id ? { ...f, controlledBy: 'lasha' } : f
          ),
        });
        log.push(`${regionId}: Rapture upgrade — Lasha controls ${target.power} ${target.class} (${target.id}).`);
      }
    }
  }

  // ── Beginning-of-battle: War Frenzy ──────────────────────────────────────
  if (!nullWeaveActive && xarmPresent && hasWarFrenzy && powersPresent.some(p => p !== 'xarm')) {
    const rng = makeBattleRng(s);
    const rolls = rollWithExplosions(2, rng);
    const hits = countHits(rolls);
    s = { ...s, actionCount: s.actionCount + 1 };
    log.push(`${regionId}: War Frenzy — Xarm rolls ${rolls.join(',')} → ${hits} hit(s).`);
    if (hits > 0) {
      // Claim peasants first, then pause if enemies remain
      let remaining = hits;
      while (remaining > 0 && s.regions[regionId]!.tokens.includes('peasant')) {
        s = claimPeasant(s, regionId, 'xarm', log);
        remaining--;
      }
      if (remaining > 0 && getEnemyFigures(s, regionId, 'xarm', nullWeaveActive).length > 0) {
        return pauseForHitChoice(
          s, regionId, 'xarm', remaining, nullWeaveActive,
          { type: 'normal_battle', powerIndex: 0 },
          log,
        );
      }
    }
  }

  // ── Euphoric Haze: no dice rolled ────────────────────────────────────────
  const euphoricHaze = !nullWeaveActive && regionCardActive(s, regionId, 'lasha_euphoric_haze');

  // ── Normal battle dice ────────────────────────────────────────────────────
  if (!euphoricHaze) {
    const result = runNormalBattle(s, regionId, 0, log);
    s = result.state;
    log = result.log;
    if (s.pendingAction !== null) return { state: s, log };
  } else {
    // Skip normal battle but still run post_normal
    const result = runPostNormal(s, regionId, log);
    s = result.state;
    log = result.log;
    if (s.pendingAction !== null) return { state: s, log };
  }

  return { state: s, log };
}

// ─── Step-based region resolution ────────────────────────────────────────────

function runNormalBattle(
  state: GameState,
  regionId: RegionId,
  startPowerIndex: number,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const nullWeaveActive = regionCardActive(s, regionId, 'tenzen_null_weave');
  const euphoricHaze = !nullWeaveActive && regionCardActive(s, regionId, 'lasha_euphoric_haze');
  if (euphoricHaze) {
    return runPostNormal(s, regionId, log);
  }

  const chokepoint = isWorldCardActive(s, 'the_chokepoint') && s.regions[regionId]!.tokens.includes('event');
  const region = s.regions[regionId]!;
  const activePowers = s.activePowers;
  const powersPresent = activePowers.filter(p =>
    region.placements.some(f => (f.controlledBy ?? f.power) === p)
  );

  for (let i = startPowerIndex; i < activePowers.length; i++) {
    const power = activePowers[i]!;
    if (!powersPresent.includes(power)) continue;

    const totalAttack = getTotalAttack(s, regionId, power);
    if (totalAttack === 0) continue;

    const diceCap = chokepoint ? 1 : totalAttack;
    const rng = makeBattleRng(s);
    const rolls = rollWithExplosions(diceCap, rng);
    const hits = countHits(rolls);
    s = { ...s, actionCount: s.actionCount + 1 };
    log.push(`${regionId}: ${power} rolls ${rolls.join(',')} → ${hits} hit(s).`);

    if (hits > 0) {
      // Claim peasants first
      let remaining = hits;
      while (remaining > 0 && s.regions[regionId]!.tokens.includes('peasant')) {
        s = claimPeasant(s, regionId, power, log);
        remaining--;
      }

      if (remaining > 0 && getEnemyFigures(s, regionId, power, nullWeaveActive).length > 0) {
        // Determine what to do after this choice is resolved
        const isLastPower = i === activePowers.length - 1 ||
          !activePowers.slice(i + 1).some(p => {
            const pp = s.regions[regionId]!.placements.some(f => (f.controlledBy ?? f.power) === p);
            return pp && getTotalAttack(s, regionId, p) > 0;
          });
        const nextStep: BattleNextStep = isLastPower
          ? { type: 'post_normal' }
          : { type: 'normal_battle', powerIndex: i + 1 };
        return pauseForHitChoice(s, regionId, power, remaining, nullWeaveActive, nextStep, log);
      }
    }
  }

  return runPostNormal(s, regionId, log);
}

function runPostNormal(
  state: GameState,
  regionId: RegionId,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const nullWeaveActive = regionCardActive(s, regionId, 'tenzen_null_weave');

  // ── Remove tipped figures ─────────────────────────────────────────────────
  const tipped = s.regions[regionId]!.placements.filter(f => f.tipped);
  const xarmPresent = s.activePowers.includes('xarm') &&
    s.regions[regionId]!.placements.some(f => (f.controlledBy ?? f.power) === 'xarm');
  const enemiesKilledByXarm = xarmPresent &&
    tipped.some(f => (f.controlledBy ?? f.power) !== 'xarm') &&
    getTotalAttack(state, regionId, 'xarm') > 0;

  for (const f of tipped) {
    const r = removeFigureFromBoard(s, regionId, f.id, log);
    s = r.state;
  }

  // Xarm dial advancement
  if (enemiesKilledByXarm) {
    s = updatePower(s, 'xarm', { dialCounters: s.powers['xarm']!.dialCounters + 1 });
    log.push(`${regionId}: Xarm earns a dial advancement counter.`);
  }

  // ── Undying Fury ─────────────────────────────────────────────────────────
  const euphoricHaze = !nullWeaveActive && regionCardActive(s, regionId, 'lasha_euphoric_haze');
  if (!nullWeaveActive && regionCardActive(s, regionId, 'xarm_undying_fury') && !euphoricHaze) {
    return runUndyingFury(s, regionId, 0, log);
  }

  return runPostUndying(s, regionId, log);
}

function runUndyingFury(
  state: GameState,
  regionId: RegionId,
  startPowerIndex: number,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const nullWeaveActive = regionCardActive(s, regionId, 'tenzen_null_weave');
  const chokepoint = isWorldCardActive(s, 'the_chokepoint') && s.regions[regionId]!.tokens.includes('event');
  const activePowers = s.activePowers;

  for (let i = startPowerIndex; i < activePowers.length; i++) {
    const power = activePowers[i]!;
    const totalAttack = getTotalAttack(s, regionId, power);
    if (totalAttack === 0) continue;

    const diceCap = chokepoint ? 1 : totalAttack;
    const rng = makeBattleRng(s);
    const rolls = rollWithExplosions(diceCap, rng);
    const hits = countHits(rolls);
    s = { ...s, actionCount: s.actionCount + 1 };
    log.push(`${regionId}: Undying Fury extra battle — ${power} rolls ${rolls.join(',')} → ${hits} hit(s).`);

    if (hits > 0) {
      // Claim peasants first
      let remaining = hits;
      while (remaining > 0 && s.regions[regionId]!.tokens.includes('peasant')) {
        s = claimPeasant(s, regionId, power, log);
        remaining--;
      }

      if (remaining > 0 && getEnemyFigures(s, regionId, power, nullWeaveActive).length > 0) {
        const isLastPower = i === activePowers.length - 1 ||
          !activePowers.slice(i + 1).some(p => getTotalAttack(s, regionId, p) > 0);
        const nextStep: BattleNextStep = isLastPower
          ? { type: 'post_undying' }
          : { type: 'undying_fury', powerIndex: i + 1 };
        return pauseForHitChoice(s, regionId, power, remaining, nullWeaveActive, nextStep, log);
      }
    }
  }

  return runPostUndying(s, regionId, log);
}

function runPostUndying(
  state: GameState,
  regionId: RegionId,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;
  const nullWeaveActive = regionCardActive(s, regionId, 'tenzen_null_weave');

  // Remove newly tipped figures from undying fury round
  const tipped2 = s.regions[regionId]!.placements.filter(f => f.tipped);
  for (const f of tipped2) {
    const r = removeFigureFromBoard(s, regionId, f.id, log);
    s = r.state;
  }

  // ── End-of-battle: Corruption's Harvest ──────────────────────────────────
  if (!nullWeaveActive && regionCardActive(s, regionId, 'gormen_corruptions_harvest')) {
    const gormenCorr = s.regions[regionId]!.corruptionTokens['gormen'] ?? 0;
    if (gormenCorr > 0) {
      const targets = s.regions[regionId]!.placements.filter(f => {
        const ctrl = f.controlledBy ?? f.power;
        return ctrl !== 'gormen' && (f.class === 'cultist' || f.class === 'warrior') && !f.tipped;
      });

      if (targets.length > 0) {
        s = {
          ...s,
          pendingAction: {
            waitingFor: 'gormen',
            actionKind: 'corruption_harvest_choice',
            context: { regionId, maxKills: gormenCorr },
          },
        };
        log.push(`${regionId}: Corruption's Harvest — Gormen may kill up to ${gormenCorr} enemy figure(s). Waiting for choice.`);
        return { state: s, log };
      }
    }
  }

  return { state: s, log };
}

// ─── Pause for hit choice ─────────────────────────────────────────────────────

function pauseForHitChoice(
  state: GameState,
  regionId: RegionId,
  attacker: Power,
  hitsRemaining: number,
  nullWeaveActive: boolean,
  nextStep: BattleNextStep,
  log: string[],
): { state: GameState; log: string[] } {
  const s: GameState = {
    ...state,
    battleState: {
      ...state.battleState!,
      nextStep,
    },
    pendingAction: {
      waitingFor: attacker,
      actionKind: 'battle_hit_assignment',
      context: { regionId, hitsRemaining, nullWeaveActive },
    },
  };
  log.push(`${regionId}: ${attacker} must assign ${hitsRemaining} hit(s) to enemy figures. Waiting for choice.`);
  return { state: s, log };
}

// ─── Hit assignment (legacy — kept for reference, no longer called) ───────────

function getEnemyFigures(
  state: GameState,
  regionId: RegionId,
  attacker: Power,
  nullWeaveActive: boolean,
): Array<{ figure: FollowerInstance; defense: number }> {
  const region = state.regions[regionId]!;
  const hasRottingGrasp = !nullWeaveActive && regionCardActive(state, regionId, 'gormen_rotting_grasp');
  const hasBlightWard = !nullWeaveActive && regionCardActive(state, regionId, 'gormen_blight_ward');

  return region.placements
    .filter(f => {
      const ctrl = f.controlledBy ?? f.power;
      return ctrl !== attacker && !f.tipped && !f.protected;
    })
    .map(f => {
      const owner = f.power as Power;
      const def = FOLLOWERS[owner]![f.class]!;
      const isUpgraded = state.powers[owner]!.upgradesInPlay.some(u =>
        UPGRADES.find(up => up.id === u)?.upgradeType === f.class
      );
      let defense = isUpgraded ? def.upgraded.defense : def.base.defense;

      // Blight Ward: +1 to Gormen figures' defense
      if (hasBlightWard && owner === 'gormen') defense += 1;

      // Rotting Grasp: -1 to non-Gormen figures' defense (min 1)
      if (hasRottingGrasp && owner !== 'gormen') defense = Math.max(1, defense - 1);

      return { figure: f, defense };
    })
    .sort((a, b) => a.defense - b.defense);
}

// ─── Peasant claiming ─────────────────────────────────────────────────────────

function claimPeasant(
  state: GameState,
  regionId: RegionId,
  claimedBy: Power,
  log: string[],
): GameState {
  const tokens = [...state.regions[regionId]!.tokens];
  const idx = tokens.indexOf('peasant');
  if (idx === -1) return state;
  tokens.splice(idx, 1);

  let s = updateRegion(state, regionId, { tokens });
  s = updatePower(s, claimedBy, {
    claimedPeasants: s.powers[claimedBy]!.claimedPeasants + 1,
  });
  log.push(`${regionId}: ${claimedBy} claims a Peasant token (${s.powers[claimedBy]!.claimedPeasants} total).`);
  return s;
}

// ─── Remove figure from board ─────────────────────────────────────────────────

function removeFigureFromBoard(
  state: GameState,
  regionId: RegionId,
  followerId: string,
  log: string[],
): { state: GameState; log: string[] } {
  let s = updateRegion(state, regionId, {
    placements: state.regions[regionId]!.placements.filter(f => f.id !== followerId),
  });

  // Find which power owns this figure and mark it in reserve
  for (const power of s.activePowers) {
    const follower = s.powers[power]!.followers.find(f => f.id === followerId);
    if (follower) {
      s = updatePower(s, power, {
        followers: s.powers[power]!.followers.map(f =>
          f.id === followerId ? { ...f, regionId: null, tipped: false, controlledBy: null } : f
        ),
      });
      break;
    }
  }

  return { state: s, log };
}

/** Kill a figure immediately (no tipping) — used by Corruption's Harvest. */
function killFollower(
  state: GameState,
  regionId: RegionId,
  followerId: string,
  _killedBy: Power,
  log: string[],
): { state: GameState; log: string[] } {
  const figure = state.regions[regionId]!.placements.find(f => f.id === followerId);
  if (!figure) return { state, log };
  log.push(`${regionId}: Corruption's Harvest kills ${figure.power} ${figure.class} (${followerId}).`);
  return removeFigureFromBoard(state, regionId, followerId, log);
}

// ─── Post-all-regions: end-of-battle effects ──────────────────────────────────

function finalizeBattle(
  state: GameState,
  log: string[],
): { state: GameState; log: string[] } {
  let s = state;

  // Armistice end-of-battle: each player removes 1 figure per event-token region
  if (isWorldCardActive(s, 'armistice')) {
    for (const regionId of REGION_ORDER) {
      if (!s.regions[regionId]!.tokens.includes('event')) continue;
      for (const power of s.activePowers) {
        const figures = s.regions[regionId]!.placements.filter(
          f => (f.controlledBy ?? f.power) === power
        );
        if (figures.length === 0) continue;
        // Auto-remove weakest figure
        const target = figures.sort((a, b) =>
          classRank(a.class) - classRank(b.class)
        )[0]!;
        const r = removeFigureFromBoard(s, regionId, target.id, log);
        s = r.state;
        log.push(`${regionId}: Armistice — ${power} removes ${target.class} (${target.id}).`);
      }
    }
  }

  // Clear per-round flags: protected (Fate's Aegis), Rapture-granted controlledBy
  const lashHasRaptureUp = s.powers['lasha']?.upgradesInPlay.includes('lasha_rapture_up') ?? false;

  for (const power of s.activePowers) {
    const p = s.powers[power]!;
    let changed = false;
    const updatedFollowers = p.followers.map(f => {
      let upd = f;
      if (f.protected) { upd = { ...upd, protected: false }; changed = true; }
      // Clear Rapture control at end of battle round
      if (f.controlledBy === 'lasha' && f.power !== 'lasha' && lashHasRaptureUp) {
        const regionId = f.regionId;
        const raptureAlive = regionId !== null &&
          s.regions[regionId]!.placements.some(
            x => x.class === 'incarnation' && (x.controlledBy ?? x.power) === 'lasha'
          );
        if (!raptureAlive) {
          const hasEnthrallment = regionId !== null &&
            s.regions[regionId]!.chaosCards.some(c => c?.cardId === 'lasha_enthrallment' && c.playedBy === 'lasha');
          if (!hasEnthrallment) {
            upd = { ...upd, controlledBy: null };
            changed = true;
          }
        } else if (raptureAlive) {
          const hasEnthrallment = regionId !== null &&
            s.regions[regionId]!.chaosCards.some(c => c?.cardId === 'lasha_enthrallment' && c.playedBy === 'lasha');
          if (!hasEnthrallment) {
            upd = { ...upd, controlledBy: null };
            changed = true;
          }
        }
      }
      return upd;
    });
    if (changed) s = updatePower(s, power, { followers: updatedFollowers });
  }
  // Sync region placements to match follower state
  for (const regionId of REGION_ORDER) {
    const region = s.regions[regionId]!;
    if (region.placements.some(f => f.protected)) {
      s = updateRegion(s, regionId, {
        placements: region.placements.map(f => f.protected ? { ...f, protected: false } : f),
      });
    }
  }

  // Move to corruption phase
  s = {
    ...s,
    phase: 'corruption',
    pendingAction: null,
    battleState: null,
  };

  return { state: s, log };
}

// ─── Attack value calculation ─────────────────────────────────────────────────

function getTotalAttack(state: GameState, regionId: RegionId, power: Power): number {
  const region = state.regions[regionId]!;
  let total = 0;

  for (const f of region.placements) {
    if ((f.controlledBy ?? f.power) !== power) continue;
    const owner = f.power as Power;
    const def = FOLLOWERS[owner]![f.class]!;
    const isUpgraded = state.powers[owner]!.upgradesInPlay.some(u =>
      UPGRADES.find(up => up.id === u)?.upgradeType === f.class
    );
    total += isUpgraded ? def.upgraded.attack : def.base.attack;
  }

  return total;
}

// ─── Card presence helpers ────────────────────────────────────────────────────

/** True if the given chaos card is played in the given region. */
function regionCardActive(state: GameState, regionId: RegionId, cardId: string): boolean {
  return state.regions[regionId]!.chaosCards.some(c => c?.cardId === cardId);
}

// ─── Card draw helper ─────────────────────────────────────────────────────────

function drawCardForPower(state: GameState, power: Power, log: string[]): GameState {
  const p = state.powers[power]!;
  let { deckIds, discardIds, hand } = p;

  if (deckIds.length === 0 && discardIds.length === 0) return state;

  if (deckIds.length === 0) {
    const rng = makeBattleRng(state);
    deckIds = shuffle([...discardIds], rng);
    discardIds = [];
  }

  const drawn = deckIds[0]!;
  log.push(`${power} draws ${drawn} (Heart Offering).`);
  return updatePower(state, power, {
    hand: [...hand, drawn],
    deckIds: deckIds.slice(1),
    discardIds,
  });
}

// ─── RNG ─────────────────────────────────────────────────────────────────────

function makeBattleRng(state: GameState) {
  return makeRng(state.rngSeed ^ (state.actionCount * 2654435761));
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function classRank(cls: 'cultist' | 'warrior' | 'incarnation'): number {
  return cls === 'cultist' ? 0 : cls === 'warrior' ? 1 : 2;
}

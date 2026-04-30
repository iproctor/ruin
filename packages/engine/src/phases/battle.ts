import type {
  GameState, Power, RegionId, FollowerInstance,
  CorruptionHarvestChoiceAction, BattleNextStep, BattleHitAssignmentAction,
  CompanionDiceRollAction, RaptureChoiceAction,
} from '../types.js';
import {
  CARD_BY_ID, REGION_ORDER, FOLLOWERS, UPGRADES, UPGRADE_BY_ID, WORLD_CARD_BY_ID,
} from '../constants.js';
import {
  updatePower, updateRegion, isWorldCardActive, followersInRegion,
} from '../helpers.js';
import { rollWithExplosions, countHits, makeRng, shuffle } from '../dice.js';
import { GameLog } from '../gameLog.js';
import type { ApplyResult } from '../reducers.js';

// ─── Companion-mode dice helper ──────────────────────────────────────────────

/** If humanRollsDice is on and the given power is a human who has not yet
 *  reported hits for this roll, pause the phase. Otherwise return either the
 *  pre-reported hits (and consume them) or null to indicate a normal roll. */
function consumeCompanionHits(
  state: GameState,
  power: Power,
  kind: 'normal' | 'war_frenzy' | 'undying_fury',
): { state: GameState; hits: number } | null {
  const cd = state.battleState?.companionDice;
  if (cd && cd.power === power && cd.kind === kind) {
    const s: GameState = {
      ...state,
      battleState: state.battleState ? { ...state.battleState, companionDice: null } : null,
    };
    return { state: s, hits: cd.hits };
  }
  return null;
}

function shouldPauseForCompanionRoll(state: GameState, power: Power): boolean {
  if (!state.companionOptions?.humanRollsDice) return false;
  return state.powers[power]?.playerType === 'human';
}

function pauseForCompanionRoll(
  state: GameState,
  regionId: RegionId,
  power: Power,
  diceCount: number,
  kind: 'normal' | 'war_frenzy' | 'undying_fury',
  resumeStep: BattleNextStep,
  log: GameLog,
): { state: GameState; log: GameLog } {
  const s: GameState = {
    ...state,
    battleState: {
      ...state.battleState!,
      nextStep: resumeStep,
      companionDice: null,
    },
    pendingAction: {
      waitingFor: power,
      actionKind: 'companion_dice_roll',
      context: { regionId, diceCount, kind },
    },
  };
  log.emit({
    type: 'awaiting_action',
    power,
    actionKind: 'companion_dice_roll',
    context: { regionId, diceCount, kind },
    description: `${regionId}: ${power} rolls ${diceCount} die${diceCount === 1 ? '' : 'ce'} on the physical board — report hits.`,
  });
  return { state: s, log };
}

/** Resume battle after a companion dice-roll action. Stores the reported hits
 *  in battleState so the subsequent roll step uses them instead of rolling. */
export function applyCompanionDiceRoll(
  state: GameState,
  action: CompanionDiceRollAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  const ctx = state.pendingAction?.context ?? {};
  const kind = (ctx['kind'] as 'normal' | 'war_frenzy' | 'undying_fury') ?? 'normal';
  const s: GameState = {
    ...state,
    pendingAction: null,
    battleState: state.battleState
      ? { ...state.battleState, companionDice: { power: action.power, kind, hits: Math.max(0, action.hits | 0) } }
      : null,
  };
  return { state: s, log };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function resolveBattlePhase(
  state: GameState,
): { state: GameState; log: GameLog } {
  // Mid-battle resume: battleState already exists after a hit assignment or harvest choice
  if (state.battleState) {
    return resumeBattle(state);
  }

  // Fresh entry: create new battleState
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
  const log = new GameLog();
  return resolveFromRegion(s, 0, log);
}

/** Resume battle after a hit assignment or corruption harvest choice. */
function resumeBattle(state: GameState): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s = state;
  const nextStep = s.battleState!.nextStep;
  const regionIdx = s.battleState!.currentRegionIndex;
  const regionId = REGION_ORDER[regionIdx]!;

  // After corruption harvest choice: nextStep is null, advance to next region
  if (nextStep === null) {
    return resolveFromRegion(s, regionIdx + 1, log);
  }

  // After hit assignment: resume from nextStep
  s = { ...s, battleState: { ...s.battleState!, nextStep: null } };

  // War Frenzy clears tipped figures before normal battle starts.
  // If Xarm killed enemies via War Frenzy, award the DAC here (these
  // figures won't be visible to the normal runPostNormal DAC check).
  if (nextStep.type === 'normal_battle' && nextStep.clearTipped) {
    const tipped = followersInRegion(s, regionId).filter(f => f.tipped);
    const xarmPresent = s.activePowers.includes('xarm') &&
      followersInRegion(s, regionId).some(f => (f.controlledBy ?? f.power) === 'xarm');
    const enemyKilledByFrenzy = xarmPresent &&
      tipped.some(f => (f.controlledBy ?? f.power) !== 'xarm');
    for (const f of tipped) {
      s = removeFigureFromBoard(s, regionId, f.id, log).state;
    }
    if (enemyKilledByFrenzy && !s.powers['xarm']!.dacRegionsThisPhase.includes(regionId)) {
      s = log.apply(s, { type: 'dial_counter', regionId, power: 'xarm' as Power });
    }
  }

  let inner: { state: GameState; log: GameLog };
  switch (nextStep.type) {
    case 'normal_battle':
      inner = runNormalBattle(s, regionId, nextStep.powerIndex, log);
      break;
    case 'undying_fury':
      inner = runUndyingFury(s, regionId, nextStep.powerIndex, log);
      break;
    case 'post_normal':
      inner = runPostNormal(s, regionId, log);
      break;
    case 'post_undying':
      inner = runPostUndying(s, regionId, log);
      break;
    case 'war_frenzy_step': {
      inner = runWarFrenzy(s, regionId, log);
      // After War Frenzy resolves (no pendingAction), continue the region's
      // normal sequence: normal battle (unless Euphoric Haze skips it).
      if (inner.state.pendingAction === null) {
        const region = inner.state.regions[regionId]!;
        const changerOfFateActive2 = regionCardActive(inner.state, regionId, 'tenzen_changer_of_fate');
        const euphoricHaze = !changerOfFateActive2 && regionCardActive(inner.state, regionId, 'lasha_ecstasy');
        if (!euphoricHaze) {
          inner = runNormalBattle(inner.state, regionId, 0, inner.log);
        } else {
          inner = runPostNormal(inner.state, regionId, inner.log);
        }
      }
      break;
    }
    case 'post_rapture': {
      // Lasha just submitted a rapture_choice; pick up the rest of the region
      // (War Frenzy → normal battle → ...).
      inner = resolveRegionAfterRapture(s, regionId, log);
      break;
    }
  }

  // If the step paused for another choice, return
  if (inner.state.pendingAction) {
    return { state: inner.state, log };
  }

  // Otherwise advance to the next region
  const nextIdx = inner.state.battleState!.currentRegionIndex + 1;
  return resolveFromRegion(inner.state, nextIdx, log);
}

/** Resume after a Corruption's Harvest choice has been submitted. */
export function applyCorruptionHarvestChoice(
  state: GameState,
  action: CorruptionHarvestChoiceAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };
  const { regionId, followerIds } = action;

  // Kill each chosen figure
  for (const fId of followerIds) {
    const r = killFollower(s, regionId, fId, 'gormen', log);
    s = r.state;
  }

  return { state: s, log };
}

/** Resume after a battle hit assignment choice has been submitted. */
export function applyBattleHitAssignment(
  state: GameState,
  action: BattleHitAssignmentAction,
): ApplyResult {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };

  const { regionId, followerIds, peasantsToTake = 0, power: attacker, warFrenzyPartialHits } = action;
  const ctx = state.pendingAction!.context;
  const changerOfFateActive = ctx['changerOfFateActive'] as boolean;

  // Apply War Frenzy partial hits (don't kill, just accumulate on figure for Xarm's normal battle)
  if (warFrenzyPartialHits && warFrenzyPartialHits.length > 0) {
    for (const { followerId, hits } of warFrenzyPartialHits) {
      s = log.apply(s, { type: 'war_frenzy_partial', regionId, followerId, hits });
    }
  }

  // Claim chosen peasants first
  for (let i = 0; i < peasantsToTake; i++) {
    if (!s.regions[regionId]!.tokens.includes('peasant')) break;
    s = claimPeasant(s, regionId, attacker, log);
  }

  // Apply kills for each chosen follower. Track remaining hits so we can't
  // kill more than the attacker paid for (e.g. an upgraded-defense figure
  // that the caller misjudged as defense 1).
  const hitsRemaining = (ctx['hitsRemaining'] as number | undefined) ?? Infinity;
  let hitsLeft = hitsRemaining - peasantsToTake;
  for (const fId of followerIds) {
    // Find figure in powers
    let figure: FollowerInstance | undefined;
    for (const p of s.activePowers) {
      figure = s.powers[p]!.followers.find(f => f.id === fId && f.regionId === regionId);
      if (figure) break;
    }
    if (!figure) continue;

    const defense = effectiveDefense(s, regionId, figure, attacker);
    if (hitsLeft < defense) continue; // not enough hits — skip this kill
    hitsLeft -= defense;

    // Mark as tipped (battle_kill event sets tipped=true in applyEvent)
    s = log.apply(s, { type: 'battle_kill', regionId, attacker, targetPower: figure.power as Power, targetClass: figure.class, targetId: fId });

    // Xarm Heart Offering: draw a chaos card per kill
    if (!changerOfFateActive && regionCardActive(s, regionId, 'xarm_ritual_death') && attacker === 'xarm') {
      s = drawCardForPower(s, 'xarm', log);
    }

    // Xarm Heartrippers upgrade: place 1 corruption token per warrior kill
    if (attacker === 'xarm' &&
        s.powers['xarm']!.upgradesInPlay.includes('xarm_heartrippers_up') &&
        followersInRegion(s, regionId, 'xarm').some(f => f.class === 'warrior')) {
      s = log.apply(s, { type: 'heartrippers_corruption', regionId, tokens: 1 });
    }

    if (attacker === 'tenzen' && !changerOfFateActive) {
      const slots = s.regions[regionId]!.chaosCards;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot?.cardId === 'tenzen_persistence_matrix' && slot.playedBy === 'tenzen') {
          s = log.apply(s, { type: 'card_effect', subtype: 'persistence_matrix_marked', regionId, slotIndex: i as 0 | 1 });
        }
      }
    }
  }

  return { state: s, log };
}

// ─── Region iteration ─────────────────────────────────────────────────────────

function resolveFromRegion(
  state: GameState,
  startIdx: number,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const regions = REGION_ORDER;

  for (let i = startIdx; i < regions.length; i++) {
    const regionId = regions[i]!;
    s = {
      ...s,
      battleState: s.battleState
        ? { ...s.battleState, currentRegionIndex: i }
        : null,
    };

    const result = resolveRegion(s, regionId, log);
    s = result.state;
    log = result.log;

    if (s.pendingAction !== null) {
      return { state: s, log };
    }
  }

  // All regions done — apply end-of-battle effects then move to corruption
  return finalizeBattle(s, log);
}

// ─── Single-region resolution ─────────────────────────────────────────────────

function resolveRegion(
  state: GameState,
  regionId: RegionId,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const region = s.regions[regionId]!;
  const activePowers = s.activePowers;

  // Determine which powers have figures here (controlling = controlledBy ?? power)
  const regionFigures = followersInRegion(s, regionId);
  const powersPresent = activePowers.filter(p =>
    regionFigures.some(f => (f.controlledBy ?? f.power) === p)
  );

  // War Zone: no battles if event token in region
  if (isWorldCardActive(s, 'mittelreich_diplomacy') && region.tokens.includes('event')) {
    return { state: s, log };
  }

  // Check if any power can roll dice (attack > 0 or War Frenzy present)
  const hasWarFrenzy = regionCardActive(s, regionId, 'xarm_war_frenzy');
  const xarmPresent = powersPresent.includes('xarm');

  // War Frenzy fires even if xarm has no figures in the region — the card
  // itself acts as xarm's "presence" for pre-battle dice rolls.
  const effectivePowers = (hasWarFrenzy && !xarmPresent)
    ? [...powersPresent, 'xarm' as const]
    : powersPresent;

  const powersThatCanRoll = effectivePowers.filter(p => {
    const totalAttack = getTotalAttack(s, regionId, p);
    return totalAttack > 0 || (p === 'xarm' && hasWarFrenzy);
  });

  // Battle occurs if someone can roll and there are targets
  const hasPeasants = region.tokens.includes('peasant');
  const hasEnemyTargets = (attacker: Power) =>
    powersPresent.some(p => p !== attacker) || hasPeasants;

  const battleOccurs = powersThatCanRoll.some(p => hasEnemyTargets(p));
  if (!battleOccurs) return { state: s, log };

  // Emit region start event
  log.emit({ type: 'battle_region_start', regionId });

  // Detect card effects (Null Weave cancels all other card text)
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

  // ── Beginning-of-battle: Rapture upgrade (Lasha) ─────────────────────────
  // Pause for player choice when 2+ enemy Cultists/Warriors are eligible;
  // auto-pick when there's only one (no real choice).
  if (!changerOfFateActive && powersPresent.includes('lasha') &&
      s.powers['lasha']!.upgradesInPlay.includes('lasha_rapture_up')) {
    const raptureRegionFigs = followersInRegion(s, regionId);
    const rapture = raptureRegionFigs.find(
      f => f.class === 'incarnation' && (f.controlledBy ?? f.power) === 'lasha'
    );
    if (rapture) {
      const targets = raptureRegionFigs.filter(f => {
        const ctrl = f.controlledBy ?? f.power;
        return ctrl !== 'lasha' && (f.class === 'cultist' || f.class === 'warrior');
      });
      if (targets.length >= 2) {
        return pauseForRaptureChoice(s, regionId, targets.map(t => t.id), log);
      }
      const target = targets[0];
      if (target) {
        s = log.apply(s, { type: 'rapture_control', regionId, targetPower: target.power as Power, targetClass: target.class, targetId: target.id });
      }
    }
  }

  return resolveRegionAfterRapture(s, regionId, log);
}

/** Continuation of `resolveRegion` after the (possibly interactive) Rapture
 *  enthrall step. Called both from the initial path and from `resumeBattle`
 *  when the player has just submitted a `rapture_choice`. */
function resolveRegionAfterRapture(
  state: GameState,
  regionId: RegionId,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const region = s.regions[regionId]!;
  const regionFigures = followersInRegion(s, regionId);
  const powersPresent = s.activePowers.filter(p =>
    regionFigures.some(f => (f.controlledBy ?? f.power) === p)
  );
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');
  const hasWarFrenzy = regionCardActive(s, regionId, 'xarm_war_frenzy');
  // Ecstasy: "No figures roll battle dice in this region this round." This
  // suppresses every dice-rolling step — War Frenzy, normal battle, and
  // Undying Fury (gated below). Computed up-front so the War Frenzy block
  // can also check it.
  const euphoricHaze = !changerOfFateActive && regionCardActive(s, regionId, 'lasha_ecstasy');

  // ── Beginning-of-battle: War Frenzy ──────────────────────────────────────
  if (!changerOfFateActive && !euphoricHaze && hasWarFrenzy && powersPresent.some(p => p !== 'xarm')) {
    const wfResult = runWarFrenzy(s, regionId, log);
    s = wfResult.state;
    log = wfResult.log;
    if (s.pendingAction !== null) return { state: s, log };
  }

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

  // unused — region/peasants only referenced inside conditionals above
  void region;
  return { state: s, log };
}

function pauseForRaptureChoice(
  state: GameState,
  regionId: RegionId,
  candidateIds: string[],
  log: GameLog,
): { state: GameState; log: GameLog } {
  const s: GameState = {
    ...state,
    battleState: {
      ...state.battleState!,
      nextStep: { type: 'post_rapture' },
    },
    pendingAction: {
      waitingFor: 'lasha',
      actionKind: 'rapture_choice',
      context: { regionId, candidateIds },
    },
  };
  log.emit({
    type: 'awaiting_action',
    power: 'lasha',
    actionKind: 'rapture_choice',
    context: { regionId, candidateIds },
    description: `${regionId}: Lasha must choose an enemy Cultist or Warrior to enthrall via The Rapture.`,
  });
  return { state: s, log };
}

/** Resume after Lasha submitted a rapture_choice. Re-validates the target,
 *  applies the rapture_control event, then continues the region's pipeline. */
export function applyRaptureChoice(
  state: GameState,
  action: RaptureChoiceAction,
): { state: GameState; log: GameLog } {
  const log = new GameLog();
  let s: GameState = { ...state, pendingAction: null };
  const { regionId, targetFollowerId } = action;

  const figs = followersInRegion(s, regionId);
  const target = figs.find(f => f.id === targetFollowerId);
  if (!target) {
    throw new Error(`rapture_choice: target ${targetFollowerId} not in ${regionId}`);
  }
  const ctrl = target.controlledBy ?? target.power;
  if (ctrl === 'lasha' || (target.class !== 'cultist' && target.class !== 'warrior')) {
    throw new Error(`rapture_choice: ${targetFollowerId} is not a valid Rapture target`);
  }

  s = log.apply(s, {
    type: 'rapture_control',
    regionId,
    targetPower: target.power as Power,
    targetClass: target.class,
    targetId: target.id,
  });
  return { state: s, log };
}

function runWarFrenzy(
  state: GameState,
  regionId: RegionId,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

  let hits: number;
  let rolls: number[];
  const consumed = consumeCompanionHits(s, 'xarm', 'war_frenzy');
  if (consumed) {
    s = consumed.state;
    hits = consumed.hits;
    rolls = [];
  } else if (shouldPauseForCompanionRoll(s, 'xarm')) {
    return pauseForCompanionRoll(
      s, regionId, 'xarm', 2, 'war_frenzy',
      { type: 'war_frenzy_step' },
      log,
    );
  } else {
    const rng = makeBattleRng(s);
    rolls = rollWithExplosions(2, rng);
    hits = countHits(rolls);
  }
  s = { ...s, actionCount: s.actionCount + 1 };
  log.emit({ type: 'action_applied', actionCount: s.actionCount });
  log.emit({ type: 'battle_roll', regionId, power: 'xarm', dice: rolls, hits, kind: 'war_frenzy' });

  if (hits > 0) {
    const peasantsAvailableWF = s.regions[regionId]!.tokens.filter(t => t === 'peasant').length;
    const enemiesWF = getEnemyFigures(s, regionId, 'xarm', changerOfFateActive);
    const canKillWF = enemiesWF.some((e) => e.defense <= hits);
    if (peasantsAvailableWF > 0 || canKillWF) {
      return pauseForHitChoice(
        s, regionId, 'xarm', hits, changerOfFateActive,
        { type: 'normal_battle', powerIndex: 0, clearTipped: true },
        log,
        { isWarFrenzy: true },
      );
    }
  }
  return { state: s, log };
}

// ─── Step-based region resolution ────────────────────────────────────────────

function runNormalBattle(
  state: GameState,
  regionId: RegionId,
  startPowerIndex: number,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');
  const euphoricHaze = !changerOfFateActive && regionCardActive(s, regionId, 'lasha_ecstasy');
  if (euphoricHaze) {
    return runPostNormal(s, regionId, log);
  }

  const chokepoint = isWorldCardActive(s, 'the_chokepoint') && s.regions[regionId]!.tokens.includes('event');
  const activePowers = s.activePowers;
  const normalFigs = followersInRegion(s, regionId);
  const powersPresent = activePowers.filter(p =>
    normalFigs.some(f => (f.controlledBy ?? f.power) === p)
  );

  for (let i = startPowerIndex; i < activePowers.length; i++) {
    const power = activePowers[i]!;
    if (!powersPresent.includes(power)) continue;

    const totalAttack = getTotalAttack(s, regionId, power);
    if (totalAttack === 0) continue;

    const diceCap = chokepoint ? 1 : totalAttack;
    let hits: number;
    let rolls: number[];
    const consumed = consumeCompanionHits(s, power, 'normal');
    if (consumed) {
      s = consumed.state;
      hits = consumed.hits;
      rolls = [];
    } else if (shouldPauseForCompanionRoll(s, power)) {
      return pauseForCompanionRoll(
        s, regionId, power, diceCap, 'normal',
        { type: 'normal_battle', powerIndex: i },
        log,
      );
    } else {
      const rng = makeBattleRng(s);
      rolls = rollWithExplosions(diceCap, rng);
      hits = countHits(rolls);
    }
    s = { ...s, actionCount: s.actionCount + 1 };
    log.emit({ type: 'action_applied', actionCount: s.actionCount });
    log.emit({ type: 'battle_roll', regionId, power, dice: rolls, hits, kind: 'normal' });

    if (hits > 0) {
      const peasantsAvailable = s.regions[regionId]!.tokens.filter(t => t === 'peasant').length;
      const enemies = getEnemyFigures(s, regionId, power, changerOfFateActive);
      const canKill = enemies.some((e) => e.defense <= hits);

      if (peasantsAvailable > 0 || canKill) {
        // Determine what to do after this choice is resolved
        const isLastPower = i === activePowers.length - 1 ||
          !activePowers.slice(i + 1).some(p => {
            const pp = followersInRegion(s, regionId, p).length > 0;
            return pp && getTotalAttack(s, regionId, p) > 0;
          });
        const nextStep: BattleNextStep = isLastPower
          ? { type: 'post_normal' }
          : { type: 'normal_battle', powerIndex: i + 1 };
        return pauseForHitChoice(s, regionId, power, hits, changerOfFateActive, nextStep, log);
      }
    }
  }

  return runPostNormal(s, regionId, log);
}

function runPostNormal(
  state: GameState,
  regionId: RegionId,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

  // ── Remove tipped figures ─────────────────────────────────────────────────
  const postNormalFigs = followersInRegion(s, regionId);
  const tipped = postNormalFigs.filter(f => f.tipped);
  const xarmPresent = s.activePowers.includes('xarm') &&
    postNormalFigs.some(f => (f.controlledBy ?? f.power) === 'xarm');
  const enemiesKilledByXarm = xarmPresent &&
    tipped.some(f => (f.controlledBy ?? f.power) !== 'xarm') &&
    getTotalAttack(state, regionId, 'xarm') > 0;

  for (const f of tipped) {
    const r = removeFigureFromBoard(s, regionId, f.id, log);
    s = r.state;
  }

  // Xarm dial advancement — at most once per (region, phase). The dial_counter
  // event handler appends this region to xarm.dacRegionsThisPhase, so a
  // second kill in the same region (e.g. War Frenzy then normal battle) won't
  // double-award.
  if (enemiesKilledByXarm && !s.powers['xarm']!.dacRegionsThisPhase.includes(regionId)) {
    s = log.apply(s, { type: 'dial_counter', regionId, power: 'xarm' as Power });
  }

  // ── Undying Fury ─────────────────────────────────────────────────────────
  const euphoricHaze = !changerOfFateActive && regionCardActive(s, regionId, 'lasha_ecstasy');
  if (!changerOfFateActive && regionCardActive(s, regionId, 'xarm_bloody_rebirth') && !euphoricHaze) {
    return runUndyingFury(s, regionId, 0, log);
  }

  return runPostUndying(s, regionId, log);
}

function runUndyingFury(
  state: GameState,
  regionId: RegionId,
  startPowerIndex: number,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');
  const chokepoint = isWorldCardActive(s, 'the_chokepoint') && s.regions[regionId]!.tokens.includes('event');
  const activePowers = s.activePowers;

  for (let i = startPowerIndex; i < activePowers.length; i++) {
    const power = activePowers[i]!;
    const totalAttack = getTotalAttack(s, regionId, power);
    if (totalAttack === 0) continue;

    const diceCap = chokepoint ? 1 : totalAttack;
    let hits: number;
    let rolls: number[];
    const consumed = consumeCompanionHits(s, power, 'undying_fury');
    if (consumed) {
      s = consumed.state;
      hits = consumed.hits;
      rolls = [];
    } else if (shouldPauseForCompanionRoll(s, power)) {
      return pauseForCompanionRoll(
        s, regionId, power, diceCap, 'undying_fury',
        { type: 'undying_fury', powerIndex: i },
        log,
      );
    } else {
      const rng = makeBattleRng(s);
      rolls = rollWithExplosions(diceCap, rng);
      hits = countHits(rolls);
    }
    s = { ...s, actionCount: s.actionCount + 1 };
    log.emit({ type: 'action_applied', actionCount: s.actionCount });
    log.emit({ type: 'battle_roll', regionId, power, dice: rolls, hits, kind: 'undying_fury' });

    if (hits > 0) {
      const peasantsAvailableUF = s.regions[regionId]!.tokens.filter(t => t === 'peasant').length;
      const enemiesUF = getEnemyFigures(s, regionId, power, changerOfFateActive);
      const canKillUF = enemiesUF.some((e) => e.defense <= hits);
      if (peasantsAvailableUF > 0 || canKillUF) {
        const isLastPower = i === activePowers.length - 1 ||
          !activePowers.slice(i + 1).some(p => getTotalAttack(s, regionId, p) > 0);
        const nextStep: BattleNextStep = isLastPower
          ? { type: 'post_undying' }
          : { type: 'undying_fury', powerIndex: i + 1 };
        return pauseForHitChoice(s, regionId, power, hits, changerOfFateActive, nextStep, log);
      }
    }
  }

  return runPostUndying(s, regionId, log);
}

function runPostUndying(
  state: GameState,
  regionId: RegionId,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;
  const changerOfFateActive = regionCardActive(s, regionId, 'tenzen_changer_of_fate');

  // Remove newly tipped figures from undying fury round
  const tipped2 = followersInRegion(s, regionId).filter(f => f.tipped);
  for (const f of tipped2) {
    const r = removeFigureFromBoard(s, regionId, f.id, log);
    s = r.state;
  }

  // Reset warFrenzyHits on all surviving figures in this region
  const surviving = followersInRegion(s, regionId).filter(f => f.warFrenzyHits > 0);
  const clearedIds: string[] = surviving.map(f => f.id);
  if (clearedIds.length > 0) {
    s = log.apply(s, { type: 'battle_cleanup', clearedWarFrenzyHits: clearedIds, resetDialCounters: false });
  }

  // ── End-of-battle: Corruption's Harvest ──────────────────────────────────
  if (!changerOfFateActive && regionCardActive(s, regionId, 'gormen_inevitable_rot')) {
    const gormenCorr = s.regions[regionId]!.corruptionTokens['gormen'] ?? 0;
    if (gormenCorr > 0) {
      const targets = followersInRegion(s, regionId).filter(f => {
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
        log.emit({ type: 'awaiting_action', power: 'gormen', actionKind: 'corruption_harvest_choice', context: { regionId, maxKills: gormenCorr }, description: `${regionId}: ${CARD_BY_ID['gormen_inevitable_rot']!.name} — Gormen may kill up to ${gormenCorr} enemy figure(s). Waiting for choice.` });
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
  changerOfFateActive: boolean,
  nextStep: BattleNextStep,
  log: GameLog,
  extraContext: Record<string, unknown> = {},
): { state: GameState; log: GameLog } {
  const peasantsAvailable = state.regions[regionId]!.tokens.filter(t => t === 'peasant').length;
  const context = { regionId, hitsRemaining, changerOfFateActive, peasantsAvailable, ...extraContext };
  const s: GameState = {
    ...state,
    battleState: {
      ...state.battleState!,
      nextStep,
    },
    pendingAction: {
      waitingFor: attacker,
      actionKind: 'battle_hit_assignment',
      context,
    },
  };
  // Emit the full context so clients that rebuild state by replaying events
  // (e.g. during battle animation) see the same pendingAction.context as
  // server-side state. Otherwise the hit-assignment UI loses fields like
  // peasantsAvailable until the player reloads the page.
  log.emit({ type: 'awaiting_action', power: attacker, actionKind: 'battle_hit_assignment', context, description: `${regionId}: ${attacker} must assign ${hitsRemaining} hit(s). Waiting for choice.` });
  return { state: s, log };
}

// ─── Hit assignment helpers ──────────────────────────────────────────────────

/**
 * Effective defense of a figure in a given region against a given attacker.
 * Accounts for the owner's defense upgrade, Rotting Grasp (−1 non-Gormen),
 * Blight Ward (+1 Gormen), War Frenzy partial-hit carry-over, and Changer
 * of Fate cancellation of card effects.
 */
export function effectiveDefense(
  state: GameState,
  regionId: RegionId,
  figure: FollowerInstance,
  attacker: Power,
): number {
  const owner = figure.power as Power;
  const def = FOLLOWERS[owner]![figure.class]!;
  const isUpgraded = state.powers[owner]!.upgradesInPlay.some(u =>
    UPGRADES.find(up => up.id === u)?.upgradeType === figure.class
  );
  let defense = isUpgraded ? def.upgraded.defense : def.base.defense;

  const changerOfFateActive = regionCardActive(state, regionId, 'tenzen_changer_of_fate');
  const hasRottingGrasp = !changerOfFateActive && regionCardActive(state, regionId, 'gormen_pestilent_touch');
  const hasBlightWard = !changerOfFateActive && regionCardActive(state, regionId, 'gormen_rain_of_bile');

  if (hasBlightWard && owner === 'gormen') defense += 1;
  if (hasRottingGrasp && owner !== 'gormen') defense = Math.max(1, defense - 1);
  if (attacker === 'xarm' && figure.warFrenzyHits > 0) defense = Math.max(1, defense - figure.warFrenzyHits);

  return defense;
}

function getEnemyFigures(
  state: GameState,
  regionId: RegionId,
  attacker: Power,
  changerOfFateActive: boolean,
): Array<{ figure: FollowerInstance; defense: number }> {
  const hasRottingGrasp = !changerOfFateActive && regionCardActive(state, regionId, 'gormen_pestilent_touch');
  const hasBlightWard = !changerOfFateActive && regionCardActive(state, regionId, 'gormen_rain_of_bile');

  return followersInRegion(state, regionId)
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

      // War Frenzy carry-over: partial hits from War Frenzy reduce effective defense for Xarm only
      if (attacker === 'xarm' && f.warFrenzyHits > 0) defense = Math.max(1, defense - f.warFrenzyHits);

      return { figure: f, defense };
    })
    .sort((a, b) => a.defense - b.defense);
}

// ─── Peasant claiming ─────────────────────────────────────────────────────────

function claimPeasant(
  state: GameState,
  regionId: RegionId,
  claimedBy: Power,
  log: GameLog,
): GameState {
  if (!state.regions[regionId]!.tokens.includes('peasant')) return state;
  const total = state.powers[claimedBy]!.claimedPeasants + 1;
  return log.apply(state, { type: 'peasant_claimed', regionId, power: claimedBy, total });
}

// ─── Remove figure from board ─────────────────────────────────────────────────

function removeFigureFromBoard(
  state: GameState,
  regionId: RegionId,
  followerId: string,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;

  // Detect "The Rapture was killed": release any Lasha-controlled enemies in
  // this region that were enthralled via the Rapture upgrade. Per the upgrade
  // text, control ends "or until The Rapture is killed". Skip enemies still
  // controlled by an active Narcotic Musk card in the same region.
  const removed = (() => {
    for (const power of s.activePowers) {
      const f = s.powers[power]!.followers.find(f => f.id === followerId);
      if (f) return { power, follower: f };
    }
    return null;
  })();
  const lashaHasRaptureUp = s.powers['lasha']?.upgradesInPlay.includes('lasha_rapture_up') ?? false;
  if (removed && removed.power === 'lasha' && removed.follower.class === 'incarnation' && lashaHasRaptureUp) {
    const muskHere = s.regions[regionId]!.chaosCards.some(
      c => c?.cardId === 'lasha_narcotic_musk' && c.playedBy === 'lasha',
    );
    for (const power of s.activePowers) {
      if (power === 'lasha') continue;
      for (const f of s.powers[power]!.followers) {
        if (f.regionId !== regionId) continue;
        if (f.controlledBy !== 'lasha') continue;
        // Musk only enthralls cultists; if a musk card is here, leave the cultist controlled.
        if (muskHere && f.class === 'cultist') continue;
        s = log.apply(s, { type: 'control_released', followerId: f.id, power: f.power as Power });
      }
    }
  }

  // Find which power owns this figure and mark it in reserve
  for (const power of s.activePowers) {
    const follower = s.powers[power]!.followers.find(f => f.id === followerId);
    if (follower) {
      s = log.apply(s, { type: 'figure_removed', regionId, power, followerId });
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
  killedBy: Power,
  log: GameLog,
): { state: GameState; log: GameLog } {
  const figure = followersInRegion(state, regionId).find(f => f.id === followerId);
  if (!figure) return { state, log };
  let s = log.apply(state, { type: 'harvest_kill', regionId, killedBy, targetPower: figure.power as Power, targetClass: figure.class, followerId });
  // figure_removed is emitted for informational purposes; harvest_kill already removed the figure
  log.emit({ type: 'figure_removed', regionId, power: figure.power as Power, followerId });
  return { state: s, log };
}

// ─── Post-all-regions: end-of-battle effects ──────────────────────────────────

function finalizeBattle(
  state: GameState,
  log: GameLog,
): { state: GameState; log: GameLog } {
  let s = state;

  // Armistice end-of-battle: each player removes 1 figure per event-token region
  if (isWorldCardActive(s, 'eastern_armistice')) {
    for (const regionId of REGION_ORDER) {
      if (!s.regions[regionId]!.tokens.includes('event')) continue;
      for (const power of s.activePowers) {
        const figures = followersInRegion(s, regionId, power);
        if (figures.length === 0) continue;
        // Auto-remove weakest figure
        const target = figures.sort((a, b) =>
          classRank(a.class) - classRank(b.class)
        )[0]!;
        s = log.apply(s, { type: 'world_card_effect', subtype: 'eastern_armistice', power, regionId, followerClass: target.class, followerId: target.id });
      }
    }
  }

  // Clear per-round flags: protected (Fate's Aegis).
  // NOTE: Rapture-granted control is NOT released here — per the upgrade text
  // ("until end of round or until The Rapture is killed"), it persists through
  // the corruption phase and is released alongside other end-of-round
  // discards in the End Phase. Rapture death triggers immediate release in
  // `removeFigureFromBoard` instead.
  for (const power of s.activePowers) {
    const p = s.powers[power]!;
    const protectedIds = p.followers.filter(f => f.protected).map(f => f.id);
    if (protectedIds.length > 0) {
      s = log.apply(s, { type: 'protected_cleared', followerIds: protectedIds });
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
  let total = 0;

  for (const f of followersInRegion(state, regionId, power)) {
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

function drawCardForPower(state: GameState, power: Power, log: GameLog): GameState {
  const p = state.powers[power]!;
  let { deckIds, discardIds } = p;

  if (deckIds.length === 0 && discardIds.length === 0) return state;

  if (deckIds.length === 0) {
    const rng = makeBattleRng(state);
    deckIds = shuffle([...discardIds], rng);
    discardIds = [];
  }

  const drawn = deckIds[0]!;
  const newDeck = deckIds.slice(1);
  return log.apply(state, { type: 'card_drawn', power, cardId: drawn, source: CARD_BY_ID['xarm_ritual_death']!.name, deckIds: newDeck, discardIds });
}

// ─── RNG ─────────────────────────────────────────────────────────────────────

function makeBattleRng(state: GameState) {
  return makeRng(state.rngSeed ^ (state.actionCount * 2654435761));
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function classRank(cls: 'cultist' | 'warrior' | 'incarnation'): number {
  return cls === 'cultist' ? 0 : cls === 'warrior' ? 1 : 2;
}

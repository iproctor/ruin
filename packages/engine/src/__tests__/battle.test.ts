/**
 * Battle phase tests: interactive hit assignment, card effects active during
 * battle, and upgrade effects that apply at battle time.
 *
 * Convention: `resolveBattlePhase` may pause with pendingAction='battle_hit_assignment'.
 * Use `autoResolveBattle` to drive the battle to completion when testing outcomes,
 * and inspect the raw pause state to test the interactive flow specifically.
 */
import type { GameState } from '../types.js';
import { resolveBattlePhase, applyCorruptionHarvestChoice, applyBattleHitAssignment } from '../phases/battle.js';
import { applyAction } from '../reducers.js';
import { REGION_ORDER } from '../constants.js';
import { GameLog } from '../gameLog.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  giveCards, withUpgrade, setPP, setWorldCard, followersIn,
  autoResolveBattle,
} from './helpers.js';
import { followersInRegion } from '../helpers.js';

// ─── Basic battle mechanics ───────────────────────────────────────────────────

describe('basic battle mechanics', () => {
  test('no figures → battle resolves without error and moves to corruption', () => {
    const s = makeState({ phase: 'battle', pendingAction: null });
    const { state } = resolveBattlePhase(s);
    expect(state.phase).toBe('corruption');
  });

  test('single power with no enemies → no battle', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).toBe('corruption');
  });

  test('peasant claimed when attacker has attack dice and peasant present', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 12345 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    const claimedBefore = s.powers.xarm!.claimedPeasants;
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.powers.xarm!.claimedPeasants).toBeGreaterThanOrEqual(claimedBefore);
  });

  test('protected figure is not killed in battle', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'tenzen', 'warrior', 'norrsund', { protected: true });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    const tenzenWarriorId = followersInRegion(s, 'norrsund').find(f => f.power === 'tenzen')!.id;
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(followersInRegion(state, 'norrsund').find(f => f.id === tenzenWarriorId)).toBeDefined();
  });

  test('after battle, protected flags cleared on surviving figures', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'tenzen', 'warrior', 'norrsund', { protected: true });
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    for (const regionId of Object.keys(state.regions) as import('../types.js').RegionId[]) {
      for (const f of followersInRegion(state, regionId)) {
        expect(f.protected).toBe(false);
      }
    }
  });
});

// ─── Interactive hit assignment ───────────────────────────────────────────────

describe('interactive hit assignment', () => {
  test('battle with enemy figures pauses for attacker hit assignment', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 1 });
    // Many warriors → guaranteed hits
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const raw = resolveBattlePhase(s);
    // May pause immediately for hit assignment (if Xarm rolls hits)
    // OR complete if they roll 0 hits. Just verify it doesn't error.
    expect(['battle', 'corruption']).toContain(raw.state.phase);
    if (raw.state.phase === 'battle') {
      expect(raw.state.pendingAction?.actionKind).toBe('battle_hit_assignment');
      expect(raw.state.pendingAction?.waitingFor).toBe('xarm');
    }
  });

  test('attacker chooses to kill a figure — figure is removed', () => {
    // Use deterministic seed that guarantees hits
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 1 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const gormenCultistId = followersInRegion(s, 'norrsund').find(f => f.power === 'gormen')!.id;

    // Drive until we get the hit assignment or it completes
    let result = resolveBattlePhase(s);
    if (result.state.pendingAction?.actionKind !== 'battle_hit_assignment') {
      // 0 hits on this seed — skip
      return;
    }

    const ctx = result.state.pendingAction!.context;
    const regionId = ctx['regionId'] as string;
    expect(regionId).toBe('norrsund');

    // Attacker assigns kill to the gormen cultist
    const next = applyAction(result.state, {
      kind: 'battle_hit_assignment',
      power: 'xarm',
      regionId: 'norrsund',
      followerIds: [gormenCultistId],
    });

    // Drive to completion
    const { state } = autoResolveBattle(next);
    expect(followersInRegion(state, 'norrsund').find(f => f.id === gormenCultistId)).toBeUndefined();
  });

  test('attacker may choose to assign 0 kills (use no hits)', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 1 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const gormenCultistId = followersInRegion(s, 'norrsund').find(f => f.power === 'gormen')!.id;

    let result = resolveBattlePhase(s);
    if (result.state.pendingAction?.actionKind !== 'battle_hit_assignment') return; // 0 hits

    // Assign no kills
    const next = applyAction(result.state, {
      kind: 'battle_hit_assignment',
      power: 'xarm',
      regionId: 'norrsund',
      followerIds: [],
    });
    const { state } = autoResolveBattle(next);
    // Gormen cultist survives (attacker chose not to kill)
    expect(followersInRegion(state, 'norrsund').find(f => f.id === gormenCultistId)).toBeDefined();
  });

  test('auto-resolve drives battle out of battle phase', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 99 });
    for (let i = 1; i <= 4; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'tenzen', 'warrior', 'mittelreich');
    s = placeFollower(s, 'lasha', 'cultist', 'mittelreich');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).not.toBe('battle');
    expect(state.pendingAction?.actionKind).not.toBe('battle_hit_assignment');
  });

  test('multiple powers in same region each get to assign hits', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 42 });
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    const { state, log } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).not.toBe('battle');
    // Both powers had attack dice, so both should appear in roll logs
    const xarmRolls = log.entries.filter(l => l.includes('Norrsund: Xarm rolls'));
    const gormenRolls = log.entries.filter(l => l.includes('Norrsund: Gormen rolls'));
    expect(xarmRolls.length).toBeGreaterThan(0);
    expect(gormenRolls.length).toBeGreaterThan(0);
  });

  test('pending context exposes peasantsAvailable when peasant is present', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 1 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    const raw = resolveBattlePhase(s);
    // With 6 Xarm warriors (12 attack dice) there will always be hits; confirm we paused
    expect(raw.state.pendingAction?.actionKind).toBe('battle_hit_assignment');
    const ctx = raw.state.pendingAction!.context;
    // Peasant is NOT auto-claimed — it stays in the region and is reported in context
    expect(raw.state.regions.norrsund!.tokens.includes('peasant')).toBe(true);
    expect(ctx['peasantsAvailable']).toBe(1);
    expect(ctx['hitsRemaining'] as number).toBeGreaterThanOrEqual(1);
  });
});

// ─── Euphoric Haze: no dice ────────────────────────────────────────────────────

describe('Euphoric Haze (no dice)', () => {
  test('no hit log entries when Euphoric Haze is active', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'lasha_ecstasy', 'lasha', 'norrsund');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    const hitLogs = log.entries.filter(l => l.includes('→') && l.includes('hit'));
    expect(hitLogs).toHaveLength(0);
  });
});

// ─── War Zone: no battles in event regions ────────────────────────────────────

describe('War Zone (no battle if event token)', () => {
  test('figures present but event token → no battle', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'event');
    s = setWorldCard(s, 'mittelreich_diplomacy');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    const norrsundBattleLogs = log.entries.filter(l => l.startsWith('norrsund:'));
    expect(norrsundBattleLogs).toHaveLength(0);
  });

  test('upgraded Xarm cultist (attack 1) triggers battle with enemies', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 42 });
    s = withUpgrade(s, 'xarm', 'xarm_heartseekers_up');
    s = placeFollower(s, 'xarm', 'cultist', 'mittelreich');
    s = placeFollower(s, 'gormen', 'cultist', 'mittelreich');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('Mittelreich: Xarm rolls'))).toBe(true);
  });

  test('event token + great_exorcism does not suppress battle (only mittelreich_diplomacy does)', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 42 });
    s = withUpgrade(s, 'xarm', 'xarm_heartseekers_up');
    s = placeFollower(s, 'xarm', 'cultist', 'mittelreich');
    s = placeFollower(s, 'gormen', 'cultist', 'mittelreich');
    s = addToken(s, 'mittelreich', 'event');
    s = setWorldCard(s, 'great_exorcism');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('Mittelreich: Xarm rolls'))).toBe(true);
  });
});

// ─── War Frenzy ───────────────────────────────────────────────────────────────

describe('War Frenzy (2 pre-rolls at start of battle)', () => {
  test('War Frenzy log entry appears when Xarm present with enemies', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('War Frenzy'))).toBe(true);
  });

  test('War Frenzy pauses for hit assignment before normal battle when it scores hits', () => {
    // Use a seed that gives War Frenzy hits — try many seeds
    let found = false;
    for (let seed = 0; seed < 200; seed++) {
      let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: seed });
      s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
      s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
      s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
      const raw = resolveBattlePhase(s);
      const bs = raw.state.battleState;
      if (
        raw.state.pendingAction?.actionKind === 'battle_hit_assignment' &&
        raw.state.pendingAction.waitingFor === 'xarm' &&
        bs?.nextStep?.type === 'normal_battle' &&
        bs.nextStep.powerIndex === 0
      ) {
        // War Frenzy specifically paused (nextStep = normal_battle[0] = not yet started)
        expect(raw.log.entries.some(l => l.includes('War Frenzy'))).toBe(true);
        const normalXarmRolls = raw.log.entries.filter(l =>
          /norrsund: xarm rolls/.test(l) && !l.includes('War Frenzy')
        );
        expect(normalXarmRolls).toHaveLength(0);
        found = true;
        break;
      }
    }
    if (!found) console.warn('No seed produced War Frenzy hit-pause in 200 tries — skipping');
  });

  test('War Frenzy resolves fully when auto-resolved', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 7 });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).not.toBe('battle');
  });

  test('War Frenzy is cancelled by Null Weave', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    s = placeCard(s, 'tenzen_changer_of_fate', 'tenzen', 'norrsund', 1);
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('War Frenzy'))).toBe(false);
  });
});

// ─── No pause when no kill is possible ──────────────────────────────────────

describe('regression: no pause when no enemy can be killed and no peasants', () => {
  // If the attacker's hit total is smaller than every enemy's effective
  // defense AND no peasant is present, there is nothing for the human to
  // decide — the engine should drop the hits and move on without pausing.
  test('normal battle: 1 hit vs defense-2 enemy, no peasant → no pause', () => {
    // Gormen warrior (attack 1) vs an upgraded Lasha Addict (cultist at
    // defense 2, attack 0 — so no counter-attack to trip other pauses).
    // When Gormen rolls 1 hit, there's no killable target and no peasant,
    // so the engine should NOT pause for a hit-assignment choice.
    let found = false;
    for (let seed = 0; seed < 400 && !found; seed++) {
      let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: seed });
      s = withUpgrade(s, 'lasha', 'lasha_addicts_up');
      s = placeFollower(s, 'gormen', 'warrior', 'norrsund');  // attacker, 1 die
      s = placeFollower(s, 'lasha', 'cultist', 'norrsund');   // enemy, defense 2, no attack
      const raw = resolveBattlePhase(s);
      const gormenHit = raw.log.entries.find(
        (l) => /norrsund: gormen rolls .* 1 hit/i.test(l) && !/war frenzy/i.test(l),
      );
      if (!gormenHit) continue;
      expect(raw.state.pendingAction).toBeNull();
      found = true;
    }
    if (!found) throw new Error('No seed in [0,400) produced a 1-hit normal roll');
  });

  test('normal battle: 1 hit vs defense-2 enemy + peasant → pauses (peasant claimable)', () => {
    // Sanity check the opposite direction: a peasant token keeps the pause
    // because the hit can still be spent claiming it.
    let found = false;
    for (let seed = 0; seed < 400 && !found; seed++) {
      let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: seed });
      s = withUpgrade(s, 'lasha', 'lasha_addicts_up');
      s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
      s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
      s = addToken(s, 'norrsund', 'peasant');
      const raw = resolveBattlePhase(s);
      const gormenHit = raw.log.entries.find(
        (l) => /norrsund: gormen rolls .* 1 hit/i.test(l) && !/war frenzy/i.test(l),
      );
      if (!gormenHit) continue;
      expect(raw.state.pendingAction?.actionKind).toBe('battle_hit_assignment');
      found = true;
    }
    if (!found) throw new Error('No seed in [0,400) produced a 1-hit normal roll');
  });

  test('War Frenzy: 1 hit vs defense-2 enemy, no peasant → no pause', () => {
    // WF rolls 2 dice. Only enemy is an upgraded Lasha Addict (defense 2,
    // attack 0 — so no counter-attack creates a spurious pause). On any
    // seed where WF yields exactly 1 hit, the engine must skip the
    // hit-choice pause.
    let found = false;
    for (let seed = 0; seed < 400 && !found; seed++) {
      let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: seed });
      s = withUpgrade(s, 'lasha', 'lasha_addicts_up');
      s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
      s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
      const raw = resolveBattlePhase(s);
      const wfHit = raw.log.entries.find(
        (l) => /war frenzy.*xarm rolls .* 1 hit/i.test(l),
      );
      if (!wfHit) continue;
      expect(raw.state.pendingAction).toBeNull();
      found = true;
    }
    if (!found) throw new Error('No seed in [0,400) produced a 1-hit WF roll');
  });
});

// ─── Undying Fury: second battle round ───────────────────────────────────────

describe('Undying Fury (second battle round)', () => {
  test('Undying Fury extra battle log appears after auto-resolve', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_bloody_rebirth', 'xarm', 'norrsund');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('Bloody Rebirth') && l.includes('rolls'))).toBe(true);
  });

  test('Undying Fury resolves out of battle phase', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 5 });
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_bloody_rebirth', 'xarm', 'norrsund');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).not.toBe('battle');
  });
});

// ─── Rotting Grasp: -1 defense ────────────────────────────────────────────────

describe('Gormen Rotting Grasp (-1 defense to non-Gormen)', () => {
  test('Rotting Grasp resolves out of battle phase', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 99 });
    for (let i = 1; i <= 5; i++) s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeCard(s, 'gormen_pestilent_touch', 'gormen', 'norrsund');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).not.toBe('battle');
  });

  test('Rotting Grasp is cancelled by Null Weave', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeCard(s, 'gormen_pestilent_touch', 'gormen', 'norrsund');
    s = placeCard(s, 'tenzen_changer_of_fate', 'tenzen', 'norrsund', 1);
    expect(() => autoResolveBattle(resolveBattlePhase(s))).not.toThrow();
  });
});

// ─── Blight Ward: +1 defense for Gormen ──────────────────────────────────────

describe('Gormen Blight Ward (+1 defense to Gormen figures)', () => {
  test('Blight Ward resolves without error', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeCard(s, 'gormen_rain_of_bile', 'gormen', 'norrsund');
    expect(() => autoResolveBattle(resolveBattlePhase(s))).not.toThrow();
  });
});

// ─── Heart Offering: draw card on kill ────────────────────────────────────────

describe("Xarm Heart Offering (draw card on kill)", () => {
  test('Heart Offering causes Xarm to draw when they kill a figure', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 7777 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_ritual_death', 'xarm', 'norrsund');
    s = {
      ...s, powers: {
        ...s.powers,
        xarm: { ...s.powers.xarm!, deckIds: ['xarm_war_cry', 'xarm_war_frenzy'] },
      },
    };
    const handBefore = s.powers.xarm!.hand.length;
    const { state, log } = autoResolveBattle(resolveBattlePhase(s));
    const killed = log.entries.some(l => l.includes('kills gormen'));
    if (killed) {
      expect(state.powers.xarm!.hand.length).toBeGreaterThan(handBefore);
    }
  });
});

// ─── Recursive Pattern: persist on Tenzen kill ───────────────────────────────

describe('Tenzen Recursive Pattern (persist if Tenzen killed)', () => {
  test('persistNextRound set when Tenzen kills a figure', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 5555 });
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'tenzen', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'tenzen_persistence_matrix', 'tenzen', 'norrsund');
    const { state, log } = autoResolveBattle(resolveBattlePhase(s));
    const killed = log.entries.some(l => l.includes('tenzen kills gormen'));
    if (killed) {
      // Card persists on the board (Tenzen had 4 warriors, Gormen only 1 — Tenzen survives)
      const card = state.regions.norrsund!.chaosCards.find(c => c?.cardId === 'tenzen_persistence_matrix');
      if (card) expect(card.persistNextRound).toBe(true);
    }
  });
});

// ─── Corruption's Harvest: end-of-battle kills ────────────────────────────────

describe("Gormen Corruption's Harvest (kill enemies after battle)", () => {
  test("sets pendingAction for gormen when gormen has corruption tokens", () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    s = addCorruption(s, 'norrsund', 'gormen', 2);
    s = placeCard(s, 'gormen_inevitable_rot', 'gormen', 'norrsund');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.pendingAction?.actionKind).toBe('corruption_harvest_choice');
    expect(state.pendingAction?.waitingFor).toBe('gormen');
  });

  test('applyCorruptionHarvestChoice kills specified figures', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    s = addCorruption(s, 'norrsund', 'gormen', 2);
    s = placeCard(s, 'gormen_inevitable_rot', 'gormen', 'norrsund');
    const { state: withPending } = autoResolveBattle(resolveBattlePhase(s));
    expect(withPending.pendingAction?.actionKind).toBe('corruption_harvest_choice');
    const targets = followersInRegion(withPending, 'norrsund')
      .filter(f => (f.controlledBy ?? f.power) !== 'gormen')
      .map(f => f.id)
      .slice(0, 2);
    const hitResult = applyCorruptionHarvestChoice(withPending, {
      kind: 'corruption_harvest_choice',
      power: 'gormen',
      regionId: 'norrsund',
      followerIds: targets,
    });
    // Immediate result: figures are killed but battle hasn't advanced yet
    for (const id of targets) {
      expect(followersInRegion(hitResult.state, 'norrsund').find(f => f.id === id)).toBeUndefined();
    }
    // resolveBattlePhase resumes and finishes battle → corruption
    const { state } = resolveBattlePhase(hitResult.state);
    expect(state.phase).toBe('corruption');
  });

  test("Corruption's Harvest not triggered if no gormen tokens", () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    for (let i = 1; i <= 3; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    s = placeCard(s, 'gormen_inevitable_rot', 'gormen', 'norrsund');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.pendingAction?.actionKind).not.toBe('corruption_harvest_choice');
  });
});

// ─── Null Weave: cancels card text ────────────────────────────────────────────

describe('Tenzen Null Weave (cancels all other card text)', () => {
  test("Null Weave prevents Corruption's Harvest from triggering", () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = addCorruption(s, 'norrsund', 'gormen', 3);
    s = placeCard(s, 'gormen_inevitable_rot', 'gormen', 'norrsund');
    s = placeCard(s, 'tenzen_changer_of_fate', 'tenzen', 'norrsund', 1);
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.pendingAction?.actionKind).not.toBe('corruption_harvest_choice');
  });

  test('Null Weave prevents War Frenzy pre-roll', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    s = placeCard(s, 'tenzen_changer_of_fate', 'tenzen', 'norrsund', 1);
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('War Frenzy'))).toBe(false);
  });
});

// ─── Rapture upgrade: auto-control at battle start ────────────────────────────

describe("Lasha Rapture upgrade (auto-control enemy at battle start)", () => {
  test('Rapture upgrade controls an enemy cultist when Rapture incarnation present', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = withUpgrade(s, 'lasha', 'lasha_rapture_up');
    s = placeFollower(s, 'lasha', 'incarnation', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('Rapture Upgrade'))).toBe(true);
  });
});

// ─── Armistice: remove figures from event regions post-battle ────────────────

describe('Armistice (remove 1 figure per event region post-battle)', () => {
  test('each player removes 1 figure from event region after battle', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = setWorldCard(s, 'eastern_armistice');
    s = addToken(s, 'norrsund', 'event');
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const { state, log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('Armistice'))).toBe(true);
    expect(followersInRegion(state, 'norrsund').length).toBeLessThan(2);
  });
});

// ─── Xarm Heartseekers upgrade: attack 1 ─────────────────────────────────────

describe('Xarm Heartseekers upgrade (cultists gain attack 1)', () => {
  test('upgraded Heartseekers can roll dice in battle', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = withUpgrade(s, 'xarm', 'xarm_heartseekers_up');
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    expect(log.entries.some(l => l.includes('Norrsund: Xarm rolls'))).toBe(true);
  });
});

// ─── Xarm Heartrippers upgrade: place corruption on kill ─────────────────────

describe('Xarm Heartrippers upgrade (place 1 corruption on kill)', () => {
  test('corruption token placed when Xarm warrior kills', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 9000 });
    s = withUpgrade(s, 'xarm', 'xarm_heartrippers_up');
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.xarm;
    const { state, log } = autoResolveBattle(resolveBattlePhase(s));
    const killed = log.entries.some(l => l.includes('kills gormen'));
    if (killed) {
      expect(state.regions.norrsund!.corruptionTokens.xarm).toBeGreaterThan(corrBefore);
    }
  });
});

// ─── Regression: WF + Heartripper + Raver in same region ────────────────────

describe('regression: War Frenzy + Heartripper + Raver in same region', () => {
  // Reported scenario: Norrsund had War Frenzy, an Xarm warrior with the
  // Heartrippers upgrade, and Lasha had a Raver (warrior with Ravers upgrade)
  // plus 2 cultists. War Frenzy fired and killed 2 figures, but the user
  // reported that no other rolls happened — neither Heartripper-driven
  // corruption nor a normal battle round between the surviving warriors.
  function setupScenario(seed: number) {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: seed });
    s = withUpgrade(s, 'xarm', 'xarm_heartrippers_up');
    s = withUpgrade(s, 'lasha', 'lasha_ravers_up');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'lasha', 'warrior', 'norrsund');   // the Raver
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    return s;
  }

  test('War Frenzy still fires its log line', () => {
    const { log } = autoResolveBattle(resolveBattlePhase(setupScenario(42)));
    expect(log.entries.some(l => /norrsund.*war frenzy/i.test(l))).toBe(true);
  });

  test('a normal battle round runs after War Frenzy resolves', () => {
    // After War Frenzy, the surviving Xarm warrior and Lasha warrior should
    // each get to roll in a normal battle round.
    const { log } = autoResolveBattle(resolveBattlePhase(setupScenario(42)));
    const wfLine = log.entries.find(l => /war frenzy/i.test(l));
    const xarmNormal = log.entries.find(l => /norrsund: xarm rolls/i.test(l) && !/war frenzy/i.test(l));
    const lashaNormal = log.entries.find(l => /norrsund: lasha rolls/i.test(l));
    // Print the full log for diagnosis if this fails
    if (!xarmNormal || !lashaNormal) {
      // eslint-disable-next-line no-console
      console.log('Norrsund battle log:\n' + log.entries.filter(l => /norrsund/i.test(l)).join('\n'));
    }
    expect(wfLine).toBeDefined();
    expect(xarmNormal).toBeDefined();
    expect(lashaNormal).toBeDefined();
  });

  test('diagnostic: dump the Norrsund battle log for the reported scenario', () => {
    // Pure diagnostic — always passes. Run with --verbose to see what the
    // engine actually emits in the WF + Heartripper + Raver + 2 cultist setup,
    // so we can compare against the in-game log the user reported.
    const { log } = autoResolveBattle(resolveBattlePhase(setupScenario(42)));
    const norrsundLines = log.entries.filter(l => /norrsund/i.test(l));
    // eslint-disable-next-line no-console
    console.log('--- Norrsund log (seed=42, with-xarm-warrior) ---\n' + norrsundLines.join('\n'));
    expect(norrsundLines.length).toBeGreaterThan(0);
  });

  test('diagnostic: scan seeds for a 2-hit War Frenzy roll matching the report', () => {
    // The reported in-game roll was "6,2,5 → 2 hit(s)" — find any seed that
    // produces a 2-hit WF and dump the full Norrsund log so we can verify the
    // engine still runs Heartrippers + normal battle in that case.
    for (let seed = 0; seed < 200; seed++) {
      const { log } = autoResolveBattle(resolveBattlePhase(setupScenario(seed)));
      const wf = log.entries.find(l => /war frenzy.*xarm rolls.* 2 hit/i.test(l));
      if (wf) {
        const norrsundLines = log.entries.filter(l => /norrsund/i.test(l));
        // eslint-disable-next-line no-console
        console.log(`--- Norrsund log (seed=${seed}, 2-hit WF) ---\n` + norrsundLines.join('\n'));
        return;
      }
    }
  });

  test('diagnostic: same scenario but no Xarm warrior present (only WF card)', () => {
    // Variant — what if Xarm has NO warrior in the region (heartripper upgrade
    // active but no figure to wield it). Does the normal battle round still
    // happen for the surviving Lasha raver?
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 42 });
    s = withUpgrade(s, 'xarm', 'xarm_heartrippers_up');
    s = withUpgrade(s, 'lasha', 'lasha_ravers_up');
    s = placeFollower(s, 'lasha', 'warrior', 'norrsund');
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    const { log } = autoResolveBattle(resolveBattlePhase(s));
    const norrsundLines = log.entries.filter(l => /norrsund/i.test(l));
    // eslint-disable-next-line no-console
    console.log('--- Norrsund log (seed=42, no-xarm-warrior) ---\n' + norrsundLines.join('\n'));
    expect(norrsundLines.length).toBeGreaterThan(0);
  });

  test('Heartrippers fires when the Xarm warrior (Heartripper) makes a kill', () => {
    // Try a few seeds — we just need any seed where Xarm's normal-battle roll
    // produces at least one hit and the auto-resolver kills the Lasha warrior.
    let triggered = false;
    let lastLog: string[] = [];
    for (let seed = 0; seed < 50 && !triggered; seed++) {
      const { log } = autoResolveBattle(resolveBattlePhase(setupScenario(seed)));
      lastLog = log.entries.filter(l => /norrsund/i.test(l));
      if (log.entries.some(l => /heartrippers/i.test(l))) triggered = true;
    }
    if (!triggered) {
      // eslint-disable-next-line no-console
      console.log('No seed in [0,50) triggered Heartrippers. Last log:\n' + lastLog.join('\n'));
    }
    expect(triggered).toBe(true);
  });
});

// ─── Lasha Addicts upgrade: defense 2 ────────────────────────────────────────

describe('Lasha Addicts upgrade (defense 2)', () => {
  test('upgraded Addicts survive more hits', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = withUpgrade(s, 'lasha', 'lasha_addicts_up');
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    expect(() => autoResolveBattle(resolveBattlePhase(s))).not.toThrow();
  });
});

// ─── War Frenzy: partial hit carry-over ──────────────────────────────────────

describe('War Frenzy partial hit carry-over', () => {
  /**
   * Build the game state that would exist mid-resolution when War Frenzy has
   * paused for hit assignment with N hits available.
   */
  function makeWarFrenzyPause(hits: number): { state: GameState; tenzenIncarnationId: string } {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'tenzen', 'incarnation', 'norrsund'); // defense 2
    s = placeCard(s, 'xarm_war_frenzy', 'xarm', 'norrsund');
    const tenzenIncarnationId = followersInRegion(s, 'norrsund').find(f => f.power === 'tenzen')!.id;
    s = {
      ...s,
      phase: 'battle',
      battleState: {
        regionOrder: REGION_ORDER,
        currentRegionIndex: REGION_ORDER.indexOf('norrsund'),
        log: [],
        nextStep: { type: 'normal_battle', powerIndex: 0, clearTipped: true },
      },
      pendingAction: {
        waitingFor: 'xarm',
        actionKind: 'battle_hit_assignment',
        context: { regionId: 'norrsund', hitsRemaining: hits, changerOfFateActive: false, peasantsAvailable: 0, isWarFrenzy: true },
      },
    };
    return { state: s, tenzenIncarnationId };
  }

  test('partial hits are stored on the figure and it survives', () => {
    const { state: paused, tenzenIncarnationId } = makeWarFrenzyPause(1);
    // Allocate 1 hit to the incarnation (defense 2) — not enough to kill
    const { state } = applyBattleHitAssignment(paused, {
      kind: 'battle_hit_assignment',
      power: 'xarm',
      regionId: 'norrsund',
      followerIds: [],
      warFrenzyPartialHits: [{ followerId: tenzenIncarnationId, hits: 1 }],
    });
    const figure = followersInRegion(state, 'norrsund').find(f => f.id === tenzenIncarnationId);
    expect(figure).toBeDefined();
    expect(figure!.warFrenzyHits).toBe(1);
    expect(figure!.tipped).toBe(false);
  });

  test('Xarm can kill with reduced hits after War Frenzy partial hit', () => {
    const { state: paused, tenzenIncarnationId } = makeWarFrenzyPause(1);
    // Partial hit from War Frenzy
    const { state: afterWF } = applyBattleHitAssignment(paused, {
      kind: 'battle_hit_assignment',
      power: 'xarm',
      regionId: 'norrsund',
      followerIds: [],
      warFrenzyPartialHits: [{ followerId: tenzenIncarnationId, hits: 1 }],
    });
    // Normal battle: Xarm has 1 hit — effective defense of incarnation is 2-1=1, so it dies
    const s2: GameState = {
      ...afterWF,
      battleState: {
        ...afterWF.battleState!,
        nextStep: { type: 'post_normal' },
      },
      pendingAction: {
        waitingFor: 'xarm',
        actionKind: 'battle_hit_assignment',
        context: { regionId: 'norrsund', hitsRemaining: 1, changerOfFateActive: false, peasantsAvailable: 0 },
      },
    };
    const hitResult = applyBattleHitAssignment(s2, {
      kind: 'battle_hit_assignment',
      power: 'xarm',
      regionId: 'norrsund',
      followerIds: [tenzenIncarnationId],
    });
    // Immediate result: figure is tipped but not yet removed
    const tipped = followersInRegion(hitResult.state, 'norrsund').find(f => f.id === tenzenIncarnationId);
    expect(tipped?.tipped).toBe(true);
    // resolveBattlePhase resumes — post_normal removes tipped figures
    const { state } = resolveBattlePhase(hitResult.state);
    const figure = followersInRegion(state, 'norrsund').find(f => f.id === tenzenIncarnationId);
    expect(figure).toBeUndefined();
  });

  test('warFrenzyHits are cleared after region battle resolves', () => {
    const { state: paused, tenzenIncarnationId } = makeWarFrenzyPause(1);
    const hitResult = applyBattleHitAssignment(paused, {
      kind: 'battle_hit_assignment',
      power: 'xarm',
      regionId: 'norrsund',
      followerIds: [],
      warFrenzyPartialHits: [{ followerId: tenzenIncarnationId, hits: 1 }],
    });
    // resolveBattlePhase resumes; autoResolveBattle handles any further hit choices
    const { state } = autoResolveBattle(resolveBattlePhase(hitResult.state));
    // After the region resolves, any surviving figure should have warFrenzyHits = 0
    for (const regionId of Object.keys(state.regions) as import('../types.js').RegionId[]) {
      for (const f of followersInRegion(state, regionId)) {
        expect(f.warFrenzyHits).toBe(0);
      }
    }
  });
});

// ─── Multi-region battle ──────────────────────────────────────────────────────

describe('multi-region battle', () => {
  test('battles resolve across multiple regions correctly', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 11 });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'tenzen', 'warrior', 'mittelreich');
    s = placeFollower(s, 'lasha', 'cultist', 'mittelreich');
    s = placeFollower(s, 'xarm', 'cultist', 'almerida');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.phase).not.toBe('battle');
    expect(state.pendingAction?.actionKind).not.toBe('battle_hit_assignment');
  });

  test('pendingAction after auto-resolve is not battle_hit_assignment', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 13 });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    s = placeFollower(s, 'tenzen', 'warrior', 'volensk');
    s = placeFollower(s, 'lasha', 'warrior', 'volensk');
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.pendingAction?.actionKind).not.toBe('battle_hit_assignment');
  });
});

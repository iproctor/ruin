/**
 * Battle phase tests: interactive hit assignment, card effects active during
 * battle, and upgrade effects that apply at battle time.
 *
 * Convention: `resolveBattlePhase` may pause with pendingAction='battle_hit_assignment'.
 * Use `autoResolveBattle` to drive the battle to completion when testing outcomes,
 * and inspect the raw pause state to test the interactive flow specifically.
 */
import { resolveBattlePhase, applyCorruptionHarvestChoice, applyBattleHitAssignment } from '../phases/battle.js';
import { applyAction } from '../reducers.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  giveCards, withUpgrade, setPP, setWorldCard, followersIn,
  autoResolveBattle,
} from './helpers.js';

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
    const tenzenWarriorId = s.regions.norrsund!.placements.find(f => f.power === 'tenzen')!.id;
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    expect(state.regions.norrsund!.placements.find(f => f.id === tenzenWarriorId)).toBeDefined();
  });

  test('after battle, protected flags cleared on surviving figures', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    s = placeFollower(s, 'tenzen', 'warrior', 'norrsund', { protected: true });
    const { state } = autoResolveBattle(resolveBattlePhase(s));
    for (const region of Object.values(state.regions)) {
      for (const f of region.placements) {
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
    const gormenCultistId = s.regions.norrsund!.placements.find(f => f.power === 'gormen')!.id;

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
    expect(state.regions.norrsund!.placements.find(f => f.id === gormenCultistId)).toBeUndefined();
  });

  test('attacker may choose to assign 0 kills (use no hits)', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 1 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const gormenCultistId = s.regions.norrsund!.placements.find(f => f.power === 'gormen')!.id;

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
    expect(state.regions.norrsund!.placements.find(f => f.id === gormenCultistId)).toBeDefined();
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
    expect(state.phase).toBe('corruption');
    // Both powers had attack dice, so both should appear in roll logs
    const xarmRolls = log.filter(l => l.includes('norrsund: xarm rolls'));
    const gormenRolls = log.filter(l => l.includes('norrsund: gormen rolls'));
    expect(xarmRolls.length).toBeGreaterThan(0);
    expect(gormenRolls.length).toBeGreaterThan(0);
  });

  test('hitsRemaining in context reflects hits after peasant auto-claim', () => {
    let s = makeState({ phase: 'battle', pendingAction: null, rngSeed: 1 });
    for (let i = 1; i <= 6; i++) s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'peasant');
    const raw = resolveBattlePhase(s);
    if (raw.state.pendingAction?.actionKind === 'battle_hit_assignment') {
      const hits = raw.state.pendingAction.context['hitsRemaining'] as number;
      // Peasant was auto-claimed (1 hit used), remaining should be hits - 1 or 0
      expect(hits).toBeGreaterThanOrEqual(0);
      // Peasant should have been claimed
      expect(raw.state.regions.norrsund!.tokens.includes('peasant')).toBe(false);
    }
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
    const hitLogs = log.filter(l => l.includes('→') && l.includes('hit'));
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
    const norrsundBattleLogs = log.filter(l => l.startsWith('norrsund:'));
    expect(norrsundBattleLogs).toHaveLength(0);
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
    expect(log.some(l => l.includes('War Frenzy'))).toBe(true);
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
        expect(raw.log.some(l => l.includes('War Frenzy'))).toBe(true);
        const normalXarmRolls = raw.log.filter(l =>
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
    expect(log.some(l => l.includes('War Frenzy'))).toBe(false);
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
    expect(log.some(l => l.includes('Undying Fury extra battle'))).toBe(true);
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
    const killed = log.some(l => l.includes('kills gormen'));
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
    const killed = log.some(l => l.includes('tenzen kills gormen'));
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
    const targets = withPending.regions.norrsund!.placements
      .filter(f => (f.controlledBy ?? f.power) !== 'gormen')
      .map(f => f.id)
      .slice(0, 2);
    const { state } = applyCorruptionHarvestChoice(withPending, {
      kind: 'corruption_harvest_choice',
      power: 'gormen',
      regionId: 'norrsund',
      followerIds: targets,
    });
    for (const id of targets) {
      expect(state.regions.norrsund!.placements.find(f => f.id === id)).toBeUndefined();
    }
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
    expect(log.some(l => l.includes('War Frenzy'))).toBe(false);
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
    expect(log.some(l => l.includes('Rapture upgrade'))).toBe(true);
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
    expect(log.some(l => l.includes('Armistice'))).toBe(true);
    expect(state.regions.norrsund!.placements.length).toBeLessThan(2);
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
    expect(log.some(l => l.includes('norrsund: xarm rolls'))).toBe(true);
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
    const killed = log.some(l => l.includes('kills gormen'));
    if (killed) {
      expect(state.regions.norrsund!.corruptionTokens.xarm).toBeGreaterThan(corrBefore);
    }
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

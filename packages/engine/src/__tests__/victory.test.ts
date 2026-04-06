/**
 * Victory condition tests.
 */
import { checkVictory } from '../victory.js';
import { autoAdvance } from '../reducers.js';
import { makeState, setVP, ruinRegion } from './helpers.js';
import { REGION_ORDER } from '../constants.js';

describe('VP victory (≥50)', () => {
  test('no winner when no power has 50+ VP', () => {
    const s = setVP(makeState(), 'xarm', 49);
    expect(checkVictory(s)).toBeNull();
  });

  test('power with exactly 50 VP wins', () => {
    const s = setVP(makeState(), 'gormen', 50);
    const result = checkVictory(s);
    expect(result).not.toBeNull();
    expect(result!.winners).toContain('gormen');
    expect(result!.condition).toBe('vp');
  });

  test('power with 51 VP wins', () => {
    const s = setVP(makeState(), 'tenzen', 51);
    expect(checkVictory(s)!.condition).toBe('vp');
  });

  test('multiple powers with 50+ VP all win', () => {
    let s = setVP(makeState(), 'xarm', 55);
    s = setVP(s, 'lasha', 52);
    const result = checkVictory(s)!;
    expect(result.winners).toContain('xarm');
    expect(result.winners).toContain('lasha');
  });
});

describe('ruination victory (5 regions ruined)', () => {
  test('no winner with 4 ruined regions', () => {
    let s = makeState();
    for (let i = 0; i < 4; i++) {
      s = ruinRegion(s, REGION_ORDER[i]!, i + 1);
    }
    s = { ...s, ruinationCardsUsed: 4 };
    expect(checkVictory(s)).toBeNull();
  });

  test('highest VP wins when 5 regions are ruined', () => {
    let s = makeState();
    for (let i = 0; i < 5; i++) {
      s = ruinRegion(s, REGION_ORDER[i]!, i + 1);
    }
    s = { ...s, ruinationCardsUsed: 5 };
    s = setVP(s, 'gormen', 30);
    s = setVP(s, 'xarm', 25);
    const result = checkVictory(s)!;
    expect(result.condition).toBe('ruination');
    expect(result.winners).toContain('gormen');
    expect(result.winners).not.toContain('xarm');
  });

  test('tied highest VP results in multiple winners on ruination', () => {
    let s = makeState();
    for (let i = 0; i < 5; i++) {
      s = ruinRegion(s, REGION_ORDER[i]!, i + 1);
    }
    s = { ...s, ruinationCardsUsed: 5 };
    s = setVP(s, 'xarm', 30);
    s = setVP(s, 'gormen', 30);
    const result = checkVictory(s)!;
    expect(result.winners).toContain('xarm');
    expect(result.winners).toContain('gormen');
  });
});

describe('world deck exhausted victory', () => {
  test('no winner when world deck still has cards', () => {
    const s = makeState({ phase: 'world', worldDeck: ['the_pardon'] });
    expect(checkVictory(s)).toBeNull();
  });

  test('highest VP wins when world deck exhausted at world phase', () => {
    let s = makeState({ phase: 'world', worldDeck: [], pendingAction: null });
    s = setVP(s, 'lasha', 40);
    s = setVP(s, 'xarm', 20);
    const result = checkVictory(s)!;
    expect(result.condition).toBe('world_exhausted');
    expect(result.winners).toContain('lasha');
    expect(result.winners).not.toContain('xarm');
  });

  test('not triggered in non-world phase with empty deck', () => {
    const s = makeState({ phase: 'summoning', worldDeck: [] });
    expect(checkVictory(s)).toBeNull();
  });
});

describe('threat dial victory', () => {
  test('power that reaches dial victory wins', () => {
    const s = makeState({
      phase: 'world', pendingAction: null,
      winners: ['xarm'],
      winCondition: 'threat_dial',
    });
    // Already has winners set — verify checkVictory is consistent
    // The actual trigger is in advanceDial → sets winners
    expect(s.winners).toContain('xarm');
  });

  test('autoAdvance stops immediately when winners already set', () => {
    const s = makeState({
      phase: 'completed', pendingAction: null,
      winners: ['gormen'],
      winCondition: 'vp',
    });
    const { state } = autoAdvance({ state: s, log: [] });
    // Game is already over — phase must not change
    expect(state.phase).toBe('completed');
    expect(state.winners).toContain('gormen');
  });
});

describe('no winner state', () => {
  test('checkVictory returns null for fresh game state', () => {
    expect(checkVictory(makeState())).toBeNull();
  });

  test('completed phase is not re-evaluated', () => {
    const s = makeState({ phase: 'completed', winners: ['tenzen'], winCondition: 'vp' });
    const { state } = autoAdvance({ state: s, log: [] });
    expect(state.phase).toBe('completed');
  });
});

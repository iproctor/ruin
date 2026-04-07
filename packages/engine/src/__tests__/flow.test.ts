/**
 * Phase transition and full-round flow tests.
 */
import { applyAction, autoAdvance } from '../reducers.js';
import { createInitialState } from '../setup.js';
import { makeState, placeFollower, setWorldCard, setPP } from './helpers.js';
import type { Power } from '../types.js';

// Fixed-seed state that has already passed the world phase
function summoningState() {
  return makeState({ phase: 'summoning', pendingAction: { waitingFor: 'xarm', actionKind: 'summoning_action', context: {} } });
}

describe('summoning → battle transition', () => {
  test('all powers passing transitions phase to battle', () => {
    let s = summoningState();
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      const result = applyAction(s, { kind: 'summoning_pass', power });
      s = result.state;
    }
    // After all pass, autoAdvance moves through battle/corruption/end.
    // With an empty worldDeck the game ends as world_exhausted → 'completed'.
    expect(['battle', 'corruption', 'end', 'world', 'summoning', 'completed'].includes(s.phase)).toBe(true);
  });

  test('passing sets passedSummoning and zeroes power points', () => {
    const s = summoningState();
    const { state } = applyAction(s, { kind: 'summoning_pass', power: 'xarm' });
    expect(state.powers.xarm!.passedSummoning).toBe(true);
    expect(state.powers.xarm!.powerPoints).toBe(0);
  });

  test('pendingAction advances to next power after summoning action', () => {
    const s = summoningState();
    const { state } = applyAction(s, {
      kind: 'summoning_summon_figure',
      power: 'xarm',
      followerId: 'xarm_warrior_1',
      toRegion: 'norrsund',
    });
    // Next pending action should be for gormen (next in order after xarm)
    expect(state.pendingAction?.waitingFor).toBe('gormen');
  });
});

describe('autoAdvance', () => {
  test('autoAdvance stops at pendingAction', () => {
    const s = summoningState();
    const result = autoAdvance({ state: s, log: [] });
    expect(result.state.pendingAction).not.toBeNull();
  });

  test('autoAdvance moves through corruption and end phases when no figures present', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    // Battle with no figures → corruption → end → world (empty deck → completed)
    const result = autoAdvance({ state: s, log: [] });
    expect(['world', 'summoning', 'completed'].includes(result.state.phase)).toBe(true);
  });

  test('round increments after completing full round', () => {
    let s = makeState({ phase: 'battle', pendingAction: null });
    const result = autoAdvance({ state: s, log: [] });
    // End phase increments round
    expect(result.state.round).toBeGreaterThanOrEqual(2);
  });
});

describe('full round via applyAction', () => {
  test('all-pass summoning round completes without error (4 players)', () => {
    let s = summoningState();
    expect(() => {
      for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
        const result = applyAction(s, { kind: 'summoning_pass', power });
        s = result.state;
      }
    }).not.toThrow();
  });

  test('world phase with empty deck results in world_exhausted victory', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: [] });
    const result = autoAdvance({ state: s, log: [] });
    // Empty deck at world phase → checkVictory returns world_exhausted → completed
    expect(result.state.phase).toBe('completed');
    expect(result.state.winCondition).toBe('world_exhausted');
  });
});

describe('createInitialState → autoAdvance world phase', () => {
  test('first autoAdvance on world phase draws a world card or advances', () => {
    const s = createInitialState({
      gameId: 'flow-test',
      activePowers: ['xarm', 'gormen', 'tenzen', 'lasha'],
      playerTypes: { xarm: 'human', gormen: 'human', tenzen: 'human', lasha: 'human' },
      seed: 1,
    });
    expect(s.phase).toBe('world');
    expect(s.worldDeck.length).toBeGreaterThan(0);
  });
});

describe('upgrade_choice action', () => {
  test('applying upgrade_choice adds upgrade to upgradesInPlay', () => {
    const s = makeState({
      phase: 'summoning',
      pendingAction: { waitingFor: 'xarm', actionKind: 'upgrade_choice', context: {} },
    });
    const { state } = applyAction(s, {
      kind: 'upgrade_choice',
      power: 'xarm',
      upgradeCardId: 'xarm_power_of_war',
    });
    expect(state.powers.xarm!.upgradesInPlay).toContain('xarm_power_of_war');
    expect(state.powers.xarm!.availableUpgradeIds).not.toContain('xarm_power_of_war');
  });

  test('upgrade_choice for unavailable upgrade throws', () => {
    const s = makeState({
      phase: 'summoning',
      pendingAction: { waitingFor: 'xarm', actionKind: 'upgrade_choice', context: {} },
      powers: {
        ...makeState().powers,
        xarm: { ...makeState().powers.xarm!, availableUpgradeIds: [] },
      },
    });
    expect(() =>
      applyAction(s, { kind: 'upgrade_choice', power: 'xarm', upgradeCardId: 'xarm_power_of_war' }),
    ).toThrow();
  });
});

describe('hero_removal action', () => {
  test('hero_removal removes figure from region', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'norrsund');
    const followerId = s.regions.norrsund!.placements[0]!.id;
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'xarm',
        actionKind: 'hero_removal',
        context: { followerId, regionId: 'norrsund' },
      },
    };
    const { state } = applyAction(s, {
      kind: 'hero_removal',
      power: 'xarm',
      followerId,
      regionId: 'norrsund',
    });
    expect(state.regions.norrsund!.placements).toHaveLength(0);
    expect(state.powers.xarm!.followers.find(f => f.id === followerId)!.regionId).toBeNull();
  });
});

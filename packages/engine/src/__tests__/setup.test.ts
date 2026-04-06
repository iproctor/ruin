import { createInitialState } from '../setup.js';
import { FOLLOWERS, BASE_POWER_POINTS, THREAT_DIALS, UPGRADES } from '../constants.js';
import type { Power } from '../types.js';

const BASE_CONFIG = {
  gameId: 'test',
  activePowers: ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[],
  playerTypes: { xarm: 'human', gormen: 'human', tenzen: 'human', lasha: 'human' } as Record<Power, 'human'>,
  seed: 0,
};

describe('createInitialState', () => {
  const state = createInitialState(BASE_CONFIG);

  test('initialises all four powers', () => {
    expect(state.activePowers).toEqual(['xarm', 'gormen', 'tenzen', 'lasha']);
  });

  test('creates correct follower counts per power', () => {
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      const expected =
        FOLLOWERS[power]!.cultist.count +
        FOLLOWERS[power]!.warrior.count +
        FOLLOWERS[power]!.incarnation.count;
      expect(state.powers[power]!.followers).toHaveLength(expected);
    }
  });

  test('all followers start in reserve (regionId null)', () => {
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      for (const f of state.powers[power]!.followers) {
        expect(f.regionId).toBeNull();
      }
    }
  });

  test('starting power points match BASE_POWER_POINTS', () => {
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      expect(state.powers[power]!.powerPoints).toBe(BASE_POWER_POINTS[power]);
    }
  });

  test('starting threat values match first dial entry', () => {
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      const expected = THREAT_DIALS[power]![0]!.threat;
      expect(state.powers[power]!.threatValue).toBe(expected);
    }
  });

  test('each power has 3 cards in starting hand', () => {
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      expect(state.powers[power]!.hand).toHaveLength(3);
    }
  });

  test('4-player world deck is 7 cards', () => {
    expect(state.worldDeck).toHaveLength(7);
  });

  test('3-player world deck is 8 cards', () => {
    const s3p = createInitialState({
      ...BASE_CONFIG,
      activePowers: ['xarm', 'gormen', 'tenzen'] as Power[],
      playerTypes: { xarm: 'human', gormen: 'human', tenzen: 'human', lasha: 'ai' } as Record<Power, 'human' | 'ai'>,
    });
    expect(s3p.worldDeck).toHaveLength(8);
  });

  test('each power has all upgrades available at start', () => {
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]) {
      const expected = UPGRADES.filter(u => u.power === power).map(u => u.id);
      expect(state.powers[power]!.availableUpgradeIds.sort()).toEqual(expected.sort());
    }
  });

  test('game starts in world phase', () => {
    expect(state.phase).toBe('world');
  });

  test('9 regions all exist with no placements', () => {
    expect(Object.keys(state.regions)).toHaveLength(9);
    for (const region of Object.values(state.regions)) {
      expect(region.placements).toHaveLength(0);
    }
  });

  test('each region has exactly 1 starting token', () => {
    for (const region of Object.values(state.regions)) {
      expect(region.tokens).toHaveLength(1);
    }
  });
});

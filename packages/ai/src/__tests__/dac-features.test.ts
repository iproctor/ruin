/**
 * Tests for the DAC feature columns:
 *   - optimisticDac per-power column includes already-earned `dialCounters`
 *   - optimisticDoubleTick flips on for the unique strict-max holder
 *   - expectedDac applies 0.6×dice attrition, plus all modifiers:
 *       Ecstasy / Chokepoint / War Frenzy / Pestilent Touch / Rain of Bile /
 *       Changer of Fate / Fate Shield (protected figures).
 *   - expectedDoubleTick mirrors the same strict-max logic over expectedDac.
 *
 * The last 12 dims of the feature vector are the new blocks, laid out as:
 *   [-12..-8]  optimisticDoubleTick (one-hot over POWERS)
 *   [ -8..-4]  expectedDac (per-power, /3-capped)
 *   [ -4.. 0]  expectedDoubleTick (one-hot over POWERS)
 */
import type { GameState, Power, RegionId, FollowerInstance, FollowerClass } from '@ruin/engine';
import { createInitialState, UPGRADES } from '@ruin/engine';
import { extractFeatures, FEATURE_DIM, POWERS } from '../learn/features.js';

const PER_POWER = 20 + UPGRADES.length;
const GLOBAL_DIMS = 4;
const OPTIMISTIC_DAC_OFFSET = (p: Power) => GLOBAL_DIMS + POWERS.indexOf(p) * PER_POWER + 2;
const DOUBLE_TICK_START = FEATURE_DIM - 12;
const EXPECTED_DAC_START = FEATURE_DIM - 8;
const EXPECTED_DOUBLE_TICK_START = FEATURE_DIM - 4;

function readBlock(v: Float32Array, start: number): Record<Power, number> {
  return {
    xarm: v[start + 0]!, gormen: v[start + 1]!,
    tenzen: v[start + 2]!, lasha: v[start + 3]!,
  };
}

function fresh(): GameState {
  return createInitialState({
    gameId: 'dac-feature-test',
    activePowers: ['xarm', 'gormen', 'tenzen', 'lasha'],
    playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
    seed: 1,
  });
}

function placeFigure(
  state: GameState,
  power: Power,
  cls: FollowerClass,
  regionId: RegionId,
  overrides: Partial<FollowerInstance> = {},
): GameState {
  const ps = state.powers[power]!;
  const reserve = ps.followers.find(f => f.regionId === null && f.class === cls);
  if (!reserve) throw new Error(`no reserve ${cls} for ${power}`);
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...ps,
        followers: ps.followers.map(f =>
          f.id === reserve.id ? { ...f, regionId, ...overrides } : f,
        ),
      },
    },
  };
}

function setChaosCard(state: GameState, regionId: RegionId, slot: 0 | 1, cardId: string, playedBy: Power): GameState {
  const region = state.regions[regionId]!;
  const slots = [...region.chaosCards] as typeof region.chaosCards;
  slots[slot] = { cardId, playedBy, slotIndex: slot, persistNextRound: false, placedAt: 0 };
  return { ...state, regions: { ...state.regions, [regionId]: { ...region, chaosCards: slots } } };
}

function addToken(state: GameState, regionId: RegionId, token: 'event' | 'noble' | 'hero' | 'chaos_stone'): GameState {
  const region = state.regions[regionId]!;
  return {
    ...state,
    regions: { ...state.regions, [regionId]: { ...region, tokens: [...region.tokens, token] } },
  };
}

function setWorldSlot(state: GameState, slot: 1 | 2, cardId: string): GameState {
  return { ...state, worldTrack: { ...state.worldTrack, [`slot${slot}`]: cardId } };
}

function setDialCounters(state: GameState, power: Power, n: number): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, dialCounters: n },
    },
  };
}

// Pick a populous region so gormen's DAC condition fires.
const POP: RegionId = 'mittelreich';

describe('optimisticDac includes already-earned dialCounters', () => {
  test('seed value of 2 shows up as 2/3 in the per-power column', () => {
    const s = setDialCounters(fresh(), 'gormen', 2);
    const v = extractFeatures(s, 'gormen');
    expect(v[OPTIMISTIC_DAC_OFFSET('gormen')]).toBeCloseTo(2 / 3, 5);
  });

  test('counter on gormen does not bleed into the other powers', () => {
    const s = setDialCounters(fresh(), 'gormen', 1);
    const v = extractFeatures(s, 'gormen');
    expect(v[OPTIMISTIC_DAC_OFFSET('xarm')]).toBe(0);
    expect(v[OPTIMISTIC_DAC_OFFSET('tenzen')]).toBe(0);
    expect(v[OPTIMISTIC_DAC_OFFSET('lasha')]).toBe(0);
  });
});

describe('optimisticDoubleTick', () => {
  test('all-zero when no power has any projected counters', () => {
    const v = extractFeatures(fresh(), 'gormen');
    expect(readBlock(v, DOUBLE_TICK_START)).toEqual({ xarm: 0, gormen: 0, tenzen: 0, lasha: 0 });
  });

  test('strict max → one-hot on that power', () => {
    let s = fresh();
    s = setDialCounters(s, 'gormen', 2);
    s = setDialCounters(s, 'tenzen', 1);
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, DOUBLE_TICK_START)).toEqual({ xarm: 0, gormen: 1, tenzen: 0, lasha: 0 });
  });

  test('tie → all-zero (no double tick)', () => {
    let s = fresh();
    s = setDialCounters(s, 'gormen', 2);
    s = setDialCounters(s, 'tenzen', 2);
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, DOUBLE_TICK_START)).toEqual({ xarm: 0, gormen: 0, tenzen: 0, lasha: 0 });
  });
});

describe('expectedDac — non-xarm corruption attrition', () => {
  test('2 gormen cultists in populous region, no opponents → DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBeCloseTo(1 / 3, 5);
  });

  test('2 gormen cultists vs xarm warrior (2 dice → 1.2 hits) → 0.8 survivors < 2 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'xarm', 'warrior', POP);
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('Ecstasy zeros opponent dice → 2 cultists survive → DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = setChaosCard(s, POP, 0, 'lasha_ecstasy', 'lasha');
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBeCloseTo(1 / 3, 5);
  });

  test('Changer of Fate cancels Ecstasy → opponent dice apply again → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = setChaosCard(s, POP, 0, 'lasha_ecstasy', 'lasha');
    s = setChaosCard(s, POP, 1, 'tenzen_changer_of_fate', 'tenzen');
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('Chokepoint+event caps xarm warrior at 1 die (0.6 hits) → 1.4 survivors < 2 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = setWorldSlot(s, 1, 'the_chokepoint');
    s = addToken(s, POP, 'event');
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('Chokepoint without event token has no effect — 2 dice still apply', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = setWorldSlot(s, 1, 'the_chokepoint'); // no event token
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('protected cultist absorbs no hits — 3 cultists (1 protected) vs warrior → 1.8 survivors < 2 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP, { protected: true });
    s = placeFigure(s, 'xarm', 'warrior', POP);
    // unprotected=2, killsLanding = min(2, 1.2)=1.2; survivors = 3-1.2 = 1.8
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('protected cultist saves the threshold — 4 cultists (2 protected) vs warrior → 2.8 survivors → DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP, { protected: true });
    s = placeFigure(s, 'gormen', 'cultist', POP, { protected: true });
    s = placeFigure(s, 'xarm', 'warrior', POP);
    // unprotected=2, killsLanding = min(2, 1.2)=1.2; survivors = 4-1.2 = 2.8 ≥ 2
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBeCloseTo(1 / 3, 5);
  });

  test('War Cry blocks corruption → no DAC even with cultists alone', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = setChaosCard(s, POP, 0, 'xarm_war_cry', 'xarm');
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('Shimmer reduces non-tenzen tokens by 1 → 2 gormen cultists drop to 1 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = setChaosCard(s, POP, 0, 'tenzen_shimmer', 'tenzen');
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBe(0);
  });

  test('dialCounters seed is included even with no live cultists', () => {
    const s = setDialCounters(fresh(), 'gormen', 1);
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DAC_START).gormen).toBeCloseTo(1 / 3, 5);
  });
});

describe('expectedDac — xarm "1 kill" check', () => {
  test('xarm warrior (2 dice) vs gormen cultist (def 1) → 1.2 ≥ 1 → DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBeCloseTo(1 / 3, 5);
  });

  test('xarm warrior vs PROTECTED gormen cultist → no killable target → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP, { protected: true });
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });

  test('Chokepoint+event caps xarm at 1 die → 0.6 < 1 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = setWorldSlot(s, 1, 'the_chokepoint');
    s = addToken(s, POP, 'event');
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });

  test('Chokepoint+event + War Frenzy → 1+2=3 dice → 1.8 ≥ 1 → DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = setWorldSlot(s, 1, 'the_chokepoint');
    s = addToken(s, POP, 'event');
    s = setChaosCard(s, POP, 0, 'xarm_war_frenzy', 'xarm');
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBeCloseTo(1 / 3, 5);
  });

  test('xarm warrior vs lasha Rapture (def 4) → 1.2 < 4 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'lasha', 'incarnation', POP);
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });

  test('xarm warrior vs tenzen warrior (def 2) → 1.2 < 2 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'tenzen', 'warrior', POP);
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });

  test('Pestilent Touch drops tenzen warrior def 2 → 1 → 1.2 ≥ 1 → DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'tenzen', 'warrior', POP);
    s = setChaosCard(s, POP, 0, 'gormen_pestilent_touch', 'gormen');
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBeCloseTo(1 / 3, 5);
  });

  test('Changer of Fate cancels Pestilent Touch → def back to 2 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'tenzen', 'warrior', POP);
    s = setChaosCard(s, POP, 0, 'gormen_pestilent_touch', 'gormen');
    s = setChaosCard(s, POP, 1, 'tenzen_changer_of_fate', 'tenzen');
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });

  test('Rain of Bile bumps gormen def +1 → xarm warrior (1.2) < 2 → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP); // base def 1, bumped to 2
    s = setChaosCard(s, POP, 0, 'gormen_rain_of_bile', 'gormen');
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });

  test('Ecstasy in region → xarm can roll 0 dice → no DAC', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    s = setChaosCard(s, POP, 0, 'lasha_ecstasy', 'lasha');
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DAC_START).xarm).toBe(0);
  });
});

describe('expectedDoubleTick mirrors expectedDac strict-max', () => {
  test('xarm uniquely projects a DAC → leader bit on xarm', () => {
    let s = fresh();
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP); // kill target
    const v = extractFeatures(s, 'xarm');
    expect(readBlock(v, EXPECTED_DOUBLE_TICK_START)).toEqual({ xarm: 1, gormen: 0, tenzen: 0, lasha: 0 });
  });

  test('xarm and gormen both project a DAC → tie → all-zero', () => {
    let s = fresh();
    // xarm warrior vs gormen cultist gives xarm 1 DAC (gormen cultist killable).
    s = placeFigure(s, 'xarm', 'warrior', POP);
    s = placeFigure(s, 'gormen', 'cultist', POP);
    // give gormen a separate already-earned counter so its expectedDac also = 1
    s = setDialCounters(s, 'gormen', 1);
    const v = extractFeatures(s, 'gormen');
    expect(readBlock(v, EXPECTED_DOUBLE_TICK_START)).toEqual({ xarm: 0, gormen: 0, tenzen: 0, lasha: 0 });
  });
});

test('feature vector length still matches FEATURE_DIM after edits', () => {
  const v = extractFeatures(fresh(), 'gormen');
  expect(v.length).toBe(FEATURE_DIM);
});

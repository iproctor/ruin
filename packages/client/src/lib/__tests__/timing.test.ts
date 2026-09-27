import { describe, expect, it } from 'vitest';
import type { FollowerInstance, GameEvent } from '@ruin/engine';
import { eventDuration } from '../timing.js';
import { GROUP_VISIBLE, layoutStandees, regionFrame } from '../../components/board3d/layout.js';

const play: GameEvent = { type: 'play_card', power: 'gormen', cardId: 'gormen_decay', cardName: 'Decay', toRegion: 'normagne', slotIndex: 0, cost: 1 };

describe('eventDuration', () => {
  it('gives opponents’ spells a full reveal but keeps your own snappy', () => {
    const theirs = eventDuration(play, { myPowers: ['xarm'], cinematics: true, speed: 1 });
    const mine = eventDuration(play, { myPowers: ['gormen'], cinematics: true, speed: 1 });
    expect(theirs).toBeGreaterThan(mine);
  });

  it('scales with the pace setting', () => {
    const normal = eventDuration(play, { myPowers: [], cinematics: true, speed: 1 });
    const fast = eventDuration(play, { myPowers: [], cinematics: true, speed: 0.5 });
    expect(fast).toBe(Math.round(normal * 0.5));
  });

  it('shortens battle beats when cinematics are off', () => {
    const ev: GameEvent = { type: 'battle_region_start', regionId: 'normagne' };
    expect(eventDuration(ev, { myPowers: [], cinematics: false, speed: 1 }))
      .toBeLessThan(eventDuration(ev, { myPowers: [], cinematics: true, speed: 1 }));
  });

  it('never waits on bookkeeping events', () => {
    expect(eventDuration({ type: 'action_applied', actionCount: 3 }, { myPowers: [], cinematics: true, speed: 1 })).toBe(0);
  });
});

function fig(id: string, power: FollowerInstance['power'], cls: FollowerInstance['class']): FollowerInstance {
  return { id, power, class: cls, regionId: 'normagne', controlledBy: null, tipped: false, protected: false, warFrenzyHits: 0, placedAt: 0 };
}

describe('layoutStandees', () => {
  it('stacks identical figures and caps the visible ones', () => {
    const figures = Array.from({ length: 6 }, (_, i) => fig(`g${i}`, 'gormen', 'cultist'));
    const slots = layoutStandees(figures, regionFrame('normagne'));
    expect(slots).toHaveLength(6);
    expect(slots.filter((s) => s.visible)).toHaveLength(GROUP_VISIBLE);
    expect(slots.every((s) => s.groupSize === 6)).toBe(true);
  });

  it('keeps every standee inside its region', () => {
    const f = regionFrame('mittelreich');
    const figures = [
      ...['xarm', 'gormen', 'tenzen', 'lasha'].flatMap((p) =>
        (['incarnation', 'warrior', 'cultist'] as const).map((c) => fig(`${p}-${c}`, p as FollowerInstance['power'], c)),
      ),
    ];
    for (const s of layoutStandees(figures, f)) {
      expect(s.x).toBeGreaterThanOrEqual(f.x0);
      expect(s.x).toBeLessThanOrEqual(f.x0 + f.w);
      expect(s.z).toBeGreaterThanOrEqual(f.z0);
      expect(s.z).toBeLessThanOrEqual(f.z0 + f.d);
    }
  });
});

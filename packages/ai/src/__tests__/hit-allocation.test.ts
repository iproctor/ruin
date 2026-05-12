/**
 * Regression test for the greedy-fixup behavior in enumerateKillActions.
 *
 * Pre-fix, the enumerator generated single-group and pair commits but no
 * triples. When a battle could only be fully allocated by committing to 3+
 * groups, every enumerated action was filtered out as illegal and the
 * fallback path returned the illegal set to MCTS, which triggered the
 * engine's underallocated throw on every expansion.
 *
 * Post-fix, each enumerated "intent" is greedy-completed (peasants then
 * cheapest enemy) so every emitted action is legal.
 */
import type { GameState, Power, RegionId } from '@ruin/engine';
import { createInitialState, isBattleHitAssignmentLegal } from '@ruin/engine';
import { enumerateKillActions } from '../mcts/hit-allocation.js';

function setupBattle(opts: {
  attacker: Power;
  regionId: RegionId;
  hitsRemaining: number;
  peasantsAvailable: number;
  enemies: Array<{ power: Power; class: 'cultist' | 'warrior' | 'incarnation' }>;
}): GameState {
  const allPowers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
  let state = createInitialState({
    gameId: 'test-hit-allocation',
    activePowers: allPowers,
    playerTypes: Object.fromEntries(allPowers.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
    seed: 1,
  });

  // Place one attacker figure (so the attacker exists in the region too).
  const placedAttacker = state.powers[opts.attacker]!.followers.find(f => f.regionId === null);
  if (placedAttacker) {
    state = {
      ...state,
      powers: {
        ...state.powers,
        [opts.attacker]: {
          ...state.powers[opts.attacker]!,
          followers: state.powers[opts.attacker]!.followers.map(f =>
            f.id === placedAttacker.id ? { ...f, regionId: opts.regionId } : f,
          ),
        },
      },
    };
  }

  // Place each requested enemy figure in the region.
  for (const e of opts.enemies) {
    const reserve = state.powers[e.power]!.followers.find(
      f => f.regionId === null && f.class === e.class,
    );
    if (!reserve) throw new Error(`No ${e.class} reserve for ${e.power}`);
    state = {
      ...state,
      powers: {
        ...state.powers,
        [e.power]: {
          ...state.powers[e.power]!,
          followers: state.powers[e.power]!.followers.map(f =>
            f.id === reserve.id ? { ...f, regionId: opts.regionId } : f,
          ),
        },
      },
    };
  }

  // Drop peasant tokens into the region if requested.
  const tokens = [...state.regions[opts.regionId]!.tokens];
  for (let i = 0; i < opts.peasantsAvailable; i++) tokens.push('peasant');
  state = {
    ...state,
    regions: {
      ...state.regions,
      [opts.regionId]: { ...state.regions[opts.regionId]!, tokens },
    },
    pendingAction: {
      waitingFor: opts.attacker,
      actionKind: 'battle_hit_assignment',
      context: {
        regionId: opts.regionId,
        hitsRemaining: opts.hitsRemaining,
        peasantsAvailable: opts.peasantsAvailable,
        changerOfFateActive: false,
      },
    },
  };

  return state;
}

describe('enumerateKillActions — greedy fixup', () => {
  test('every emitted action is legal per the engine predicate', () => {
    // Three distinct enemy groups (gormen cultist def 1, tenzen warrior def 2,
    // lasha warrior def 2). xarm attacker with 5 hits, no peasants. Only way
    // to fully allocate is to commit to all three — pair enumeration alone
    // can't reach it.
    const state = setupBattle({
      attacker: 'xarm',
      regionId: 'almerida',
      hitsRemaining: 5,
      peasantsAvailable: 0,
      enemies: [
        { power: 'gormen', class: 'cultist' },
        { power: 'tenzen', class: 'warrior' },
        { power: 'lasha', class: 'warrior' },
      ],
    });

    const actions = enumerateKillActions(state, 'xarm');
    expect(actions.length).toBeGreaterThan(0);

    for (const a of actions) {
      expect(isBattleHitAssignmentLegal(state, a, state.pendingAction!.context)).toBe(true);
    }
  });

  test('triple-group scenario produces an action that kills all three', () => {
    const state = setupBattle({
      attacker: 'xarm',
      regionId: 'almerida',
      hitsRemaining: 5,
      peasantsAvailable: 0,
      enemies: [
        { power: 'gormen', class: 'cultist' },
        { power: 'tenzen', class: 'warrior' },
        { power: 'lasha', class: 'warrior' },
      ],
    });

    const actions = enumerateKillActions(state, 'xarm');
    const triple = actions.find(a => a.followerIds.length === 3);
    expect(triple).toBeDefined();
  });

  test('peasants are preferred over leaving hits unused', () => {
    // 1 enemy (def 1), 3 hits, 5 peasants available. Greedy should kill the
    // enemy and take 2 peasants to spend all 3 hits.
    const state = setupBattle({
      attacker: 'xarm',
      regionId: 'almerida',
      hitsRemaining: 3,
      peasantsAvailable: 5,
      enemies: [{ power: 'gormen', class: 'cultist' }],
    });

    const actions = enumerateKillActions(state, 'xarm');
    for (const a of actions) {
      expect(isBattleHitAssignmentLegal(state, a, state.pendingAction!.context)).toBe(true);
    }
    // At least one action should fully allocate the budget.
    const full = actions.find(a => {
      const spent = (a.peasantsToTake ?? 0) + a.followerIds.length; // all defs are 1 here
      return spent === 3;
    });
    expect(full).toBeDefined();
  });
});

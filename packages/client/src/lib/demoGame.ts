import type { Action, GameEvent, GameState, Power } from '@ruin/engine';
import {
  applyAction,
  autoAdvance,
  createInitialState,
  enumerateBattleHitStrategies,
  getLegalActions,
  isBattleHitAssignmentLegal,
  GameLog,
} from '@ruin/engine';

const ALL: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

/**
 * Play a complete game in-browser with a crude random policy (biased away
 * from passing) and return the initial state plus every event. Used by the
 * dev replay harness to exercise the cinematics without a server.
 */
export function generateDemoGame(seed: number, maxSteps = 3000): { initial: GameState; events: GameEvent[]; final: GameState } {
  let rngState = seed >>> 0;
  const rand = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const playerTypes = Object.fromEntries(ALL.map((p) => [p, 'ai'])) as Record<Power, 'ai'>;
  const start = createInitialState({ gameId: `demo-${seed}`, activePowers: ALL, playerTypes, seed });
  const first = autoAdvance({ state: start, log: new GameLog() });
  let s = first.state;
  const events: GameEvent[] = [...first.log.events];

  for (let step = 0; step < maxSteps && !s.winners; step++) {
    const pending = s.pendingAction;
    if (!pending) break;
    let candidates: Action[];
    if (pending.actionKind === 'battle_hit_assignment') {
      candidates = enumerateBattleHitStrategies(s, pending.waitingFor).filter((a) => {
        try { return isBattleHitAssignmentLegal(s, a); } catch { return false; }
      });
    } else {
      candidates = getLegalActions(s, pending.waitingFor);
    }
    if (candidates.length === 0) break;
    const nonPass = candidates.filter((a) => a.kind !== 'summoning_pass');
    const pool = nonPass.length > 0 && rand() < 0.8 ? nonPass : candidates;
    // Try a few picks; some sampled actions can be rejected by deeper checks.
    let applied = false;
    for (let attempt = 0; attempt < 6 && !applied; attempt++) {
      const a = pool[Math.floor(rand() * pool.length)]!;
      try {
        const r = applyAction(s, a);
        s = r.state;
        events.push(...r.log.events);
        applied = true;
      } catch { /* try another */ }
    }
    if (!applied) break;
  }
  return { initial: start, events, final: s };
}

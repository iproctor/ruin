import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GameState, GameEvent } from '@ruin/engine';
import type { StreamEvent } from '../../api/sse.js';

// ── Mock the SSE module so tests drive event delivery directly ───────────────
let deliver: ((e: StreamEvent) => void) | null = null;
let cleanupCalled = false;

vi.mock('../../api/sse.js', () => ({
  connectGameStream: (
    _gameId: string,
    onEvent: (e: StreamEvent) => void,
  ): (() => void) => {
    deliver = onEvent;
    cleanupCalled = false;
    return () => { cleanupCalled = true; deliver = null; };
  },
}));

// Import after mock so the hook resolves to the mocked module.
import { useGameStream } from '../useGameStream.js';

// ── Tiny helpers ─────────────────────────────────────────────────────────────

/** A stand-in for a real GameState. The hook only passes it through to
 *  setState; the engine's applyEvent will throw on these synthetic events,
 *  but the hook catches and logs the event anyway. */
const fakeState = (): GameState => ({} as unknown as GameState);

/** Build a battle-kill event (counts as a normal log entry). */
const evKill = (id = 'gormen_warrior_2'): GameEvent => ({
  type: 'battle_kill',
  regionId: 'toscavar',
  attacker: 'xarm',
  targetPower: 'gormen',
  targetClass: 'warrior',
  targetId: id,
});

const evRegionStart = (): GameEvent => ({
  type: 'battle_region_start',
  regionId: 'toscavar',
});

const evPhase = (phase: GameState['phase']): GameEvent => ({
  type: 'phase_start',
  phase,
  round: 1,
});

const evCorruptionPlacement = (): GameEvent => ({
  type: 'corruption_placement',
  regionId: 'toscavar',
  power: 'lasha',
  tokens: 1,
});

beforeEach(() => {
  vi.useFakeTimers();
  deliver = null;
  cleanupCalled = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useGameStream.syncAfterAction', () => {
  test('HTTP-first: action events are appended to the log', () => {
    const { result } = renderHook(() => useGameStream('g1'));
    // Establish initial state via a history snapshot (no prior events)
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const actionEvents = [evKill(), evPhase('corruption'), evCorruptionPlacement()];
    act(() => result.current.syncAfterAction(fakeState(), 5, actionEvents));

    expect(result.current.events).toEqual(actionEvents);
  });

  test('SSE-first fully processed: syncAfterAction does not duplicate events', () => {
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    // SSE delivers a batch with no battle-phase pause — processNext drains it.
    const events = [evKill(), evKill('gormen_warrior_3')];
    act(() => deliver!({ type: 'events', events, seq: 5 }));
    act(() => { vi.advanceTimersByTime(10000); });

    expect(result.current.events).toEqual(events);

    // HTTP response arrives with the same batch + seq. Should NOT duplicate.
    act(() => result.current.syncAfterAction(fakeState(), 5, events));
    expect(result.current.events).toEqual(events);
  });

  test('REGRESSION: SSE-first paused at corruption — drained events still land in log', () => {
    // This is the bug we just fixed. SSE delivers a big batch spanning
    // battle → corruption. processNext processes a couple of battle events,
    // then pauses at phase_start: corruption. The HTTP response arrives and
    // syncAfterAction must drain the unprocessed tail into the log instead
    // of wiping the queue.
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const batch: GameEvent[] = [
      evRegionStart(),                    // sets hadBattle=true
      evKill(),                           // logged before pause
      evPhase('corruption'),              // pauses processing here
      evCorruptionPlacement(),            // ⚠️ would be lost without drain
      evCorruptionPlacement(),
      evPhase('end'),
    ];
    act(() => deliver!({ type: 'events', events: batch, seq: 10 }));
    // Run microtasks/timers far enough for processNext to reach the pause.
    act(() => { vi.advanceTimersByTime(10000); });

    // Only the pre-pause events should be in the log; we paused before
    // shifting the corruption phase_start.
    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
    ]);
    expect(result.current.paused).toBe(true);

    // HTTP response arrives with the same batch + seq. The fix drains the
    // queued tail (events not yet shifted) and writes them to the log.
    act(() => result.current.syncAfterAction(fakeState(), 10, batch));

    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
      'phase_start', 'corruption_placement', 'corruption_placement', 'phase_start',
    ]);
    // Pause is cleared so the UI doesn't get stuck.
    expect(result.current.paused).toBe(false);
  });

  test('ahead-of-action SSE batches are re-queued after sync', () => {
    // SSE delivers a batch with seq HIGHER than the action's seq (e.g. a
    // background AI step that landed between action submit and HTTP response).
    // syncAfterAction should re-queue those events for processing on top of
    // the authoritative actionState.
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const aheadBatch = [evKill('extra_kill_1')];
    act(() => deliver!({ type: 'events', events: aheadBatch, seq: 20 }));
    // Let processNext drain the ahead batch into the log
    act(() => { vi.advanceTimersByTime(10000); });
    expect(result.current.events.map((e) => e.type)).toEqual(['battle_kill']);

    // Now the HTTP response for an EARLIER action arrives at seq=10.
    const actionEvents = [evKill('action_kill')];
    act(() => result.current.syncAfterAction(fakeState(), 10, actionEvents));

    // Action events appended (HTTP-first path: sseBuffer has seq=20 > 10, so
    // sseBatchedThis is false → log actionEvents from the response).
    // Then ahead batch (seq=20) is re-queued and processed again on top of
    // the authoritative state.
    act(() => { vi.advanceTimersByTime(10000); });

    // Expected log: prior aheadBatch (from initial drain) + actionEvents +
    // re-queued aheadBatch (replayed).
    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_kill', 'battle_kill', 'battle_kill',
    ]);
  });

  test('cleanup runs when the hook unmounts', () => {
    const { unmount } = renderHook(() => useGameStream('g1'));
    expect(cleanupCalled).toBe(false);
    unmount();
    expect(cleanupCalled).toBe(true);
  });
});

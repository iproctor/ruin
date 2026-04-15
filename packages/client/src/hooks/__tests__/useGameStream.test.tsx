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
  test('HTTP-first: action events animate through the queue into the log', () => {
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const actionEvents = [evKill(), evKill('gormen_warrior_3')];
    act(() => result.current.syncAfterAction(fakeState(), 5, actionEvents));
    // processNext runs on timers; advance to let the queue drain.
    act(() => { vi.advanceTimersByTime(10000); });

    expect(result.current.events.map((e) => e.type))
      .toEqual(['battle_kill', 'battle_kill']);
  });

  test('HTTP-first: cross-phase batch still pauses at corruption', () => {
    // This is the scenario the user reported: the action returned a batch
    // spanning battle → corruption → end → world in one response. Routing
    // the events through the animation queue (instead of log-appending)
    // lets the corruption pause banner still fire.
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const batch: GameEvent[] = [
      evRegionStart(),           // hadBattle=true
      evKill('k1'),
      evPhase('corruption'),     // processNext should pause here
      evCorruptionPlacement(),
      evPhase('end'),
    ];
    act(() => result.current.syncAfterAction(fakeState(), 10, batch));
    act(() => { vi.advanceTimersByTime(10000); });

    // Battle events processed; queue paused before the corruption phase.
    expect(result.current.events.map((e) => e.type))
      .toEqual(['battle_region_start', 'battle_kill']);
    expect(result.current.paused).toBe(true);

    // User clicks Continue → queue drains the rest.
    act(() => { result.current.resume(); });
    act(() => { vi.advanceTimersByTime(10000); });
    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
      'phase_start', 'corruption_placement', 'phase_start',
    ]);
  });

  test('SSE-first fully processed: syncAfterAction is a no-op (no duplicates)', () => {
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const events = [evKill(), evKill('gormen_warrior_3')];
    act(() => deliver!({ type: 'events', events, seq: 5 }));
    act(() => { vi.advanceTimersByTime(10000); });

    expect(result.current.events.map((e) => e.type)).toEqual(['battle_kill', 'battle_kill']);

    // HTTP response arrives with the same batch + seq. syncAfterAction
    // detects sseBuffer has seq=5 and skips the queueing path; no dupes.
    act(() => result.current.syncAfterAction(fakeState(), 5, events));
    act(() => { vi.advanceTimersByTime(10000); });
    expect(result.current.events.map((e) => e.type)).toEqual(['battle_kill', 'battle_kill']);
  });

  test('REGRESSION: SSE-first paused at corruption, HTTP arrives — no duplicates, tail still animates on resume', () => {
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const batch: GameEvent[] = [
      evRegionStart(),
      evKill(),
      evPhase('corruption'),
      evCorruptionPlacement(),
      evCorruptionPlacement(),
      evPhase('end'),
    ];
    act(() => deliver!({ type: 'events', events: batch, seq: 10 }));
    act(() => { vi.advanceTimersByTime(10000); });

    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
    ]);
    expect(result.current.paused).toBe(true);

    // HTTP response for the same batch. syncAfterAction should NOT re-queue
    // (queue already holds the unprocessed tail).
    act(() => result.current.syncAfterAction(fakeState(), 10, batch));
    // Before resume, state hasn't changed — still paused with same log.
    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
    ]);

    // Resume; tail animates through the queue once.
    act(() => { result.current.resume(); });
    act(() => { vi.advanceTimersByTime(10000); });
    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
      'phase_start', 'corruption_placement', 'corruption_placement', 'phase_start',
    ]);
  });

  test('REGRESSION: SSE action batch + ahead AI batch pre-HTTP — events logged exactly once', () => {
    // Server broadcasts the action's events (seq=N), then continueInBackground
    // broadcasts AI follow-up events (seq=M > N). Both arrive before the
    // HTTP response. Used to duplicate the AI chunk because drain-then-
    // requeue ran both paths.
    const { result } = renderHook(() => useGameStream('g1'));
    act(() => deliver!({ type: 'history', state: fakeState(), events: [], chat: [] }));

    const actionBatch: GameEvent[] = [
      evRegionStart(),
      evKill('kill_a'),
      evPhase('corruption'),
      evCorruptionPlacement(),
    ];
    const aiBatch: GameEvent[] = [
      evKill('ai_kill_1'),
      evKill('ai_kill_2'),
    ];
    act(() => deliver!({ type: 'events', events: actionBatch, seq: 10 }));
    act(() => deliver!({ type: 'events', events: aiBatch, seq: 20 }));
    act(() => { vi.advanceTimersByTime(10000); });

    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
    ]);
    expect(result.current.paused).toBe(true);

    // HTTP arrives with the action seq=10. With sseBatchedThis=true it must
    // be a no-op — don't re-queue ahead batches.
    act(() => result.current.syncAfterAction(fakeState(), 10, actionBatch));
    act(() => { result.current.resume(); });
    act(() => { vi.advanceTimersByTime(10000); });

    expect(result.current.events.map((e) => e.type)).toEqual([
      'battle_region_start', 'battle_kill',
      'phase_start', 'corruption_placement',
      'battle_kill', 'battle_kill',
    ]);
    const aiKills = result.current.events
      .filter((e) => e.type === 'battle_kill' && (e as { targetId: string }).targetId.startsWith('ai_kill_'));
    expect(aiKills.map((e) => (e as { targetId: string }).targetId))
      .toEqual(['ai_kill_1', 'ai_kill_2']);
  });

  test('cleanup runs when the hook unmounts', () => {
    const { unmount } = renderHook(() => useGameStream('g1'));
    expect(cleanupCalled).toBe(false);
    unmount();
    expect(cleanupCalled).toBe(true);
  });
});

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameEvent, GameState } from '@ruin/engine';
import { applyEvent } from '@ruin/engine';
import type { EventListener } from './useGameStream.js';

/**
 * Plays a pre-generated event list through the same pacing/listener contract
 * as useGameStream (including the pause before corruption after battles).
 * Used by the demo/replay harness.
 */
export function useLocalReplay(initial: GameState | null, events: GameEvent[], eventDuration: (e: GameEvent) => number) {
  const [state, setState] = useState<GameState | null>(initial);
  const [log, setLog] = useState<GameEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [running, setRunning] = useState(false);
  const stateRef = useRef(initial);
  const idx = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listeners = useRef(new Set<EventListener>());
  const durationRef = useRef(eventDuration);
  durationRef.current = eventDuration;
  const pausedRef = useRef(false);
  const hadBattle = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    stateRef.current = initial;
    setState(initial);
    setLog([]);
    idx.current = 0;
    if (timer.current) clearTimeout(timer.current);
  }, [initial, events]);

  const step = useCallback(() => {
    if (!runningRef.current) return;
    const ev = events[idx.current];
    if (!ev) { runningRef.current = false; setRunning(false); return; }
    if (ev.type === 'phase_start' && ev.phase === 'corruption' && hadBattle.current && !pausedRef.current) {
      pausedRef.current = true;
      setPaused(true);
      return;
    }
    idx.current++;
    if (ev.type === 'battle_region_start') hadBattle.current = true;
    if (ev.type === 'round_start') hadBattle.current = false;
    try {
      const next = stateRef.current ? applyEvent(stateRef.current, ev) : null;
      stateRef.current = next;
      setState(next);
    } catch (err) {
      console.warn('[replay] applyEvent failed', ev.type, err);
    }
    setLog((prev) => [...prev, ev]);
    for (const l of listeners.current) l(ev, stateRef.current);
    const d = durationRef.current(ev);
    timer.current = setTimeout(step, d);
  }, [events]);

  const play = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    step();
  }, [step]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    hadBattle.current = false;
    setPaused(false);
    step();
  }, [step]);

  /** Apply events instantly (no animation) until `predicate` matches the next event. */
  const skipUntil = useCallback((predicate: (e: GameEvent) => boolean) => {
    let s = stateRef.current;
    const skipped: GameEvent[] = [];
    while (idx.current < events.length && !predicate(events[idx.current]!)) {
      const ev = events[idx.current++]!;
      try { s = s ? applyEvent(s, ev) : s; } catch { /* keep going */ }
      skipped.push(ev);
    }
    stateRef.current = s;
    setState(s);
    setLog((prev) => [...prev, ...skipped]);
  }, [events]);

  const subscribe = useCallback((l: EventListener) => {
    listeners.current.add(l);
    return () => { listeners.current.delete(l); };
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { state, log, paused, running, play, stop, resume, skipUntil, subscribe };
}

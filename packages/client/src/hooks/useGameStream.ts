import { useEffect, useState, useCallback, useRef } from 'react';
import type { GameState, GameEvent } from '@ruin/engine';
import { applyEvent } from '@ruin/engine';
import { connectGameStream } from '../api/sse.js';
import type { ChatMessage, StreamEvent } from '../api/sse.js';

export type { ChatMessage };

// ── Animation durations per event type (ms) ──────────────────────────────────

// TODO: remove DEBUG_MULTIPLIER after testing
const DEBUG_MULTIPLIER = 5;

function getEventDuration(event: GameEvent): number {
  const base = (() => {
    switch (event.type) {
      case 'phase_start':       return 1500;
      case 'summon_figure':     return 800;
      case 'play_card':         return 800;
      case 'card_effect':
        if (event.subtype === 'call_to_war' || event.subtype === 'teleport') return 800;
        return 200;
      case 'summoning_pass':    return 0;
      case 'battle_region_start': return 500;
      case 'battle_roll':       return 800;
      case 'battle_kill':       return 500;
      case 'peasant_claimed':   return 300;
      case 'domination_result': return event.conquered ? 600 : 0;
      case 'domination_failed': return 0;
      case 'corruption_placement': return 300;
      case 'ruination':         return 1000;
      case 'ruination_scoring': return 600;
      case 'dial_advance':      return 400;
      case 'dial_vp':           return 300;
      case 'hero_removal':      return 500;
      case 'game_over':         return 2000;
      case 'awaiting_action':   return 0;
      default:                  return 0;
    }
  })();
  return base * DEBUG_MULTIPLIER;
}

export interface GameStreamResult {
  state: GameState | null;
  events: GameEvent[];
  lastEvent: GameEvent | null;
  chat: ChatMessage[];
  connected: boolean;
  /** Call after submitting an action — syncs state and skips redundant SSE events. */
  syncAfterAction: (state: GameState, seq: number) => void;
  /** True when the queue is paused at a phase transition (battle → corruption). */
  paused: boolean;
  /** Resume the queue after a pause. */
  resume: () => void;
}

export function useGameStream(gameId: string): GameStreamResult {
  const [state, setState]         = useState<GameState | null>(null);
  const [events, setEvents]       = useState<GameEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const [chat, setChat]           = useState<ChatMessage[]>([]);
  const [connected, setConn]      = useState(false);

  const stateRef = useRef<GameState | null>(null);
  stateRef.current = state;
  const queue = useRef<GameEvent[]>([]);
  const processing = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownSeq = useRef(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  const processNext = useCallback(() => {
    if (queue.current.length === 0) {
      processing.current = false;
      return;
    }

    // Pause before corruption phase — let user absorb battle results
    const peek = queue.current[0];
    if (peek && peek.type === 'phase_start' && peek.phase === 'corruption' && !pausedRef.current) {
      pausedRef.current = true;
      setPaused(true);
      return;
    }


    const event = queue.current.shift()!;
    const s = stateRef.current;

    if (s) {
      const next = applyEvent(s, event);
      setState(next);
      stateRef.current = next;
    }

    setEvents(prev => [...prev, event]);
    setLastEvent(event);

    const delay = getEventDuration(event);
    if (delay > 0) {
      timerRef.current = setTimeout(processNext, delay);
    } else {
      Promise.resolve().then(processNext);
    }
  }, []);

  const startProcessing = useCallback(() => {
    if (processing.current) return;
    processing.current = true;
    processNext();
  }, [processNext]);

  const handleEvent = useCallback((ev: StreamEvent) => {
    if (ev.type === 'history') {
      queue.current = [];
      if (timerRef.current) clearTimeout(timerRef.current);
      processing.current = false;

      setState(ev.state);
      stateRef.current = ev.state;
      setEvents(ev.events ?? []);
      setChat(ev.chat);
      setConn(true);
    } else if (ev.type === 'sync') {
      // Authoritative state — apply immediately, drain queued events to log.
      // Fire lastEvent for each drained event so animation hooks see them all
      // (especially phase_start banners).
      if (queue.current.length > 0) {
        const remaining = queue.current.splice(0);
        setEvents(prev => [...prev, ...remaining]);
        for (const e of remaining) {
          if (getEventDuration(e) > 0) setLastEvent(e);
        }
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      processing.current = false;
      setState(ev.state);
      stateRef.current = ev.state;
    } else if (ev.type === 'events') {
      // Skip events the client already has from the action response
      if (ev.seq !== undefined && ev.seq <= knownSeq.current) return;
      queue.current.push(...ev.events);
      startProcessing();
    } else if (ev.type === 'chat') {
      setChat(prev => [...prev, ev.message]);
    }
  }, [startProcessing]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    processNext();
  }, [processNext]);

  /** Called by GamePage after a successful action POST.
   *  Syncs to the returned state and skips SSE events up to `seq`. */
  const syncAfterAction = useCallback((actionState: GameState, seq: number) => {
    // Drain remaining queued events into the log before syncing
    if (queue.current.length > 0) {
      const remaining = queue.current.splice(0);
      setEvents(prev => [...prev, ...remaining]);
      if (remaining.length > 0) setLastEvent(remaining[remaining.length - 1]!);
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    processing.current = false;

    setState(actionState);
    stateRef.current = actionState;
    knownSeq.current = seq;
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    setConn(false);
    queue.current = [];
    if (timerRef.current) clearTimeout(timerRef.current);
    processing.current = false;
    knownSeq.current = 0;

    const cleanup = connectGameStream(gameId, handleEvent);
    return cleanup;
  }, [gameId, handleEvent]);

  return { state, events, lastEvent, chat, connected, syncAfterAction, paused, resume };
}

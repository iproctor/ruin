import { useEffect, useState, useCallback, useRef } from 'react';
import type { GameState, GameEvent } from '@ruin/engine';
import { applyEvent } from '@ruin/engine';
import { connectGameStream } from '../api/sse.js';
import type { ChatMessage, StreamEvent } from '../api/sse.js';

export type { ChatMessage };

// ── Animation durations per event type (ms) ──────────────────────────────────

const DEBUG_MULTIPLIER = 1;

const BATTLE_EVENTS = new Set([
  'battle_region_start', 'battle_roll', 'battle_kill', 'peasant_claimed',
  'rapture_control', 'heartrippers_corruption', 'war_frenzy_partial',
  'figure_removed', 'battle_cleanup', 'protected_cleared', 'control_released',
]);
const CORRUPTION_EVENTS = new Set([
  'domination_result', 'domination_failed', 'corruption_placement',
  'war_cry_block', 'deaths_perfume', 'vile_consumption',
  'ruination', 'ruination_blocked', 'dial_counter', 'provender_score',
  'ruination_scoring',
]);

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
  const phaseMultiplier = BATTLE_EVENTS.has(event.type) ? 2
    : CORRUPTION_EVENTS.has(event.type) ? 3
    : 1;
  return base * phaseMultiplier * DEBUG_MULTIPLIER;
}

export interface GameStreamResult {
  state: GameState | null;
  events: GameEvent[];
  lastEvent: GameEvent | null;
  chat: ChatMessage[];
  connected: boolean;
  /** Call after submitting an action — syncs state and skips redundant SSE events. */
  syncAfterAction: (state: GameState, seq: number, events?: GameEvent[]) => void;
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
  type QueueItem = { kind: 'event'; event: GameEvent } | { kind: 'sync'; state: GameState };
  const queue = useRef<QueueItem[]>([]);
  const processing = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownSeq = useRef(0);
  // Buffer of SSE event batches, kept so syncAfterAction can replay events
  // that arrived before the HTTP response.
  const sseBuffer = useRef<{ seq: number; events: GameEvent[] }[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const hadBattle = useRef(false);

  const processNext = useCallback(() => {
    if (queue.current.length === 0) {
      processing.current = false;
      return;
    }

    // Pause before corruption phase — but only if battles actually happened
    const peek = queue.current[0];
    if (peek && peek.kind === 'event' && peek.event.type === 'phase_start' && peek.event.phase === 'corruption' && !pausedRef.current && hadBattle.current) {
      pausedRef.current = true;
      setPaused(true);
      return;
    }

    const item = queue.current.shift()!;

    if (item.kind === 'sync') {
      setState(item.state);
      stateRef.current = item.state;
      Promise.resolve().then(processNext);
      return;
    }

    const event = item.event;

    // Track whether battles happened this round
    if (event.type === 'battle_region_start') hadBattle.current = true;
    if (event.type === 'round_start') hadBattle.current = false;

    const s = stateRef.current;

    if (s) {
      try {
        const next = applyEvent(s, event);
        setState(next);
        stateRef.current = next;
      } catch (err) {
        console.error('[event] applyEvent failed, skipping:', event.type, err);
      }
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
      sseBuffer.current = [];
      if (timerRef.current) clearTimeout(timerRef.current);
      processing.current = false;

      setState(ev.state);
      stateRef.current = ev.state;
      setEvents(ev.events ?? []);
      setChat(ev.chat);
      setConn(true);
    } else if (ev.type === 'sync') {
      // Queue the authoritative state swap so it lands after any in-flight
      // animations play out — otherwise cross-round syncs (AI-only battle →
      // new summoning) snap past the intervening events.
      queue.current.push({ kind: 'sync', state: ev.state });
      startProcessing();
    } else if (ev.type === 'events') {
      // Skip events the client already has from the action response
      if (ev.seq !== undefined && ev.seq <= knownSeq.current) return;
      // Buffer for potential replay by syncAfterAction
      if (ev.seq !== undefined) sseBuffer.current.push({ seq: ev.seq, events: ev.events });
      for (const event of ev.events) queue.current.push({ kind: 'event', event });
      startProcessing();
    } else if (ev.type === 'chat') {
      setChat(prev => [...prev, ev.message]);
    }
  }, [startProcessing]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    hadBattle.current = false;
    setPaused(false);
    processNext();
  }, [processNext]);

  /** Called by GamePage after a successful action POST.
   *  Syncs to the returned state and replays any SSE events that arrived
   *  ahead of the HTTP response (seq > actionSeq). */
  const syncAfterAction = useCallback((actionState: GameState, seq: number, actionEvents?: GameEvent[]) => {
    // Stop any in-progress queue processing
    if (timerRef.current) clearTimeout(timerRef.current);
    processing.current = false;
    queue.current = [];

    // Apply authoritative action state
    knownSeq.current = seq;
    setState(actionState);
    stateRef.current = actionState;

    // Add the action's events to the log (no animation delay), unless SSE
    // already delivered this batch — in which case processNext already
    // appended them.
    const alreadyLogged = sseBuffer.current.some(b => b.seq >= seq);
    if (!alreadyLogged && actionEvents && actionEvents.length > 0) {
      setEvents(prev => [...prev, ...actionEvents]);
      setLastEvent(actionEvents[actionEvents.length - 1]!);
    }

    // Replay any SSE events that arrived ahead of the HTTP response.
    // These have seq > actionSeq and need to be re-applied on top of
    // the authoritative actionState.
    const ahead = sseBuffer.current.filter(b => b.seq > seq);
    sseBuffer.current = [];
    if (ahead.length > 0) {
      for (const batch of ahead) {
        for (const event of batch.events) queue.current.push({ kind: 'event', event });
      }
      startProcessing();
    }
  }, [startProcessing]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    setConn(false);
    queue.current = [];
    sseBuffer.current = [];
    if (timerRef.current) clearTimeout(timerRef.current);
    processing.current = false;
    knownSeq.current = 0;

    const cleanup = connectGameStream(gameId, handleEvent);
    return cleanup;
  }, [gameId, handleEvent]);

  return { state, events, lastEvent, chat, connected, syncAfterAction, paused, resume };
}

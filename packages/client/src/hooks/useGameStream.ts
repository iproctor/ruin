import { useEffect, useState, useCallback, useRef } from 'react';
import type { GameState, GameEvent } from '@ruin/engine';
import { applyEvent } from '@ruin/engine';
import { connectGameStream } from '../api/sse.js';
import type { ChatMessage, StreamEvent } from '../api/sse.js';

export type { ChatMessage };

export interface GameStreamResult {
  state: GameState | null;
  events: GameEvent[];
  chat: ChatMessage[];
  connected: boolean;
}

export function useGameStream(gameId: string): GameStreamResult {
  const [state, setState]       = useState<GameState | null>(null);
  const [events, setEvents]     = useState<GameEvent[]>([]);
  const [chat, setChat]         = useState<ChatMessage[]>([]);
  const [connected, setConn]    = useState(false);

  // Keep a ref to current state so the event handler can read it without
  // re-creating the callback (which would cause SSE reconnects).
  const stateRef = useRef<GameState | null>(null);
  stateRef.current = state;

  const handleEvent = useCallback((ev: StreamEvent) => {
    if (ev.type === 'history') {
      setState(ev.state);
      stateRef.current = ev.state;
      setEvents(ev.events ?? []);
      setChat(ev.chat);
      setConn(true);
    } else if (ev.type === 'sync') {
      // Full state sync at round boundaries — corrects any drift
      setState(ev.state);
      stateRef.current = ev.state;
    } else if (ev.type === 'events') {
      // Apply each event to local state to keep it current
      let s = stateRef.current;
      if (s) {
        for (const event of ev.events) {
          s = applyEvent(s, event);
        }
        setState(s);
        stateRef.current = s;
      }
      setEvents((prev) => [...prev, ...ev.events]);
    } else if (ev.type === 'chat') {
      setChat((prev) => [...prev, ev.message]);
    }
  }, []);

  useEffect(() => {
    setConn(false);
    const cleanup = connectGameStream(gameId, handleEvent);
    return cleanup;
  }, [gameId, handleEvent]);

  return { state, events, chat, connected };
}

import { useEffect, useState, useCallback } from 'react';
import type { GameState, GameEvent } from '@ruin/engine';
import { connectGameStream } from '../api/sse.js';
import type { ChatMessage, StreamEvent } from '../api/sse.js';

export type { ChatMessage };

export interface GameStreamResult {
  state: GameState | null;
  eventLog: string[];
  events: GameEvent[];
  chat: ChatMessage[];
  connected: boolean;
}

export function useGameStream(gameId: string): GameStreamResult {
  const [state, setState]       = useState<GameState | null>(null);
  const [eventLog, setLog]      = useState<string[]>([]);
  const [events, setEvents]     = useState<GameEvent[]>([]);
  const [chat, setChat]         = useState<ChatMessage[]>([]);
  const [connected, setConn]    = useState(false);

  const handleEvent = useCallback((ev: StreamEvent) => {
    if (ev.type === 'history') {
      setState(ev.state);
      setLog(ev.eventLog ?? []);
      setEvents(ev.events ?? []);
      setChat(ev.chat);
      setConn(true);
    } else if (ev.type === 'state' || ev.type === 'sync') {
      setState(ev.state);
    } else if (ev.type === 'log') {
      setLog((prev) => [...prev, ...ev.entries]);
    } else if (ev.type === 'events') {
      setEvents((prev) => [...prev, ...ev.events]);
    } else if (ev.type === 'phase_events') {
      // Legacy: phase_events are now GameEvent[], merge into events
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

  return { state, eventLog, events, chat, connected };
}

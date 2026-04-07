import { useEffect, useState, useCallback } from 'react';
import type { GameState } from '@ruin/engine';
import { connectGameStream } from '../api/sse.js';
import type { ChatMessage, StreamEvent } from '../api/sse.js';

export type { ChatMessage };

export interface GameStreamResult {
  state: GameState | null;
  eventLog: string[];
  chat: ChatMessage[];
  connected: boolean;
}

export function useGameStream(gameId: string): GameStreamResult {
  const [state, setState]    = useState<GameState | null>(null);
  const [eventLog, setLog]   = useState<string[]>([]);
  const [chat, setChat]      = useState<ChatMessage[]>([]);
  const [connected, setConn] = useState(false);

  const handleEvent = useCallback((ev: StreamEvent) => {
    if (ev.type === 'history') {
      setState(ev.state);
      setLog(ev.eventLog);
      setChat(ev.chat);
      setConn(true);
    } else if (ev.type === 'state') {
      setState(ev.state);
    } else if (ev.type === 'log') {
      setLog((prev) => [...prev, ...ev.entries]);
    } else if (ev.type === 'chat') {
      setChat((prev) => [...prev, ev.message]);
    }
  }, []);

  useEffect(() => {
    setConn(false);
    const cleanup = connectGameStream(gameId, handleEvent);
    return cleanup;
  }, [gameId, handleEvent]);

  return { state, eventLog, chat, connected };
}

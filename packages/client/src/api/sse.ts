import type { GameState, GameEvent } from '@ruin/engine';

const TOKEN_KEY = 'ruin_token';

export interface ChatMessage {
  id: string;
  power: string | null;
  username: string;
  message: string;
  createdAt: string;
}

export type StreamEvent =
  | { type: 'history'; state: GameState; events: GameEvent[]; chat: ChatMessage[] }
  | { type: 'sync';    state: GameState }
  | { type: 'events';  events: GameEvent[]; seq?: number }
  | { type: 'chat';    message: ChatMessage }
  | { type: 'error';   message: string }
  | { type: 'lobby_state'; lobby: unknown; chat: ChatMessage[] }
  | { type: 'lobby_update'; players: unknown[]; invitations: unknown[] }
  | { type: 'game_started' };

/**
 * Open a reconnecting SSE stream. On network errors the connection is closed
 * and retried after a short delay; the optional `getSinceSeq` callback lets
 * the caller resume from the last processed seq so the server can skip the
 * full history on reconnect.
 */
export function connectGameStream(
  gameId: string,
  onEvent: (event: StreamEvent) => void,
  getSinceSeq?: () => number | null,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function open() {
    if (closed) return;
    const token = localStorage.getItem(TOKEN_KEY);
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    const since = getSinceSeq?.();
    if (since !== null && since !== undefined && since > 0) {
      params.set('sinceSeq', String(since));
    }
    const qs = params.toString();
    const url = `/api/games/${encodeURIComponent(gameId)}/stream${qs ? `?${qs}` : ''}`;

    es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string) as StreamEvent;
        onEvent(data);
      } catch {
        // ignore malformed messages
      }
    };

    es.onerror = () => {
      if (closed) return;
      es?.close();
      es = null;
      // Backoff a bit so we don't spin on a broken server
      retryTimer = setTimeout(open, 1000);
    };
  }

  open();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
  };
}

import type { LobbySnapshot, LobbyOnlineUser, LobbyChatMsg } from './client.js';

export type LobbyStreamEvent =
  | { type: 'snapshot'; snapshot: LobbySnapshot }
  | { type: 'presence'; online: LobbyOnlineUser[] }
  | { type: 'games_update' }
  | { type: 'chat'; message: LobbyChatMsg }
  | { type: 'invited'; gameId: string }
  | { type: 'error'; message: string };

export function connectLobbyStream(
  onEvent: (e: LobbyStreamEvent) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function open() {
    if (closed) return;
    const token = localStorage.getItem(TOKEN_KEY);
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    es = new EventSource(`/api/lobby/stream?${params.toString()}`);
    es.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data as string) as LobbyStreamEvent); } catch { /* ignore */ }
    };
    es.onerror = () => {
      if (closed) return;
      es?.close();
      es = null;
      retryTimer = setTimeout(open, 1000);
    };
  }

  open();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
  };
}

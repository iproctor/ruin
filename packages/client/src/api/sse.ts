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
  | { type: 'error';   message: string };

export function connectGameStream(
  gameId: string,
  onEvent: (event: StreamEvent) => void,
): () => void {
  const token = localStorage.getItem(TOKEN_KEY);
  const params = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `/api/games/${encodeURIComponent(gameId)}/stream${params}`;

  const es = new EventSource(url);

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string) as StreamEvent;
      onEvent(data);
    } catch {
      // ignore malformed messages
    }
  };

  return () => es.close();
}

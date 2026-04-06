import type { GameState } from '@ruin/engine';

const TOKEN_KEY = 'ruin_token';

export function connectGameStream(
  gameId: string,
  onState: (state: GameState) => void,
  onError?: (e: Event) => void,
): () => void {
  const token = localStorage.getItem(TOKEN_KEY);
  const params = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `/api/games/${encodeURIComponent(gameId)}/stream${params}`;

  const es = new EventSource(url);

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string) as { type: string; state?: GameState };
      if (data.type === 'state' && data.state) {
        onState(data.state);
      }
    } catch {
      // ignore malformed messages
    }
  };

  if (onError) {
    es.onerror = onError;
  }

  return () => {
    es.close();
  };
}

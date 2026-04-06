import { useEffect, useState } from 'react';
import type { GameState } from '@ruin/engine';
import { connectGameStream } from '../api/sse.js';

export function useGameStream(gameId: string): GameState | null {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    const cleanup = connectGameStream(gameId, (s) => setState(s));
    return cleanup;
  }, [gameId]);

  return state;
}

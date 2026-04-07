import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { GameState, Power } from '@ruin/engine';

interface GameContextValue {
  state: GameState | null;
  gameId: string | null;
  myPower: Power | null;
  setState(s: GameState): void;
}

const GameContext = createContext<GameContextValue | null>(null);

interface GameProviderProps {
  gameId: string;
  myPower: Power | null;
  initialState?: GameState | null;
  children: React.ReactNode;
}

export function GameProvider({ gameId, myPower, initialState, children }: GameProviderProps) {
  const [state, setState] = useState<GameState | null>(null);

  // Seed from HTTP response; SSE will overwrite with real-time updates.
  useEffect(() => {
    if (initialState && !state) setState(initialState);
  }, [initialState]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<GameContextValue>(
    () => ({ state, gameId, myPower, setState }),
    [state, gameId, myPower],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}

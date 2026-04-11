import type { Response } from 'express';
import type { Power, GameEvent } from '@ruin/engine';
import { maskEvents } from '@ruin/engine';

interface Listener {
  res: Response;
  power: Power | null;  // which power this viewer controls (null = spectator)
}

// Map of gameId → Set of active SSE listeners
const listeners = new Map<string, Set<Listener>>();

export function addListener(gameId: string, res: Response, power: Power | null = null): void {
  if (!listeners.has(gameId)) {
    listeners.set(gameId, new Set());
  }
  listeners.get(gameId)!.add({ res, power });
}

export function removeListener(gameId: string, res: Response): void {
  const gameListeners = listeners.get(gameId);
  if (!gameListeners) return;
  for (const l of gameListeners) {
    if (l.res === res) {
      gameListeners.delete(l);
      break;
    }
  }
  if (gameListeners.size === 0) {
    listeners.delete(gameId);
  }
}

/** Broadcast the same payload to all listeners (no masking). */
export function broadcast(gameId: string, data: unknown): void {
  const gameListeners = listeners.get(gameId);
  if (!gameListeners || gameListeners.size === 0) return;

  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const l of gameListeners) {
    try {
      l.res.write(payload);
    } catch {
      // Client disconnected — cleaned up by close handler
    }
  }
}

/** Broadcast events with per-viewer masking of hidden info. */
export function broadcastEvents(gameId: string, events: GameEvent[]): void {
  const gameListeners = listeners.get(gameId);
  if (!gameListeners || gameListeners.size === 0) return;

  for (const l of gameListeners) {
    const masked = maskEvents(events, l.power);
    const payload = `data: ${JSON.stringify({ type: 'events', events: masked })}\n\n`;
    try {
      l.res.write(payload);
    } catch {
      // Client disconnected
    }
  }
}

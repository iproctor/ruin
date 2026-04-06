import type { Response } from 'express';

// Map of gameId → Set of active SSE response objects
const listeners = new Map<string, Set<Response>>();

export function addListener(gameId: string, res: Response): void {
  if (!listeners.has(gameId)) {
    listeners.set(gameId, new Set());
  }
  listeners.get(gameId)!.add(res);
}

export function removeListener(gameId: string, res: Response): void {
  const gameListeners = listeners.get(gameId);
  if (!gameListeners) return;
  gameListeners.delete(res);
  if (gameListeners.size === 0) {
    listeners.delete(gameId);
  }
}

export function broadcast(gameId: string, data: unknown): void {
  const gameListeners = listeners.get(gameId);
  if (!gameListeners || gameListeners.size === 0) return;

  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of gameListeners) {
    try {
      res.write(payload);
    } catch {
      // Client disconnected — will be cleaned up by the close handler
    }
  }
}

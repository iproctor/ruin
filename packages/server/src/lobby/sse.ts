import type { Response } from 'express';

interface Listener {
  res: Response;
  userId: string;
  username: string;
}

const listeners = new Set<Listener>();

export function addLobbyListener(res: Response, userId: string, username: string): Listener {
  const l: Listener = { res, userId, username };
  listeners.add(l);
  return l;
}

export function removeLobbyListener(l: Listener): void {
  listeners.delete(l);
}

export function broadcastLobby(data: unknown): void {
  if (listeners.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const l of listeners) {
    try { l.res.write(payload); } catch { /* dropped on close */ }
  }
}

/** Send to a specific user's connections (may be multiple tabs). */
export function sendToUser(userId: string, data: unknown): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const l of listeners) {
    if (l.userId === userId) {
      try { l.res.write(payload); } catch { /* dropped */ }
    }
  }
}

export function getOnlineUsers(): Array<{ userId: string; username: string }> {
  const seen = new Map<string, string>();
  for (const l of listeners) {
    if (!seen.has(l.userId)) seen.set(l.userId, l.username);
  }
  return Array.from(seen, ([userId, username]) => ({ userId, username }));
}

export function isOnline(userId: string): boolean {
  for (const l of listeners) if (l.userId === userId) return true;
  return false;
}

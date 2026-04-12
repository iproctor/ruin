import type { GameState, Action } from '@ruin/engine';

const BASE = '/api';
const TOKEN_KEY = 'ruin_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore parse error
    }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export async function register(
  username: string,
  password: string,
  email?: string,
): Promise<{ token: string }> {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, email }),
  });
}

export async function login(
  username: string,
  password: string,
): Promise<{ token: string }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function requestMagicLink(email: string, gameId?: string): Promise<void> {
  await request('/auth/magic-link/request', {
    method: 'POST',
    body: JSON.stringify({ email, gameId }),
  });
}

export async function consumeMagicLink(
  token: string,
): Promise<{ token: string; gameId?: string }> {
  const res = await request<{ token: string; gameId?: string | null }>(
    `/auth/magic-link/${encodeURIComponent(token)}`,
  );
  // Normalize null → undefined
  return { token: res.token, gameId: res.gameId ?? undefined };
}

// ── Games ───────────────────────────────────────────────────────────────────

export interface CreateGameBody {
  powers: string[];
  playerTypes: Record<string, string>;
  inviteEmails?: Array<{ power: string; email: string }>;
}

export async function createGame(body: CreateGameBody): Promise<{ gameId: string }> {
  return request('/games', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface GameSummary {
  id: string;
  round: number;
  phase: string;
  isComplete: boolean;
  createdAt: string;
  updatedAt: string;
  powers: Array<{ power: string; playerType: string; userId: string | null }>;
  name: string | null;
  status: string;
}

export async function listGames(): Promise<GameSummary[]> {
  const res = await request<{ games: GameSummary[] }>('/games');
  return res.games;
}

export interface GamePlayerInfo {
  power: string;
  playerType: string; // 'human' | 'ai' | 'guest'
  username: string | null;
}

export async function getGame(gameId: string): Promise<{ state: GameState; myPower: string | null; myPowers: string[]; players: GamePlayerInfo[] }> {
  return request<{ state: GameState; myPower: string | null; myPowers: string[]; players: GamePlayerInfo[] }>(`/games/${gameId}`);
}

export async function submitAction(gameId: string, action: Action): Promise<{ state: GameState; seq: number; events: import('@ruin/engine').GameEvent[] }> {
  return request<{ state: GameState; seq: number; events: import('@ruin/engine').GameEvent[] }>(`/games/${gameId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export async function sendChat(gameId: string, message: string): Promise<void> {
  await request(`/games/${gameId}/chat`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

// ── Lobby ──────────────────────────────────────────────────────────────────

export interface LobbyPlayer {
  userId: string;
  username: string;
  power: string | null;
  isCreator: boolean;
}

export interface LobbyInvitation {
  id: string;
  email: string;
  status: string;
  createdAt: string;
}

export interface LobbyState {
  game: { id: string; name: string | null; isPublic: boolean; status: string; createdBy: string };
  players: LobbyPlayer[];
  invitations: LobbyInvitation[];
}

export async function createMultiplayerGame(name: string, isPublic?: boolean): Promise<{ gameId: string }> {
  return request('/games', {
    method: 'POST',
    body: JSON.stringify({ mode: 'multiplayer', name, isPublic }),
  });
}

export async function getLobby(gameId: string): Promise<LobbyState> {
  return request(`/games/${gameId}/lobby`);
}

export async function invitePlayer(gameId: string, email: string): Promise<void> {
  await request(`/games/${gameId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function joinGame(gameId: string): Promise<void> {
  await request(`/games/${gameId}/join`, { method: 'POST' });
}

export async function leaveGame(gameId: string): Promise<void> {
  await request(`/games/${gameId}/leave`, { method: 'POST' });
}

export async function kickPlayer(gameId: string, userId: string): Promise<void> {
  await request(`/games/${gameId}/kick`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export interface PowerAssignment {
  power: string;
  type: 'human' | 'ai' | 'none';
  userId?: string;
}

export async function startGame(gameId: string, powerConfig: PowerAssignment[]): Promise<void> {
  await request(`/games/${gameId}/start`, {
    method: 'POST',
    body: JSON.stringify({ powerConfig }),
  });
}

export async function revokeInvitation(gameId: string, invitationId: string): Promise<void> {
  await request(`/games/${gameId}/invitations/${invitationId}`, { method: 'DELETE' });
}

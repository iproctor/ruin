import type { GameState, Action } from '@ruin/engine';

const BASE = '/api';
const TOKEN_KEY = 'ruin_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
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
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) msg = body.error;
      if (body.code) code = body.code;
    } catch {
      // ignore parse error
    }
    throw new ApiError(msg, res.status, code);
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

// ── Games ───────────────────────────────────────────────────────────────────

export interface CreateGameBody {
  powers: string[];
  playerTypes: Record<string, string>;
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
  powers: Array<{ power: string; playerType: string; userId: string | null; username: string | null }>;
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

export async function getGame(gameId: string): Promise<{ state: GameState; myPower: string | null; myPowers: string[]; players: GamePlayerInfo[]; name: string | null }> {
  return request<{ state: GameState; myPower: string | null; myPowers: string[]; players: GamePlayerInfo[]; name: string | null }>(`/games/${gameId}`);
}

export async function submitAction(gameId: string, action: Action): Promise<{ state: GameState; seq: number; events: import('@ruin/engine').GameEvent[] }> {
  return request<{ state: GameState; seq: number; events: import('@ruin/engine').GameEvent[] }>(`/games/${gameId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export async function submitActions(gameId: string, actions: Action[]): Promise<{ state: GameState; seq: number; events: import('@ruin/engine').GameEvent[] }> {
  return request<{ state: GameState; seq: number; events: import('@ruin/engine').GameEvent[] }>(`/games/${gameId}/action`, {
    method: 'POST',
    body: JSON.stringify({ actions }),
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
  locked: boolean;
  isCreator: boolean;
}

export interface LobbyInvitation {
  id: string;
  label: string;
  status: string;
  createdAt: string;
}

export interface AiSlot { power: string | null; locked: boolean }

export interface LobbyState {
  game: { id: string; name: string | null; isPublic: boolean; status: string; createdBy: string };
  players: LobbyPlayer[];
  invitations: LobbyInvitation[];
  aiSlots: AiSlot[];
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

export async function invitePlayer(gameId: string, username: string): Promise<void> {
  await request(`/games/${gameId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ username }),
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

export async function assignPlayerPower(gameId: string, userId: string, power: string | null): Promise<void> {
  await request(`/games/${gameId}/assign-player`, {
    method: 'POST',
    body: JSON.stringify({ userId, power }),
  });
}

export async function assignAiSlot(gameId: string, aiIndex: number, power: string | null): Promise<void> {
  await request(`/games/${gameId}/assign-ai`, {
    method: 'POST',
    body: JSON.stringify({ aiIndex, power }),
  });
}

export async function startGame(gameId: string): Promise<void> {
  await request(`/games/${gameId}/start`, { method: 'POST' });
}

export async function revokeInvitation(gameId: string, invitationId: string): Promise<void> {
  await request(`/games/${gameId}/invitations/${invitationId}`, { method: 'DELETE' });
}

export async function cancelGame(gameId: string): Promise<void> {
  await request(`/games/${gameId}/cancel`, { method: 'POST' });
}

export async function pickPower(gameId: string, power: string | null): Promise<void> {
  await request(`/games/${gameId}/pick-power`, {
    method: 'POST',
    body: JSON.stringify({ power }),
  });
}

// ── Global Multiplayer Lobby ───────────────────────────────────────────────

export interface LobbyOnlineUser {
  userId: string;
  username: string;
  inGame: boolean;
}

export interface LobbyGameSummary {
  id: string;
  name: string | null;
  isPublic: boolean;
  createdBy: string;
  createdByUsername: string;
  players: Array<{ userId: string; username: string }>;
  invitedYou: boolean;
}

export interface LobbyChatMsg {
  id: string;
  userId: string;
  username: string;
  message: string;
  createdAt: string;
}

export interface LobbySnapshot {
  online: LobbyOnlineUser[];
  games: LobbyGameSummary[];
  chat: LobbyChatMsg[];
  myPendingGameId: string | null;
  myActiveGameIds: string[];
}

export async function getLobbySnapshot(): Promise<LobbySnapshot> {
  return request<LobbySnapshot>('/lobby/snapshot');
}

export async function sendLobbyChat(message: string): Promise<void> {
  await request('/lobby/chat', { method: 'POST', body: JSON.stringify({ message }) });
}

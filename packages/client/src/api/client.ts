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
}

export async function listGames(): Promise<GameSummary[]> {
  const res = await request<{ games: GameSummary[] }>('/games');
  return res.games;
}

export async function getGame(gameId: string): Promise<GameState> {
  const res = await request<{ state: GameState }>(`/games/${gameId}`);
  return res.state;
}

export async function submitAction(gameId: string, action: Action): Promise<GameState> {
  const res = await request<{ state: GameState }>(`/games/${gameId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
  return res.state;
}

export async function sendChat(gameId: string, message: string): Promise<void> {
  await request(`/games/${gameId}/chat`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

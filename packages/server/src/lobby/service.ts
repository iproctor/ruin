import { eq, and, or, inArray, desc, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  games,
  gamePlayers,
  lobbyPlayers,
  invitations,
  users,
  lobbyChatMessages,
} from '../db/schema.js';
import { broadcastLobby, sendToUser, getOnlineUsers } from './sse.js';

const CHAT_HISTORY_LIMIT = 100;

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

export interface OnlineUser {
  userId: string;
  username: string;
  inGame: boolean;
}

export interface LobbySnapshot {
  online: OnlineUser[];
  games: LobbyGameSummary[];
  chat: LobbyChatMsg[];
  myPendingGameId: string | null;   // game I created and is still pending
  myActiveGameIds: string[];        // games where I'm an active or pending player
}

/**
 * Build the list of multiplayer games visible to a given viewer:
 * - all public pending games where viewer isn't already a player
 * - all private pending games where viewer has a pending invitation
 *
 * Marks `invitedYou=true` for games the viewer was invited to.
 */
async function listVisibleGames(viewerId: string): Promise<LobbyGameSummary[]> {
  const [viewerRow] = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(eq(users.id, viewerId))
    .limit(1);
  if (!viewerRow) return [];

  // Pending invitations for this viewer (by username or email)
  const inviteMatch = viewerRow.email
    ? or(eq(invitations.username, viewerRow.username), eq(invitations.email, viewerRow.email))
    : eq(invitations.username, viewerRow.username);
  const myInviteRows = await db
    .select({ gameId: invitations.gameId })
    .from(invitations)
    .where(and(eq(invitations.invitationStatus, 'pending'), inviteMatch!));
  const invitedGameIds = new Set(myInviteRows.map((r) => r.gameId));

  // Games viewer is already a lobby member of (exclude from "open games")
  const myLobbyRows = await db
    .select({ gameId: lobbyPlayers.gameId })
    .from(lobbyPlayers)
    .where(eq(lobbyPlayers.userId, viewerId));
  const myGameIds = new Set(myLobbyRows.map((r) => r.gameId));

  // All pending games — we filter visibility below
  const pendingRows = await db
    .select()
    .from(games)
    .where(eq(games.status, 'pending'))
    .orderBy(desc(games.createdAt));

  const visible = pendingRows.filter((g) => {
    if (myGameIds.has(g.id)) return false;
    if (g.isPublic) return true;
    return invitedGameIds.has(g.id);
  });
  if (visible.length === 0) return [];

  const gameIds = visible.map((g) => g.id);
  const playerRows = await db
    .select()
    .from(lobbyPlayers)
    .where(inArray(lobbyPlayers.gameId, gameIds));
  const userIds = Array.from(new Set([
    ...visible.map((g) => g.createdBy),
    ...playerRows.map((p) => p.userId),
  ]));
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const usernameById = new Map(userRows.map((u) => [u.id, u.username]));

  return visible.map((g) => ({
    id: g.id,
    name: g.name,
    isPublic: g.isPublic,
    createdBy: g.createdBy,
    createdByUsername: usernameById.get(g.createdBy) ?? 'Unknown',
    players: playerRows
      .filter((p) => p.gameId === g.id)
      .map((p) => ({
        userId: p.userId,
        username: usernameById.get(p.userId) ?? 'Unknown',
      })),
    invitedYou: invitedGameIds.has(g.id),
  }));
}

async function loadChatHistory(): Promise<LobbyChatMsg[]> {
  const rows = await db
    .select()
    .from(lobbyChatMessages)
    .orderBy(desc(lobbyChatMessages.createdAt))
    .limit(CHAT_HISTORY_LIMIT);
  // Reverse to oldest-first for client display
  return rows.reverse().map((r) => ({
    id: r.id,
    userId: r.userId,
    username: r.username,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Game(s) the user is currently engaged in — used to gate "invite to game". */
export async function getUserEngagement(userId: string): Promise<{
  pendingCreatedGameId: string | null;
  inAnyGame: boolean;
}> {
  // Game the user CREATED that is still pending (the game they can invite into)
  const [pending] = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.createdBy, userId), eq(games.status, 'pending')))
    .limit(1);

  // Engaged = in any pending lobby OR in any active (non-complete) game
  const lobbyMembership = await db
    .select({ gameId: lobbyPlayers.gameId })
    .from(lobbyPlayers)
    .where(eq(lobbyPlayers.userId, userId));
  const activeMembership = await db
    .select({ gameId: gamePlayers.gameId, status: games.status })
    .from(gamePlayers)
    .innerJoin(games, eq(gamePlayers.gameId, games.id))
    .where(and(eq(gamePlayers.userId, userId), ne(games.status, 'complete')));

  return {
    pendingCreatedGameId: pending?.id ?? null,
    inAnyGame: lobbyMembership.length > 0 || activeMembership.length > 0,
  };
}

async function enrichOnline(): Promise<OnlineUser[]> {
  const online = getOnlineUsers();
  if (online.length === 0) return [];
  const ids = online.map((o) => o.userId);
  const lobbyMembers = await db
    .select({ userId: lobbyPlayers.userId })
    .from(lobbyPlayers)
    .where(inArray(lobbyPlayers.userId, ids));
  const activeMembers = await db
    .select({ userId: gamePlayers.userId, status: games.status })
    .from(gamePlayers)
    .innerJoin(games, eq(gamePlayers.gameId, games.id))
    .where(ne(games.status, 'complete'));
  const busy = new Set<string>([
    ...lobbyMembers.map((r) => r.userId),
    ...activeMembers.filter((r) => r.userId && ids.includes(r.userId)).map((r) => r.userId!),
  ]);
  return online.map((o) => ({ ...o, inGame: busy.has(o.userId) }));
}

export async function getLobbySnapshot(viewerId: string): Promise<LobbySnapshot> {
  const [online, chat, gamesList, engagement] = await Promise.all([
    enrichOnline(),
    loadChatHistory(),
    listVisibleGames(viewerId),
    getUserEngagement(viewerId),
  ]);

  // Active game ids the viewer is in (any status, but the client uses these to
  // know whether to show the "Game" chat tab)
  const lobbyRows = await db
    .select({ gameId: lobbyPlayers.gameId })
    .from(lobbyPlayers)
    .where(eq(lobbyPlayers.userId, viewerId));

  return {
    online,
    games: gamesList,
    chat,
    myPendingGameId: engagement.pendingCreatedGameId,
    myActiveGameIds: lobbyRows.map((r) => r.gameId),
  };
}

export async function postLobbyChat(
  userId: string,
  username: string,
  message: string,
): Promise<LobbyChatMsg> {
  const [row] = await db
    .insert(lobbyChatMessages)
    .values({ userId, username, message })
    .returning();

  const msg: LobbyChatMsg = {
    id: row!.id,
    userId,
    username,
    message,
    createdAt: row!.createdAt.toISOString(),
  };
  broadcastLobby({ type: 'chat', message: msg });
  return msg;
}

/** Recompute and broadcast the games list to all lobby viewers. */
export async function broadcastGamesUpdate(): Promise<void> {
  // Each viewer needs their own visibility filter, so re-derive per-listener.
  // For simplicity we just notify and let clients refetch their snapshot.
  // Cheap alternative: send the public-only list and let clients merge their
  // private invites locally. For now, push a refresh signal.
  broadcastLobby({ type: 'games_update' });
}

export async function broadcastPresence(): Promise<void> {
  const online = await enrichOnline();
  broadcastLobby({ type: 'presence', online });
}

/** Notify a user that they've been invited to a game. */
export function notifyInvited(targetUserId: string, gameId: string): void {
  sendToUser(targetUserId, { type: 'invited', gameId });
}

import { Worker } from 'node:worker_threads';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createInitialState, applyAction, applyActionForPreview, autoAdvance, getLegalActions, GameLog, maskEvents } from '@ruin/engine';
import type { GameState, Power, Action, PlayerType, GameEvent } from '@ruin/engine';
import { greedyAction } from '@ruin/ai';
import { db } from '../db/client.js';
import { games, gamePlayers, chatMessages, gameEvents, lobbyPlayers, invitations, users } from '../db/schema.js';
import { broadcast, broadcastEvents } from './sse.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  power: string | null;
  username: string;
  message: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskStateForViewer(
  state: GameState,
  viewingUserId: string | null,
  playerMap: Map<string, string>,
): GameState {
  const maskedPowers = { ...state.powers };
  for (const power of state.activePowers) {
    const powerUserId = playerMap.get(power) ?? null;
    if (powerUserId === viewingUserId) continue;
    const ps = maskedPowers[power];
    if (!ps) continue;
    maskedPowers[power] = { ...ps, hand: ps.hand.map(() => '?'), deckIds: [] };
  }
  return { ...state, powers: maskedPowers };
}

async function loadGameRow(gameId: string) {
  const [row] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!row) throw new Error(`Game ${gameId} not found`);
  return row;
}

async function loadPlayerMap(gameId: string): Promise<Map<string, string>> {
  const players = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const map = new Map<string, string>();
  for (const p of players) {
    if (p.userId) map.set(p.power, p.userId);
  }
  return map;
}

async function getNextSeq(gameId: string): Promise<number> {
  const [row] = await db.select({ maxSeq: sql<number>`COALESCE(MAX(seq), -1)` })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId));
  return (row?.maxSeq ?? -1) + 1;
}

async function saveGame(gameId: string, state: GameState, newEvents: GameEvent[]): Promise<number> {
  let nextSeq = 0;
  if (newEvents.length > 0) {
    nextSeq = await getNextSeq(gameId);
    let seq = nextSeq;
    await db.insert(gameEvents).values(
      newEvents.map((event) => ({
        gameId,
        seq: seq++,
        event: event as unknown as Record<string, unknown>,
      })),
    );
    nextSeq = seq;
  }

  // Update game state
  await db
    .update(games)
    .set({
      state: state as unknown as Record<string, unknown>,
      round: state.round,
      phase: state.phase,
      isComplete: state.winners !== null,
      status: state.winners !== null ? 'complete' : 'active',
      updatedAt: new Date(),
    })
    .where(eq(games.id, gameId));
  return nextSeq;
}

/**
 * Run MCTS in a worker thread so the event loop stays free during search.
 */
function runMctsInWorker(state: GameState, power: Power): Promise<Action> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(`../workers/mctsWorker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url),
      { workerData: { state, power }, execArgv: process.execArgv },
    );
    worker.once('message', ({ ok, action, error }: { ok: boolean; action: Action; error: string }) => {
      if (ok) resolve(action);
      else reject(new Error(error));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`MCTS worker exited with code ${code}`));
    });
  });
}

/**
 * Run AI turns sequentially until a human must act. Saves and broadcasts
 * state + log after each move so clients see AI actions in real time.
 */
async function maybeRunAiTurns(gameId: string, state: GameState): Promise<GameState> {
  let current = state;

  while (current.winners === null && current.pendingAction !== null) {
    const { waitingFor } = current.pendingAction;
    if (current.powers[waitingFor]?.playerType !== 'ai') break;

    let action: Action;
    try {
      if (current.pendingAction!.actionKind === 'summoning_action') {
        action = await runMctsInWorker(current, waitingFor);
      } else {
        action = greedyAction(current, waitingFor);
      }
    } catch (err) {
      console.error(`AI failed to pick action for ${waitingFor}:`, err);
      // Last resort: use first legal action
      const fallback = getLegalActions(current, waitingFor)[0];
      if (!fallback) break;
      action = fallback;
    }

    const prevRound = current.round;
    const { state: next, log } = applyActionWithBattleBroadcast(gameId, current, action);
    const aiSeq = await saveGame(gameId, next, log.events);
    if (log.events.length > 0) broadcastEvents(gameId, log.events, aiSeq);
    // Sync full state at round boundaries only
    if (next.round !== prevRound) broadcast(gameId, { type: 'sync', state: next });
    current = next;
  }

  return current;
}

/**
 * Apply an action, broadcasting the intermediate state at the start of
 * the battle phase so clients can snapshot it before battle resolution.
 */
function applyActionWithBattleBroadcast(
  gameId: string,
  state: GameState,
  action: Action,
): { state: GameState; log: GameLog } {
  const preResult = applyActionForPreview(state, action);
  // If this action transitioned us from summoning into battle, broadcast
  // the clean post-summoning state so clients can snapshot it for animation.
  if (state.phase === 'summoning' && preResult.state.phase === 'battle') {
    broadcast(gameId, { type: 'state', state: preResult.state });
  }
  return autoAdvance(preResult);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createGame(
  createdBy: string,
  powers: Power[],
  playerTypes: Record<Power, PlayerType>,
  playerUserIds: Partial<Record<Power, string>>,
): Promise<string> {
  const gameId = uuidv4();
  const seed = Math.floor(Math.random() * 2 ** 31);

  const initialState = createInitialState({ gameId, activePowers: powers, playerTypes, seed });
  const { state, log } = autoAdvance({ state: initialState, log: new GameLog() });

  await db.insert(games).values({
    id: gameId,
    state: state as unknown as Record<string, unknown>,
    round: state.round,
    phase: state.phase,
    createdBy,
    isComplete: state.winners !== null,
  });

  // Persist initial events
  if (log.events.length > 0) {
    let seq = 0;
    await db.insert(gameEvents).values(
      log.events.map((event) => ({
        gameId,
        seq: seq++,
        event: event as unknown as Record<string, unknown>,
      })),
    );
  }

  for (const power of powers) {
    await db.insert(gamePlayers).values({
      gameId,
      power,
      userId: playerUserIds[power] ?? null,
      playerType: playerTypes[power] ?? 'ai',
      guestEmail: null,
    });
  }

  await maybeRunAiTurns(gameId, state);
  return gameId;
}

export async function getGame(gameId: string): Promise<GameState> {
  const row = await loadGameRow(gameId);
  return row.state as unknown as GameState;
}

export async function applyPlayerAction(
  gameId: string,
  power: Power,
  action: Action,
): Promise<{ state: GameState; seq: number; events: GameEvent[] }> {
  const row = await loadGameRow(gameId);
  const state = row.state as unknown as GameState;

  if (state.winners !== null) throw new Error('Game is already complete');

  const prevRound = state.round;
  const { state: afterAction, log } = applyActionWithBattleBroadcast(gameId, state, action);

  const seq = await saveGame(gameId, afterAction, log.events);
  if (log.events.length > 0) broadcastEvents(gameId, log.events, seq);
  // Sync full state at round boundaries only
  if (afterAction.round !== prevRound) broadcast(gameId, { type: 'sync', state: afterAction });

  // Fire AI turns in the background — don't block the response
  maybeRunAiTurns(gameId, afterAction).catch(err =>
    console.error(`[ai] background AI turns failed for ${gameId}:`, err),
  );

  return { state: afterAction, seq, events: log.events };
}

export async function getGameState(
  gameId: string,
  viewingUserId: string | null,
): Promise<GameState> {
  const [row, playerMap] = await Promise.all([loadGameRow(gameId), loadPlayerMap(gameId)]);
  const state = row.state as unknown as GameState;
  return maskStateForViewer(state, viewingUserId, playerMap);
}

export async function getGameHistory(gameId: string): Promise<{
  events: GameEvent[];
  chat: ChatMessage[];
}> {
  const [eventRows, chat] = await Promise.all([
    db.select({ event: gameEvents.event, seq: gameEvents.seq })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, gameId))
      .orderBy(asc(gameEvents.seq)),
    db.select()
      .from(chatMessages)
      .where(eq(chatMessages.gameId, gameId))
      .orderBy(asc(chatMessages.createdAt)),
  ]);

  return {
    events: eventRows.map(r => r.event as unknown as GameEvent),
    chat: chat.map((m) => ({
      id: m.id,
      power: m.power,
      username: m.username,
      message: m.message,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function postChat(
  gameId: string,
  userId: string,
  username: string,
  power: string | null,
  message: string,
): Promise<ChatMessage> {
  const [row] = await db
    .insert(chatMessages)
    .values({ gameId, power, username, message })
    .returning();

  const msg: ChatMessage = {
    id: row!.id,
    power,
    username,
    message,
    createdAt: row!.createdAt.toISOString(),
  };

  broadcast(gameId, { type: 'chat', message: msg });
  return msg;
}

export interface GameListEntry {
  id: string;
  round: number;
  phase: string;
  isComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
  powers: Array<{ power: string; playerType: string; userId: string | null }>;
  name: string | null;
  status: string;
}

export async function listGamesForUser(userId: string): Promise<GameListEntry[]> {
  // Active/complete games (from game_players)
  const playerRows = await db
    .select()
    .from(gamePlayers)
    .where(eq(gamePlayers.userId, userId));

  // Pending games (from lobby_players)
  const lobbyRows = await db
    .select()
    .from(lobbyPlayers)
    .where(eq(lobbyPlayers.userId, userId));

  const gameIds = [...new Set([
    ...playerRows.map((r) => r.gameId),
    ...lobbyRows.map((r) => r.gameId),
  ])];
  if (gameIds.length === 0) return [];

  const result: GameListEntry[] = [];
  for (const gameId of gameIds) {
    const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
    if (!gameRow) continue;
    const allPlayers = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
    result.push({
      id: gameRow.id,
      round: gameRow.round,
      phase: gameRow.phase,
      isComplete: gameRow.isComplete,
      createdAt: gameRow.createdAt,
      updatedAt: gameRow.updatedAt,
      powers: allPlayers.map((p) => ({ power: p.power, playerType: p.playerType, userId: p.userId ?? null })),
      name: gameRow.name ?? null,
      status: gameRow.status,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

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

export async function createMultiplayerGame(
  createdBy: string,
  name: string,
  isPublic: boolean,
): Promise<string> {
  // Enforce 1 pending game per user
  const [existing] = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.createdBy, createdBy), eq(games.status, 'pending')))
    .limit(1);
  if (existing) throw new Error('You already have a pending game. Start or cancel it first.');

  const gameId = uuidv4();
  await db.insert(games).values({
    id: gameId,
    state: {} as unknown as Record<string, unknown>,
    round: 0,
    phase: 'lobby',
    createdBy,
    isComplete: false,
    name,
    status: 'pending',
    isPublic,
  });

  await db.insert(lobbyPlayers).values({
    gameId,
    userId: createdBy,
    isCreator: true,
  });

  return gameId;
}

export async function getLobbyState(gameId: string, viewerId: string): Promise<LobbyState> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow) throw new Error('Game not found');
  if (gameRow.status !== 'pending') throw new Error('Game is not in lobby');

  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  const userIds = players.map(p => p.userId);
  const userRows = userIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
    : [];
  const usernameById = new Map(userRows.map(u => [u.id, u.username]));

  const isCreator = gameRow.createdBy === viewerId;
  const invitationRows = isCreator
    ? await db.select().from(invitations).where(eq(invitations.gameId, gameId))
    : [];

  return {
    game: {
      id: gameRow.id,
      name: gameRow.name ?? null,
      isPublic: gameRow.isPublic,
      status: gameRow.status,
      createdBy: gameRow.createdBy,
    },
    players: players.map(p => ({
      userId: p.userId,
      username: usernameById.get(p.userId) ?? 'Unknown',
      power: p.power,
      isCreator: p.isCreator,
    })),
    invitations: invitationRows.map(i => ({
      id: i.id,
      email: i.email,
      status: i.invitationStatus,
      createdAt: i.createdAt.toISOString(),
    })),
  };
}

export async function lobbyInvite(gameId: string, creatorId: string, email: string): Promise<string> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can invite');

  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  if (players.length >= 4) throw new Error('Lobby is full (4 players max)');

  const [inv] = await db.insert(invitations).values({
    gameId,
    email,
    power: '',  // not assigned at invite time
    invitationStatus: 'pending',
  }).returning();

  broadcastLobbyUpdate(gameId);
  return inv!.id;
}

export async function lobbyJoin(gameId: string, userId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');

  // Check not already in lobby
  const [already] = await db.select().from(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)))
    .limit(1);
  if (already) throw new Error('Already in lobby');

  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  if (players.length >= 4) throw new Error('Lobby is full');

  await db.insert(lobbyPlayers).values({ gameId, userId, isCreator: false });

  // Mark invitation as accepted if one exists for this user's email
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.email) {
    await db.update(invitations)
      .set({ invitationStatus: 'accepted' })
      .where(and(eq(invitations.gameId, gameId), eq(invitations.email, user.email), eq(invitations.invitationStatus, 'pending')));
  }

  // If lobby is now full, revoke remaining pending invitations
  const updatedPlayers = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  if (updatedPlayers.length >= 4) {
    await db.update(invitations)
      .set({ invitationStatus: 'revoked' })
      .where(and(eq(invitations.gameId, gameId), eq(invitations.invitationStatus, 'pending')));
  }

  broadcastLobbyUpdate(gameId);
}

export async function lobbyLeave(gameId: string, userId: string): Promise<void> {
  const [player] = await db.select().from(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)))
    .limit(1);
  if (!player) throw new Error('Not in lobby');
  if (player.isCreator) throw new Error('Creator cannot leave. Cancel the game instead.');

  await db.delete(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)));

  broadcastLobbyUpdate(gameId);
}

export async function lobbyKick(gameId: string, creatorId: string, targetUserId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can kick');
  if (targetUserId === creatorId) throw new Error('Cannot kick yourself');

  await db.delete(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, targetUserId)));

  broadcastLobbyUpdate(gameId);
}

export async function lobbyAssign(
  gameId: string,
  creatorId: string,
  assignments: Array<{ power: Power; type: 'human' | 'ai' | 'none'; userId?: string }>,
): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can assign');

  // Clear all power assignments first
  await db.update(lobbyPlayers)
    .set({ power: null })
    .where(eq(lobbyPlayers.gameId, gameId));

  // Set new assignments
  for (const a of assignments) {
    if (a.type === 'human' && a.userId) {
      await db.update(lobbyPlayers)
        .set({ power: a.power })
        .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, a.userId)));
    }
  }

  broadcastLobbyUpdate(gameId);
}

export async function lobbyStart(gameId: string, creatorId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can start');

  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));

  // The caller passes assignments via lobbyAssign first — read them from lobby_players + infer AI.
  // We need the full assignment map. Read it from the request context or reconstruct:
  // Players with power != null are human. Remaining powers are AI (passed via a prior assign call).
  // For now, we require lobbyAssign to have been called, and we read the state.

  // Actually we need the full picture. Let's accept assignments in the start call body too.
  // But the plan says "creator calls assign then start". Let's keep it simple:
  // lobbyStart receives the final power config.

  throw new Error('Use startMultiplayerGame instead');
}

export async function startMultiplayerGame(
  gameId: string,
  creatorId: string,
  powerConfig: Array<{ power: Power; type: 'human' | 'ai' | 'none'; userId?: string }>,
): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can start');

  const activePowers = powerConfig.filter(p => p.type !== 'none').map(p => p.power);
  if (activePowers.length < 2) throw new Error('Need at least 2 active powers');

  const playerTypes: Record<Power, PlayerType> = {} as Record<Power, PlayerType>;
  const playerUserIds: Partial<Record<Power, string>> = {};
  for (const p of powerConfig) {
    playerTypes[p.power] = p.type === 'human' ? 'human' : 'ai';
    if (p.type === 'human' && p.userId) playerUserIds[p.power] = p.userId;
  }

  const seed = Math.floor(Math.random() * 2 ** 31);
  const initialState = createInitialState({ gameId, activePowers, playerTypes, seed });
  const { state, log } = autoAdvance({ state: initialState, log: new GameLog() });

  // Update game row
  await db.update(games).set({
    state: state as unknown as Record<string, unknown>,
    round: state.round,
    phase: state.phase,
    status: 'active',
    isComplete: state.winners !== null,
    updatedAt: new Date(),
  }).where(eq(games.id, gameId));

  // Persist initial events
  if (log.events.length > 0) {
    let seq = 0;
    await db.insert(gameEvents).values(
      log.events.map((event) => ({
        gameId,
        seq: seq++,
        event: event as unknown as Record<string, unknown>,
      })),
    );
  }

  // Populate game_players
  for (const p of powerConfig) {
    if (p.type === 'none') continue;
    await db.insert(gamePlayers).values({
      gameId,
      power: p.power,
      userId: p.userId ?? null,
      playerType: p.type,
    });
  }

  // Broadcast game started to lobby SSE listeners
  broadcast(gameId, { type: 'game_started' });

  await maybeRunAiTurns(gameId, state);
}

export async function revokeInvitation(gameId: string, creatorId: string, invitationId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.createdBy !== creatorId) throw new Error('Not authorized');

  await db.update(invitations)
    .set({ invitationStatus: 'revoked' })
    .where(and(eq(invitations.id, invitationId), eq(invitations.gameId, gameId)));

  broadcastLobbyUpdate(gameId);
}

async function broadcastLobbyUpdate(gameId: string): Promise<void> {
  // Load current lobby state and broadcast to all listeners
  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  const userIds = players.map(p => p.userId);
  const userRows = userIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
    : [];
  const usernameById = new Map(userRows.map(u => [u.id, u.username]));

  const invitationRows = await db.select().from(invitations).where(eq(invitations.gameId, gameId));

  broadcast(gameId, {
    type: 'lobby_update',
    players: players.map(p => ({
      userId: p.userId,
      username: usernameById.get(p.userId) ?? 'Unknown',
      power: p.power,
      isCreator: p.isCreator,
    })),
    invitations: invitationRows.map(i => ({
      id: i.id,
      email: i.email,
      status: i.invitationStatus,
      createdAt: i.createdAt.toISOString(),
    })),
  });
}

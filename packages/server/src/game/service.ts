import { Worker } from 'node:worker_threads';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createInitialState, applyAction, applyActionForPreview, autoAdvance, getLegalActions, enumerateBattleHitStrategies, GameLog, maskEvents } from '@ruin/engine';
import type { GameState, Power, Action, PlayerType, GameEvent } from '@ruin/engine';
import { greedyAction } from '@ruin/ai';
import { db } from '../db/client.js';
import { games, gamePlayers, chatMessages, gameEvents, lobbyPlayers, invitations, users } from '../db/schema.js';
import { broadcast, broadcastEvents } from './sse.js';
import { broadcastGamesUpdate, notifyInvited } from '../lobby/service.js';
import { isOnline } from '../lobby/sse.js';
import { sendEmail } from '../email/index.js';
import { gameInviteEmail } from '../email/templates/gameInvite.js';

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

// AI slot shape stored in games.ai_slots.
// - locked=true: creator explicitly set this (to a power, or Off=null).
//   Joiners cannot steal; auto-fill leaves it alone.
// - locked=false: auto-filled with whatever powers aren't otherwise claimed.
//   Joiners can "steal" by self-picking that power.
export interface AiSlot { power: string | null; locked: boolean }

const ALL_POWERS_LIST: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

function normalizeAiSlots(raw: unknown): AiSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    if (x === null || typeof x === 'string') return { power: (x as string | null) ?? null, locked: true };
    if (typeof x === 'object' && x !== null && 'power' in (x as object)) {
      const obj = x as { power?: string | null; locked?: boolean };
      return { power: obj.power ?? null, locked: !!obj.locked };
    }
    return { power: null, locked: false };
  });
}

/** After any assignment change, refill unlocked AI slots with unclaimed powers
 *  in canonical order. Returns the new slot list (length = expectedCount). */
function autoFillAiSlots(
  humanPowers: Array<string | null>,
  slots: AiSlot[],
  expectedCount: number,
): AiSlot[] {
  const result: AiSlot[] = slots.slice(0, expectedCount);
  while (result.length < expectedCount) result.push({ power: null, locked: false });

  const claimed = new Set<string>();
  for (const p of humanPowers) if (p) claimed.add(p);
  for (const s of result) if (s.locked && s.power) claimed.add(s.power);

  const available = ALL_POWERS_LIST.filter((p) => !claimed.has(p));
  let ai = 0;
  for (let i = 0; i < result.length; i++) {
    if (!result[i]!.locked) {
      result[i] = { power: available[ai] ?? null, locked: false };
      ai++;
    }
  }
  return result;
}

async function recomputeAiSlots(gameId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow) return;
  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  const slots = normalizeAiSlots(gameRow.aiSlots);
  const expected = Math.max(0, 4 - players.length);
  const next = autoFillAiSlots(players.map((p) => p.power), slots, expected);
  await db.update(games).set({ aiSlots: next }).where(eq(games.id, gameId));
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

async function loadGameWithSeq(gameId: string): Promise<{ state: GameState; seq: number }> {
  // Load state and next-seq atomically. Promise.all would race: the state
  // query could be dispatched before a concurrent commit while the seq query
  // is dispatched after, pairing stale state with a fresh seq — that combo
  // passes the CAS check and silently overwrites committed state.
  // A repeatable-read transaction pins both reads to the same snapshot.
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(games).where(eq(games.id, gameId)).limit(1);
    if (!row) throw new Error(`Game ${gameId} not found`);
    const [seqRow] = await tx.select({ maxSeq: sql<number>`COALESCE(MAX(${gameEvents.seq}), -1)` })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, gameId));
    const seq = Number(seqRow?.maxSeq ?? -1) + 1;
    return { state: row.state as unknown as GameState, seq };
  }, { isolationLevel: 'repeatable read' });
}

async function loadPlayerMap(gameId: string): Promise<Map<string, string>> {
  const players = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const map = new Map<string, string>();
  for (const p of players) {
    if (p.userId) map.set(p.power, p.userId);
  }
  return map;
}

/**
 * Save game state + events in a transaction with optimistic concurrency.
 * Verifies that the DB event seq matches `expectedSeq` before writing.
 * Returns the new seq after the inserted events.
 */
async function saveGame(
  gameId: string,
  state: GameState,
  newEvents: GameEvent[],
  expectedSeq: number,
): Promise<number> {
  return db.transaction(async (tx) => {
    // Verify no concurrent writes changed the event log
    const [row] = await tx.select({ maxSeq: sql<number>`COALESCE(MAX(seq), -1)` })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, gameId));
    const currentSeq = (row?.maxSeq ?? -1) + 1;
    if (currentSeq !== expectedSeq) {
      throw new Error(`Concurrency conflict: expected seq ${expectedSeq}, DB has ${currentSeq}`);
    }

    let nextSeq = expectedSeq;
    if (newEvents.length > 0) {
      let seq = nextSeq;
      await tx.insert(gameEvents).values(
        newEvents.map((event) => ({
          gameId,
          seq: seq++,
          event: event as unknown as Record<string, unknown>,
        })),
      );
      nextSeq = seq;
    }

    await tx
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
  });
}

/** Get the next event seq for a game (reads from DB). */
async function getNextSeq(gameId: string): Promise<number> {
  const [row] = await db.select({ maxSeq: sql<number>`COALESCE(MAX(seq), -1)` })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId));
  return (row?.maxSeq ?? -1) + 1;
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
async function maybeRunAiTurns(gameId: string, state: GameState, currentSeq: number): Promise<GameState> {
  let current = state;
  let seq = currentSeq;

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
      // Last resort: pick the first action from a cheap enumeration
      const fallback = current.pendingAction!.actionKind === 'battle_hit_assignment'
        ? enumerateBattleHitStrategies(current, waitingFor)[0]
        : getLegalActions(current, waitingFor)[0];
      if (!fallback) break;
      action = fallback;
    }

    const prevRound = current.round;
    const { state: next, log } = applyAction(current, action);
    seq = await saveGame(gameId, next, log.events, seq);
    if (log.events.length > 0) broadcastEvents(gameId, log.events, seq);
    // Sync full state at round boundaries only
    if (next.round !== prevRound) broadcast(gameId, { type: 'sync', state: next });
    current = next;
  }

  return current;
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
  let initialSeq = 0;
  if (log.events.length > 0) {
    let seq = 0;
    await db.insert(gameEvents).values(
      log.events.map((event) => ({
        gameId,
        seq: seq++,
        event: event as unknown as Record<string, unknown>,
      })),
    );
    initialSeq = seq;
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

  await maybeRunAiTurns(gameId, state, initialSeq);
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
  return applyPlayerActions(gameId, power, [action]);
}

/**
 * Apply a batch of actions from the same player in one transactional save.
 * Used for multi-pick dial rewards: the client collects all picks and submits
 * them together so they commit atomically. The batch can also be partial —
 * the engine's next awaiting_action reflects the reduced remaining count, so
 * the client is always told what's still owed.
 */
export async function applyPlayerActions(
  gameId: string,
  power: Power,
  actions: Action[],
): Promise<{ state: GameState; seq: number; events: GameEvent[] }> {
  if (actions.length === 0) throw new Error('No actions provided');
  const { state, seq: loadedSeq } = await loadGameWithSeq(gameId);
  if (state.winners !== null) throw new Error('Game is already complete');

  let s = state;
  const allEvents: GameEvent[] = [];
  for (const action of actions) {
    if (action.power !== power) throw new Error(`Action power mismatch: ${action.power} vs ${power}`);
    // applyAction includes autoAdvance, which drains the next dial reward pick
    // into pendingAction (and emits its awaiting_action) before the next batch
    // entry applies.
    const result = applyAction(s, action);
    s = result.state;
    allEvents.push(...result.log.events);
  }

  const seq = await saveGame(gameId, s, allEvents, loadedSeq);
  if (allEvents.length > 0) broadcastEvents(gameId, allEvents, seq);

  // If the last autoAdvance left a non-player pending (AI turn, autonomous
  // phase), continue in background so the batch response is still fast.
  continueInBackground(gameId, s, seq);

  return { state: s, seq, events: allEvents };
}

/**
 * Run autoAdvance + AI turns in the background. Saves and broadcasts
 * after each step so clients see progress in real time via SSE.
 */
async function continueInBackground(gameId: string, state: GameState, currentSeq: number): Promise<void> {
  try {
    // autoAdvance runs autonomous phases (battle resolution, corruption, end, world, draw)
    if (state.pendingAction === null && state.winners === null) {
      const { state: advanced, log } = autoAdvance({ state, log: new GameLog() });
      if (log.events.length > 0) {
        const prevRound = state.round;
        currentSeq = await saveGame(gameId, advanced, log.events, currentSeq);
        broadcastEvents(gameId, log.events, currentSeq);
        if (advanced.round !== prevRound) broadcast(gameId, { type: 'sync', state: advanced });
      }
      state = advanced;
    }

    // Then run AI turns
    await maybeRunAiTurns(gameId, state, currentSeq);
  } catch (err) {
    console.error(`[bg] background advance failed for ${gameId}:`, err);
  }
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
  powers: Array<{ power: string; playerType: string; userId: string | null; username: string | null }>;
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
    const humanIds = allPlayers.map((p) => p.userId).filter((u): u is string => !!u);
    const userRows = humanIds.length
      ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, humanIds))
      : [];
    const usernameById = new Map(userRows.map((u) => [u.id, u.username]));
    result.push({
      id: gameRow.id,
      round: gameRow.round,
      phase: gameRow.phase,
      isComplete: gameRow.isComplete,
      createdAt: gameRow.createdAt,
      updatedAt: gameRow.updatedAt,
      powers: allPlayers.map((p) => ({
        power: p.power,
        playerType: p.playerType,
        userId: p.userId ?? null,
        username: p.userId ? (usernameById.get(p.userId) ?? null) : null,
      })),
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
  locked: boolean;
  isCreator: boolean;
}

export interface LobbyInvitation {
  id: string;
  label: string;
  status: string;
  createdAt: string;
}

export interface LobbyState {
  game: { id: string; name: string | null; isPublic: boolean; status: string; createdBy: string };
  players: LobbyPlayer[];
  invitations: LobbyInvitation[];
  aiSlots: AiSlot[];
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

  await recomputeAiSlots(gameId);
  void broadcastGamesUpdate();
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
      locked: p.locked,
      isCreator: p.isCreator,
    })),
    invitations: invitationRows.map(i => ({
      id: i.id,
      label: i.username ?? '',
      status: i.invitationStatus,
      createdAt: i.createdAt.toISOString(),
    })),
    aiSlots: normalizeAiSlots(gameRow.aiSlots),
  };
}

export async function lobbyInvite(gameId: string, creatorId: string, username: string): Promise<string> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can invite');

  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  if (players.length >= 4) throw new Error('Lobby is full (4 players max)');

  const [invitedUser] = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!invitedUser) throw new Error(`No user named "${username}"`);

  const [inv] = await db.insert(invitations).values({
    gameId,
    username: invitedUser.username,
    power: '',  // not assigned at invite time
    invitationStatus: 'pending',
  }).returning();

  broadcastLobbyUpdate(gameId);

  if (isOnline(invitedUser.id)) {
    notifyInvited(invitedUser.id, gameId);
  } else if (invitedUser.email) {
    const [host] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, creatorId))
      .limit(1);
    await sendEmail({
      to: invitedUser.email,
      subject: 'You have been invited to play Ruin',
      html: gameInviteEmail(gameId, gameRow.name, host?.username ?? 'A player'),
    });
  }
  void broadcastGamesUpdate();
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

  // Mark any matching pending invitation (by username) as accepted
  const [user] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
  if (user) {
    await db.update(invitations)
      .set({ invitationStatus: 'accepted' })
      .where(and(
        eq(invitations.gameId, gameId),
        eq(invitations.invitationStatus, 'pending'),
        eq(invitations.username, user.username),
      ));
  }

  // If lobby is now full, revoke remaining pending invitations
  const updatedPlayers = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  if (updatedPlayers.length >= 4) {
    await db.update(invitations)
      .set({ invitationStatus: 'revoked' })
      .where(and(eq(invitations.gameId, gameId), eq(invitations.invitationStatus, 'pending')));
  }

  await recomputeAiSlots(gameId);
  broadcastLobbyUpdate(gameId);
  void broadcastGamesUpdate();
}

export async function lobbyLeave(gameId: string, userId: string): Promise<void> {
  const [player] = await db.select().from(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)))
    .limit(1);
  if (!player) throw new Error('Not in lobby');
  if (player.isCreator) throw new Error('Creator cannot leave. Cancel the game instead.');

  await db.delete(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)));

  await recomputeAiSlots(gameId);
  broadcastLobbyUpdate(gameId);
  void broadcastGamesUpdate();
}

export async function lobbyKick(gameId: string, creatorId: string, targetUserId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can kick');
  if (targetUserId === creatorId) throw new Error('Cannot kick yourself');

  await db.delete(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, targetUserId)));

  await recomputeAiSlots(gameId);
  broadcastLobbyUpdate(gameId);
  void broadcastGamesUpdate();
}

/** Creator assigns a single human's power (null = clear and unlock).
 *  If another human holds that power, swap with them. AI slots are left to
 *  auto-fill afterwards. */
export async function lobbyAssignPlayer(
  gameId: string,
  creatorId: string,
  targetUserId: string,
  power: Power | null,
): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can assign');

  const [target] = await db.select().from(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, targetUserId)))
    .limit(1);
  if (!target) throw new Error('Target user is not in the lobby');

  const prevPower = target.power;

  if (power !== null) {
    // If another human holds this power, swap them onto the target's prev.
    // Locked AI slots get reshuffled by auto-fill afterwards (creator is
    // explicitly overriding, so unlocking would be surprising — instead we
    // just let auto-fill re-balance unlocked slots around the new claim).
    const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
    const otherHuman = players.find((p) => p.userId !== targetUserId && p.power === power);
    if (otherHuman) {
      await db.update(lobbyPlayers)
        .set({ power: prevPower })
        .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, otherHuman.userId)));
    } else {
      // If a LOCKED AI slot holds this power, the creator is overriding it:
      // unlock the slot and let auto-fill re-distribute.
      const slots = normalizeAiSlots(gameRow.aiSlots);
      const lockedAi = slots.findIndex((s) => s.locked && s.power === power);
      if (lockedAi !== -1) {
        slots[lockedAi] = { power: null, locked: false };
        await db.update(games).set({ aiSlots: slots }).where(eq(games.id, gameId));
      }
    }
  }

  await db.update(lobbyPlayers)
    .set({ power, locked: power !== null })
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, targetUserId)));

  await recomputeAiSlots(gameId);
  broadcastLobbyUpdate(gameId);
}

/** Creator assigns an AI slot. Any click LOCKS the slot to the chosen value.
 *  Clicking the slot's current locked value again UNLOCKS it (back to
 *  auto-fill). Null = locked to Off. */
export async function lobbyAssignAiSlot(
  gameId: string,
  creatorId: string,
  aiIndex: number,
  power: Power | null,
): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can assign');

  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  const expectedAiCount = Math.max(0, 4 - players.length);
  if (aiIndex < 0 || aiIndex >= expectedAiCount) {
    throw new Error(`AI slot index out of range (0..${expectedAiCount - 1})`);
  }

  const slots = normalizeAiSlots(gameRow.aiSlots);
  while (slots.length < expectedAiCount) slots.push({ power: null, locked: false });
  slots.length = expectedAiCount;

  const prev = slots[aiIndex]!;
  // Toggle-off: clicking the same locked value again unlocks it.
  if (prev.locked && prev.power === power) {
    slots[aiIndex] = { power: null, locked: false };
  } else {
    if (power !== null) {
      // Steal from whoever holds it. Humans keep their locked flag but move
      // off to prev.power; other AI slots (locked or not) go to prev.power.
      const humanHolder = players.find((p) => p.power === power);
      if (humanHolder) {
        await db.update(lobbyPlayers)
          .set({ power: prev.power })
          .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, humanHolder.userId)));
      } else {
        const otherAi = slots.findIndex((s, i) => i !== aiIndex && s.power === power);
        if (otherAi !== -1) {
          slots[otherAi] = { ...slots[otherAi]!, power: prev.power };
        }
      }
    }
    slots[aiIndex] = { power, locked: true };
  }

  await db.update(games).set({ aiSlots: slots }).where(eq(games.id, gameId));
  await recomputeAiSlots(gameId);
  broadcastLobbyUpdate(gameId);
}

/** Joiner picks their own power. Rejected if creator has already locked them. */
export async function lobbyPickPower(
  gameId: string,
  userId: string,
  power: Power | null,
): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');

  const [me] = await db.select().from(lobbyPlayers)
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)))
    .limit(1);
  if (!me) throw new Error('Not in lobby');
  if (me.locked) throw new Error('The creator has assigned your power — you cannot change it');

  // Reject only if a LOCKED slot (human or AI) already holds this power.
  // Unlocked AI slots will give way via auto-fill.
  if (power !== null) {
    const allPlayers = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
    const humanHolder = allPlayers.find((p) => p.userId !== userId && p.power === power);
    if (humanHolder) throw new Error('That power is already taken');
    const slots = normalizeAiSlots(gameRow.aiSlots);
    if (slots.some((s) => s.locked && s.power === power)) {
      throw new Error('That power is locked to an AI slot by the host');
    }
  }

  await db.update(lobbyPlayers)
    .set({ power })
    .where(and(eq(lobbyPlayers.gameId, gameId), eq(lobbyPlayers.userId, userId)));

  await recomputeAiSlots(gameId);
  broadcastLobbyUpdate(gameId);
}

export async function startMultiplayerGame(
  gameId: string,
  creatorId: string,
): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.status !== 'pending') throw new Error('Game not in lobby');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can start');

  // Build powerConfig from current lobby state
  const players = await db.select().from(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  const aiSlots = normalizeAiSlots(gameRow.aiSlots);

  // Every human in the lobby must have a power assigned before starting
  const missing = players.filter((p) => !p.power);
  if (missing.length > 0) {
    throw new Error('All players must have a power assigned before starting');
  }

  const powerConfig: Array<{ power: Power; type: 'human' | 'ai' | 'none'; userId?: string }> = [];
  for (const p of players) {
    powerConfig.push({ power: p.power as Power, type: 'human', userId: p.userId });
  }
  for (const slot of aiSlots) {
    if (slot.power) powerConfig.push({ power: slot.power as Power, type: 'ai' });
  }

  const activePowers = powerConfig.map((p) => p.power);
  if (activePowers.length < 2) throw new Error('Need at least 2 active powers');
  if (new Set(activePowers).size !== activePowers.length) {
    throw new Error('Duplicate power assignment — check player and AI slot picks');
  }

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
  let initialSeq = 0;
  if (log.events.length > 0) {
    let seq = 0;
    await db.insert(gameEvents).values(
      log.events.map((event) => ({
        gameId,
        seq: seq++,
        event: event as unknown as Record<string, unknown>,
      })),
    );
    initialSeq = seq;
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

  // Broadcast game started to per-game SSE listeners
  broadcast(gameId, { type: 'game_started' });
  // Game leaves the public lobby pool
  void broadcastGamesUpdate();

  await maybeRunAiTurns(gameId, state, initialSeq);
}

/** A player leaves an in-progress game. Their power is taken over by AI. If
 *  they were the last human, the game is deleted entirely. Returns true when
 *  the game was deleted. */
export async function leaveActiveGame(gameId: string, userId: string): Promise<{ deleted: boolean }> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow) throw new Error('Game not found');
  if (gameRow.status === 'pending') throw new Error('Game is still in lobby — use the lobby Leave');

  const players = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const myRow = players.find((p) => p.userId === userId);
  if (!myRow) throw new Error('You are not a player in this game');

  const remainingHumans = players.filter((p) => p.userId && p.userId !== userId && p.playerType === 'human');

  if (remainingHumans.length === 0) {
    // Last human — delete the game and all related rows.
    await db.delete(chatMessages).where(eq(chatMessages.gameId, gameId));
    await db.delete(gameEvents).where(eq(gameEvents.gameId, gameId));
    await db.delete(gamePlayers).where(eq(gamePlayers.gameId, gameId));
    await db.delete(invitations).where(eq(invitations.gameId, gameId));
    await db.delete(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
    await db.delete(games).where(eq(games.id, gameId));
    broadcast(gameId, { type: 'game_deleted' });
    return { deleted: true };
  }

  // Convert the leaver's row to AI: detach the user, switch playerType.
  await db
    .update(gamePlayers)
    .set({ userId: null, playerType: 'ai' })
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.power, myRow.power)));

  // Update engine state so the engine runs the power as AI going forward.
  const state = gameRow.state as unknown as GameState;
  const powerKey = myRow.power as Power;
  const nextState: GameState = {
    ...state,
    powers: {
      ...state.powers,
      [powerKey]: { ...state.powers[powerKey]!, playerType: 'ai' },
    },
  };
  await db.update(games)
    .set({ state: nextState as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(games.id, gameId));

  // Clients need the fresh state + playerType. A sync event is the simplest.
  broadcast(gameId, { type: 'sync', state: nextState });

  // If the AI is now on the clock, drive their turns.
  const seq = await getNextSeq(gameId);
  await maybeRunAiTurns(gameId, nextState, seq);
  return { deleted: false };
}

export async function cancelMultiplayerGame(gameId: string, creatorId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow) throw new Error('Game not found');
  if (gameRow.status !== 'pending') throw new Error('Only pending games can be cancelled');
  if (gameRow.createdBy !== creatorId) throw new Error('Only the creator can cancel');

  // Notify per-game listeners (joiners) before we delete the game so their
  // client's kick-detection effect can navigate them away. We broadcast an
  // empty lobby roster, which the UI interprets as "you were removed".
  broadcast(gameId, { type: 'lobby_update', players: [], invitations: [] });

  // Delete child rows first to satisfy FKs. Pending games have no
  // game_players or game_events, so we only need chat_messages, invitations,
  // and lobby_players.
  await db.delete(chatMessages).where(eq(chatMessages.gameId, gameId));
  await db.delete(invitations).where(eq(invitations.gameId, gameId));
  await db.delete(lobbyPlayers).where(eq(lobbyPlayers.gameId, gameId));
  await db.delete(games).where(eq(games.id, gameId));

  void broadcastGamesUpdate();
}

export async function revokeInvitation(gameId: string, creatorId: string, invitationId: string): Promise<void> {
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!gameRow || gameRow.createdBy !== creatorId) throw new Error('Not authorized');

  await db.update(invitations)
    .set({ invitationStatus: 'revoked' })
    .where(and(eq(invitations.id, invitationId), eq(invitations.gameId, gameId)));

  broadcastLobbyUpdate(gameId);
  void broadcastGamesUpdate();
}

async function broadcastLobbyUpdate(gameId: string): Promise<void> {
  // Load current lobby state and broadcast to all listeners
  const [gameRow] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
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
      locked: p.locked,
      isCreator: p.isCreator,
    })),
    invitations: invitationRows.map(i => ({
      id: i.id,
      label: i.username ?? '',
      status: i.invitationStatus,
      createdAt: i.createdAt.toISOString(),
    })),
    aiSlots: normalizeAiSlots(gameRow?.aiSlots),
  });
}

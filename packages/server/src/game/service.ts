import { Worker } from 'node:worker_threads';
import { eq, asc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createInitialState, applyAction, applyActionForPreview, autoAdvance, getLegalActions, GameLog } from '@ruin/engine';
import type { GameState, Power, Action, PlayerType } from '@ruin/engine';
import { greedyAction } from '@ruin/ai';
import { db } from '../db/client.js';
import { games, gamePlayers, chatMessages } from '../db/schema.js';
import { broadcast } from './sse.js';

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

async function saveGame(gameId: string, state: GameState, extraLog: string[]): Promise<void> {
  // Append new log entries to the persisted event_log
  const [row] = await db.select({ eventLog: games.eventLog }).from(games).where(eq(games.id, gameId)).limit(1);
  const existing = (row?.eventLog as string[] | null) ?? [];
  await db
    .update(games)
    .set({
      state: state as unknown as Record<string, unknown>,
      eventLog: [...existing, ...extraLog] as unknown as Record<string, unknown>,
      round: state.round,
      phase: state.phase,
      isComplete: state.winners !== null,
      updatedAt: new Date(),
    })
    .where(eq(games.id, gameId));
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
    await saveGame(gameId, next, log.entries);
    broadcast(gameId, { type: 'state', state: next });
    if (log.events.length > 0) broadcast(gameId, { type: 'events', events: log.events });
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
    eventLog: log.entries as unknown as Record<string, unknown>,
    round: state.round,
    phase: state.phase,
    createdBy,
    isComplete: state.winners !== null,
  });

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
): Promise<GameState> {
  const row = await loadGameRow(gameId);
  const state = row.state as unknown as GameState;

  if (state.winners !== null) throw new Error('Game is already complete');

  const prevRound = state.round;
  const { state: afterAction, log } = applyActionWithBattleBroadcast(gameId, state, action);

  await saveGame(gameId, afterAction, log.entries);
  broadcast(gameId, { type: 'state', state: afterAction });
  if (log.events.length > 0) broadcast(gameId, { type: 'events', events: log.events });
  if (afterAction.round !== prevRound) broadcast(gameId, { type: 'sync', state: afterAction });

  return maybeRunAiTurns(gameId, afterAction);
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
  eventLog: string[];
  events: unknown[];
  chat: ChatMessage[];
}> {
  const [row, chat] = await Promise.all([
    loadGameRow(gameId),
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.gameId, gameId))
      .orderBy(asc(chatMessages.createdAt)),
  ]);

  // eventLog is currently string[] in the DB. Once migrated to GameEvent[],
  // `events` will carry the structured form directly.
  const rawLog = (row.eventLog as unknown[] | null) ?? [];

  return {
    eventLog: rawLog.map((e) => (typeof e === 'string' ? e : String(e))),
    events: rawLog,
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
}

export async function listGamesForUser(userId: string): Promise<GameListEntry[]> {
  const playerRows = await db
    .select()
    .from(gamePlayers)
    .where(eq(gamePlayers.userId, userId));

  if (playerRows.length === 0) return [];
  const gameIds = [...new Set(playerRows.map((r) => r.gameId))];
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
    });
  }

  return result;
}

import { Worker } from 'node:worker_threads';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createInitialState, applyAction, autoAdvance } from '@ruin/engine';
import type { GameState, Power, Action, PlayerType } from '@ruin/engine';
import { db } from '../db/client.js';
import { games, gamePlayers } from '../db/schema.js';
import { broadcast } from './sse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskStateForViewer(state: GameState, viewingUserId: string | null, playerMap: Map<string, string>): GameState {
  // playerMap: power → userId
  // Replace other players' hands with placeholder arrays of the same length
  const maskedPowers = { ...state.powers };

  for (const power of state.activePowers) {
    const powerUserId = playerMap.get(power) ?? null;
    if (powerUserId === viewingUserId) continue; // this player sees their own hand

    const ps = maskedPowers[power];
    if (!ps) continue;
    maskedPowers[power] = {
      ...ps,
      hand: ps.hand.map(() => '?'),
      deckIds: [], // hide deck contents too
    };
  }

  return { ...state, powers: maskedPowers };
}

async function loadGameRow(gameId: string) {
  const [row] = await db
    .select()
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);

  if (!row) throw new Error(`Game ${gameId} not found`);
  return row;
}

async function loadPlayerMap(gameId: string): Promise<Map<string, string>> {
  const players = await db
    .select()
    .from(gamePlayers)
    .where(eq(gamePlayers.gameId, gameId));

  const map = new Map<string, string>();
  for (const p of players) {
    if (p.userId) map.set(p.power, p.userId);
  }
  return map;
}

/**
 * Run MCTS in a worker thread so the event loop stays free during search.
 * The worker inherits process.execArgv so tsx loaders are active in dev.
 */
function runMctsInWorker(state: GameState, power: Power): Promise<Action> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./workers/mctsWorker.js', import.meta.url),
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
 * If the game is waiting for an AI power, run MCTS and apply its action.
 * Repeats until a human player must act or the game is over.
 * Saves and broadcasts after each AI move so the log is visible in real time.
 */
async function maybeRunAiTurns(gameId: string, state: GameState): Promise<GameState> {
  let current = state;

  while (current.winners === null && current.pendingAction !== null) {
    const { waitingFor } = current.pendingAction;
    if (current.powers[waitingFor]?.playerType !== 'ai') break;

    let action: Action;
    try {
      action = await runMctsInWorker(current, waitingFor);
    } catch (err) {
      console.error(`AI failed to pick action for ${waitingFor}:`, err);
      break;
    }

    const { state: next } = applyAction(current, action);
    await saveGame(gameId, next);
    broadcast(gameId, { type: 'state', state: next });
    current = next;
  }

  return current;
}

async function saveGame(gameId: string, state: GameState): Promise<void> {
  await db
    .update(games)
    .set({
      state: state as unknown as Record<string, unknown>,
      round: state.round,
      phase: state.phase,
      isComplete: state.winners !== null,
      updatedAt: new Date(),
    })
    .where(eq(games.id, gameId));
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

  const initialState = createInitialState({
    gameId,
    activePowers: powers,
    playerTypes,
    seed,
  });

  // Auto-advance any autonomous phases from the initial state
  const { state } = autoAdvance({ state: initialState, log: [] });

  await db.insert(games).values({
    id: gameId,
    state: state as unknown as Record<string, unknown>,
    round: state.round,
    phase: state.phase,
    createdBy,
    isComplete: state.winners !== null,
  });

  // Insert game_players rows
  for (const power of powers) {
    const userId = playerUserIds[power] ?? null;
    await db.insert(gamePlayers).values({
      gameId,
      power,
      userId,
      playerType: playerTypes[power] ?? 'ai',
      guestEmail: null,
    });
  }

  // If the first pending action is for an AI player, run those turns now
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

  if (state.winners !== null) {
    throw new Error('Game is already complete');
  }

  // applyAction validates that the action is from the expected power
  const { state: afterAction } = applyAction(state, action);

  await saveGame(gameId, afterAction);
  broadcast(gameId, { type: 'state', state: afterAction });

  // Run any follow-on AI turns (saves + broadcasts after each one)
  const newState = await maybeRunAiTurns(gameId, afterAction);

  return newState;
}

export async function getGameState(
  gameId: string,
  viewingUserId: string | null,
): Promise<GameState> {
  const [row, playerMap] = await Promise.all([
    loadGameRow(gameId),
    loadPlayerMap(gameId),
  ]);

  const state = row.state as unknown as GameState;
  return maskStateForViewer(state, viewingUserId, playerMap);
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
  // Find all game_players rows for this user
  const playerRows = await db
    .select()
    .from(gamePlayers)
    .where(eq(gamePlayers.userId, userId));

  if (playerRows.length === 0) return [];

  const gameIds = [...new Set(playerRows.map((r) => r.gameId))];

  const result: GameListEntry[] = [];

  for (const gameId of gameIds) {
    const [gameRow] = await db
      .select()
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1);

    if (!gameRow) continue;

    const allPlayers = await db
      .select()
      .from(gamePlayers)
      .where(eq(gamePlayers.gameId, gameId));

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
      })),
    });
  }

  return result;
}

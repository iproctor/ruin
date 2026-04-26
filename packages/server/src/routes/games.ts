import { Router } from 'express';
import { eq, inArray, asc, and, gte } from 'drizzle-orm';
import { z } from 'zod';
import type { Power, PlayerType, Action } from '@ruin/engine';
import { maskEvents } from '@ruin/engine';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  createGame,
  createMultiplayerGame,
  getGameState,
  getLobbyState,
  applyPlayerActions,
  listGamesForUser,
  getGameHistory,
  postChat,
  lobbyInvite,
  lobbyJoin,
  lobbyLeave,
  lobbyKick,
  lobbyAssignPlayer,
  lobbyAssignAiSlot,
  lobbyPickPower,
  startMultiplayerGame,
  revokeInvitation,
  cancelMultiplayerGame,
  leaveActiveGame,
} from '../game/service.js';
import { addListener, removeListener } from '../game/sse.js';
import { db } from '../db/client.js';
import { games, gamePlayers, users, chatMessages, gameEvents } from '../db/schema.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// POST /api/games — create game
// ---------------------------------------------------------------------------
const zPowerEnum = z.enum(['xarm', 'gormen', 'tenzen', 'lasha']);

const companionOptionsSchema = z.object({
  humanChoosesCard: z.boolean().optional(),
  humanPlaysFree:   z.boolean().optional(),
  humanRollsDice:   z.boolean().optional(),
}).optional();

const singleplayerSchema = z.object({
  mode: z.literal('singleplayer'),
  powers: z.array(zPowerEnum).min(2).max(4),
  playerTypes: z.record(zPowerEnum, z.enum(['human', 'ai'])),
  companionOptions: companionOptionsSchema,
});

const multiplayerSchema = z.object({
  mode: z.literal('multiplayer'),
  name: z.string().min(1).max(60),
  isPublic: z.boolean().optional(),
});

// Legacy schema (no mode field — treat as singleplayer)
const legacySchema = z.object({
  powers: z.array(zPowerEnum).min(2).max(4),
  playerTypes: z.record(zPowerEnum, z.enum(['human', 'ai', 'guest'])),
  playerUserIds: z.record(zPowerEnum, z.string().uuid()).optional(),
  companionOptions: companionOptionsSchema,
});

const createGameSchema = z.union([singleplayerSchema, multiplayerSchema, legacySchema]);

router.post('/', requireAuth, async (req, res) => {
  const parsed = createGameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }
  const data = parsed.data;

  // Multiplayer — create pending game with lobby
  if ('mode' in data && data.mode === 'multiplayer') {
    try {
      const gameId = await createMultiplayerGame(req.userId!, data.name, data.isPublic ?? false);
      res.status(201).json({ gameId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
    return;
  }

  // Singleplayer (or legacy)
  const { powers, playerTypes } = data as z.infer<typeof legacySchema>;
  const playerUserIds = ('playerUserIds' in data ? data.playerUserIds : {}) ?? {};
  const rawCompanion = ('companionOptions' in data ? data.companionOptions : undefined);
  const hasCompanion = !!rawCompanion && (rawCompanion.humanChoosesCard || rawCompanion.humanPlaysFree || rawCompanion.humanRollsDice);
  const companionOptions = hasCompanion ? {
    humanChoosesCard: !!rawCompanion!.humanChoosesCard,
    humanPlaysFree:   !!rawCompanion!.humanPlaysFree,
    humanRollsDice:   !!rawCompanion!.humanRollsDice,
  } : undefined;

  const resolvedUserIds: Partial<Record<Power, string>> = { ...playerUserIds };
  for (const p of powers) {
    if (playerTypes[p] === 'human' && !resolvedUserIds[p]) {
      resolvedUserIds[p] = req.userId!;
    }
  }

  const gameId = await createGame(
    req.userId!,
    powers,
    playerTypes as Record<Power, PlayerType>,
    resolvedUserIds,
    companionOptions,
  );

  res.status(201).json({ gameId });
});

// ---------------------------------------------------------------------------
// GET /api/games — list games for authenticated user
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  const gameList = await listGamesForUser(req.userId!);
  res.json({ games: gameList });
});

// ---------------------------------------------------------------------------
// GET /api/games/:id — get game state
// ---------------------------------------------------------------------------
router.get('/:id', optionalAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: 'Game ID required' }); return; }
  try {
    // Short-circuit with 404 when the game no longer exists (e.g. cancelled
    // or the last human left an active game). Without this, getGameState
    // throws and the async handler crashes the process.
    const [gameRow] = await db.select({ name: games.name }).from(games).where(eq(games.id, id)).limit(1);
    if (!gameRow) { res.status(404).json({ error: 'Game not found' }); return; }
    const state = await getGameState(id, req.userId ?? null);
    let myPower: string | null = null;
    let myPowers: string[] = [];
    const playerRows = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, id));
    if (req.userId) {
      myPowers = playerRows.filter((r) => r.userId === req.userId).map((r) => r.power);
      myPower = myPowers[0] ?? null;
    }
    const userIds = Array.from(new Set(playerRows.map((r) => r.userId).filter((u): u is string => !!u)));
    const userRows = userIds.length
      ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
      : [];
    const usernameById = new Map(userRows.map((u) => [u.id, u.username]));
    const players = playerRows.map((r) => ({
      power: r.power,
      playerType: r.playerType,
      username: r.userId ? (usernameById.get(r.userId) ?? null) : null,
    }));
    res.json({ state, myPower, myPowers, players, name: gameRow.name ?? null });
  } catch (err) {
    console.error(`[GET /games/${id}]`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/games/:id/action — apply an action
// ---------------------------------------------------------------------------
const zRegionId = z.enum([
  'norrsund', 'talvimaa', 'volensk', 'mittelreich',
  'normagne', 'almerida', 'toscavar', 'pelascos', 'the_barrens',
]);
const zTokenType = z.enum(['event', 'hero', 'noble', 'peasant', 'ratmen', 'chaos_stone']);
const zChoices = z.record(z.unknown());

const zAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tenzen_discard'),            power: z.literal('tenzen'), cardId: z.string().nullable() }),
  z.object({ kind: z.literal('summoning_summon_figure'),   power: zPowerEnum, followerId: z.string(), toRegion: zRegionId, carry: z.boolean().optional() }),
  z.object({ kind: z.literal('summoning_play_card'),       power: zPowerEnum, cardId: z.string(), toRegion: zRegionId, slotIndex: z.union([z.literal(0), z.literal(1)]), onPlayChoice: zChoices.optional() }),
  z.object({ kind: z.literal('summoning_pass'),            power: zPowerEnum}),
  z.object({ kind: z.literal('world_choice'),              power: zPowerEnum, cardId: z.string(), choices: zChoices }),
  z.object({ kind: z.literal('hero_removal'),              power: zPowerEnum, followerId: z.string(), regionId: zRegionId }),
  z.object({ kind: z.literal('world_card_effect'),         power: zPowerEnum, cardId: z.string(), choices: zChoices }),
  z.object({ kind: z.literal('upgrade_choice'),            power: zPowerEnum, upgradeCardId: z.string() }),
  z.object({ kind: z.literal('corruption_harvest_choice'), power: z.literal('gormen'), regionId: zRegionId, followerIds: z.array(z.string()) }),
  z.object({ kind: z.literal('card_on_play_choice'),       power: zPowerEnum, cardId: z.string(), regionId: zRegionId, choices: zChoices }),
  z.object({ kind: z.literal('forced_discard'),            power: zPowerEnum, cardIds: z.array(z.string()) }),
  z.object({ kind: z.literal('battle_hit_assignment'),     power: zPowerEnum, regionId: zRegionId, followerIds: z.array(z.string()), peasantsToTake: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('dial_place_token'),          power: zPowerEnum, regionId: zRegionId }),
  z.object({ kind: z.literal('dial_remove_corruption'),    power: zPowerEnum, regionId: zRegionId, targetPower: zPowerEnum}),
  z.object({ kind: z.literal('dial_remove_world_token'),   power: zPowerEnum, regionId: zRegionId, tokenType: zTokenType }),
  z.object({ kind: z.literal('tenzen_apprentice_choice'),  power: zPowerEnum, followerId: z.string(), fromRegion: zRegionId, toRegion: zRegionId, carry: z.boolean() }),
  z.object({ kind: z.literal('rapture_choice'),            power: z.literal('lasha'), regionId: zRegionId, targetFollowerId: z.string() }),
  z.object({ kind: z.literal('companion_world_pick'),      power: zPowerEnum, cardId: z.string() }),
  z.object({ kind: z.literal('companion_dice_roll'),       power: zPowerEnum, hits: z.number().int().min(0).max(100) }),
]);

// Accepts either a single action (`action`) or a batch (`actions`). Batches
// are used for multi-pick dial rewards so all picks commit atomically.
const actionSchema = z.union([
  z.object({ action: zAction }),
  z.object({ actions: z.array(zAction).min(1) }),
]);

router.post('/:id/action', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: 'Game ID required' }); return; }

  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const actions = ('actions' in parsed.data ? parsed.data.actions : [parsed.data.action]) as Action[];
  const actionPower = actions[0]!.power;
  if (actions.some(a => a.power !== actionPower)) {
    res.status(400).json({ error: 'All batched actions must share the same power' });
    return;
  }

  const allPlayers = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, id));
  const powerPlayer = allPlayers.find((p) => p.power === actionPower);
  if (!powerPlayer || powerPlayer.userId !== req.userId) {
    res.status(403).json({ error: 'You do not control this power' });
    return;
  }

  try {
    const { applyPlayerActions } = await import('../game/service.js');
    const { state: newState, seq, events: actionEvents } = await applyPlayerActions(id, actionPower as Power, actions);
    const viewerPower = actionPower as import('@ruin/engine').Power;
    const maskedEvents = maskEvents(actionEvents, viewerPower);
    res.json({ state: newState, seq, events: maskedEvents });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/games/:id/chat — send a chat message
// ---------------------------------------------------------------------------
const chatSchema = z.object({ message: z.string().min(1).max(500) });

router.post('/:id/chat', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: 'Game ID required' }); return; }

  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  // Look up which power this user controls (if any)
  const [userRow] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
  const username = userRow?.username ?? 'Unknown';

  const allPlayers = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, id));
  const playerRow = allPlayers.find((p) => p.userId === req.userId);
  const power = playerRow?.power ?? null;

  const msg = await postChat(id, req.userId!, username, power, parsed.data.message);
  res.json({ message: msg });
});

// ---------------------------------------------------------------------------
// Lobby endpoints
// ---------------------------------------------------------------------------

router.get('/:id/lobby', requireAuth, async (req, res) => {
  try {
    const lobby = await getLobbyState(req.params.id!, req.userId!);
    res.json(lobby);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/invite', requireAuth, async (req, res) => {
  const parsed = z.object({ username: z.string().min(1).max(32) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide a username' }); return; }
  try {
    const invId = await lobbyInvite(req.params.id!, req.userId!, parsed.data.username);
    res.json({ invitationId: invId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/join', requireAuth, async (req, res) => {
  try {
    await lobbyJoin(req.params.id!, req.userId!);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/leave', requireAuth, async (req, res) => {
  try {
    const [gameRow] = await db.select({ status: games.status }).from(games).where(eq(games.id, req.params.id!)).limit(1);
    if (!gameRow) throw new Error('Game not found');
    if (gameRow.status === 'pending') {
      await lobbyLeave(req.params.id!, req.userId!);
      res.json({ ok: true, deleted: false });
    } else {
      const result = await leaveActiveGame(req.params.id!, req.userId!);
      res.json({ ok: true, deleted: result.deleted });
    }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/kick', requireAuth, async (req, res) => {
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    await lobbyKick(req.params.id!, req.userId!, parsed.data.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/pick-power', requireAuth, async (req, res) => {
  const parsed = z.object({ power: zPowerEnum.nullable() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    await lobbyPickPower(req.params.id!, req.userId!, parsed.data.power);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/assign-player', requireAuth, async (req, res) => {
  const parsed = z.object({
    userId: z.string().uuid(),
    power: zPowerEnum.nullable(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    await lobbyAssignPlayer(req.params.id!, req.userId!, parsed.data.userId, parsed.data.power);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/assign-ai', requireAuth, async (req, res) => {
  const parsed = z.object({
    aiIndex: z.number().int().min(0).max(3),
    power: zPowerEnum.nullable(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    await lobbyAssignAiSlot(req.params.id!, req.userId!, parsed.data.aiIndex, parsed.data.power);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/start', requireAuth, async (_req, res) => {
  try {
    await startMultiplayerGame(_req.params.id!, _req.userId!);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    await cancelMultiplayerGame(req.params.id!, req.userId!);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/:id/invitations/:invitationId', requireAuth, async (req, res) => {
  try {
    await revokeInvitation(req.params.id!, req.userId!, req.params.invitationId!);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/games/:id/stream — SSE stream
// ---------------------------------------------------------------------------
router.get('/:id/stream', optionalAuth, (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: 'Game ID required' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  // Send current state + full history immediately on connect.
  // For pending (lobby) games, send lobby state instead.
  const viewerUserId = req.userId ?? null;

  db.select().from(games).where(eq(games.id, id)).limit(1)
    .then(async ([gameRow]) => {
      if (!gameRow) throw new Error('Game not found');

      if (gameRow.status === 'pending') {
        // Lobby mode — send lobby state + chat history
        addListener(id, res, null);
        const lobby = viewerUserId ? await getLobbyState(id, viewerUserId) : null;
        const chatRows = await db.select().from(chatMessages)
          .where(eq(chatMessages.gameId, id))
          .orderBy(asc(chatMessages.createdAt));
        res.write(`data: ${JSON.stringify({
          type: 'lobby_state',
          lobby,
          chat: chatRows.map(m => ({
            id: m.id, power: m.power, username: m.username,
            message: m.message, createdAt: m.createdAt.toISOString(),
          })),
        })}\n\n`);
        return;
      }

      // Active/complete game — support resumption via ?sinceSeq for reconnects
      const sinceSeqRaw = req.query['sinceSeq'];
      const sinceSeq = typeof sinceSeqRaw === 'string' ? parseInt(sinceSeqRaw, 10) : NaN;

      const [state, playerRows] = await Promise.all([
        getGameState(id, viewerUserId),
        db.select().from(gamePlayers).where(eq(gamePlayers.gameId, id)),
      ]);
      const viewerRow = viewerUserId ? playerRows.find(r => r.userId === viewerUserId) : null;
      const viewerPower = (viewerRow?.power as import('@ruin/engine').Power) ?? null;
      addListener(id, res, viewerPower);

      if (Number.isFinite(sinceSeq) && sinceSeq > 0) {
        // Resume: send only events at or after sinceSeq. Client already has
        // state + earlier events in memory.
        const newEventRows = await db.select({ seq: gameEvents.seq, event: gameEvents.event })
          .from(gameEvents)
          .where(and(eq(gameEvents.gameId, id), gte(gameEvents.seq, sinceSeq)))
          .orderBy(asc(gameEvents.seq));
        if (newEventRows.length > 0) {
          const newEvents = newEventRows.map(r => r.event as unknown as import('@ruin/engine').GameEvent);
          const masked = maskEvents(newEvents, viewerPower);
          const lastRow = newEventRows[newEventRows.length - 1]!;
          const nextSeq = lastRow.seq + 1;
          res.write(`data: ${JSON.stringify({ type: 'events', events: masked, seq: nextSeq })}\n\n`);
        }
        return;
      }

      // First connect: send full history
      const history = await getGameHistory(id);
      res.write(`data: ${JSON.stringify({
        type: 'history',
        state,
        events: history.events,
        chat: history.chat,
      })}\n\n`);
    })
    .catch((err) => {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      })}\n\n`);
    });

  const pingInterval = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(pingInterval); }
  }, 30_000);

  req.on('close', () => {
    clearInterval(pingInterval);
    removeListener(id, res);
  });
});

export default router;

import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Power, PlayerType, Action } from '@ruin/engine';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  createGame,
  getGameState,
  applyPlayerAction,
  listGamesForUser,
  getGameHistory,
  postChat,
} from '../game/service.js';
import { addListener, removeListener } from '../game/sse.js';
import { db } from '../db/client.js';
import { gamePlayers, invitations, users } from '../db/schema.js';
import { createMagicLink } from '../auth/magicLink.js';
import { sendEmail } from '../email/index.js';
import { gameInviteEmail } from '../email/templates/gameInvite.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// POST /api/games — create game
// ---------------------------------------------------------------------------
const createGameSchema = z.object({
  powers: z.array(z.enum(['xarm', 'gormen', 'tenzen', 'lasha'])).min(2).max(4),
  playerTypes: z.record(
    z.enum(['xarm', 'gormen', 'tenzen', 'lasha']),
    z.enum(['human', 'ai', 'guest']),
  ),
  playerUserIds: z.record(
    z.enum(['xarm', 'gormen', 'tenzen', 'lasha']),
    z.string().uuid(),
  ).optional(),
  inviteEmails: z.array(
    z.object({
      power: z.enum(['xarm', 'gormen', 'tenzen', 'lasha']),
      email: z.string().email(),
    }),
  ).optional(),
});

router.post('/', requireAuth, async (req, res) => {
  const parsed = createGameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { powers, playerTypes, playerUserIds = {}, inviteEmails = [] } = parsed.data;

  const resolvedUserIds: Partial<Record<Power, string>> = { ...playerUserIds };
  // Assign the creator to every human slot that has no explicit userId
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
  );

  for (const { power, email } of inviteEmails) {
    const token = await createMagicLink(email, gameId);
    await db.insert(invitations).values({ gameId, email, power });
    await sendEmail({
      to: email,
      subject: 'You have been invited to play Ruin',
      html: gameInviteEmail(token, power),
    });
  }

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
  const state = await getGameState(id, req.userId ?? null);
  // Tell the client which power(s) they control so detection works even with
  // an empty hand (empty hands are indistinguishable from masked empty hands).
  let myPower: string | null = null;
  let myPowers: string[] = [];
  const playerRows = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, id));
  if (req.userId) {
    myPowers = playerRows.filter((r) => r.userId === req.userId).map((r) => r.power);
    myPower = myPowers[0] ?? null;
  }
  // Build per-power player descriptors with usernames for human players
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
  res.json({ state, myPower, myPowers, players });
});

// ---------------------------------------------------------------------------
// POST /api/games/:id/action — apply an action
// ---------------------------------------------------------------------------
const zPower = z.enum(['xarm', 'gormen', 'tenzen', 'lasha']);
const zRegionId = z.enum([
  'norrsund', 'talvimaa', 'volensk', 'mittelreich',
  'normagne', 'almerida', 'toscavar', 'pelascos', 'the_barrens',
]);
const zTokenType = z.enum(['event', 'hero', 'noble', 'peasant', 'ratmen', 'chaos_stone']);
const zChoices = z.record(z.unknown());

const zAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tenzen_discard'),            power: z.literal('tenzen'), cardId: z.string().nullable() }),
  z.object({ kind: z.literal('summoning_summon_figure'),   power: zPower, followerId: z.string(), toRegion: zRegionId }),
  z.object({ kind: z.literal('summoning_play_card'),       power: zPower, cardId: z.string(), toRegion: zRegionId, slotIndex: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ kind: z.literal('summoning_pass'),            power: zPower }),
  z.object({ kind: z.literal('world_choice'),              power: zPower, cardId: z.string(), choices: zChoices }),
  z.object({ kind: z.literal('hero_removal'),              power: zPower, followerId: z.string(), regionId: zRegionId }),
  z.object({ kind: z.literal('world_card_effect'),         power: zPower, cardId: z.string(), choices: zChoices }),
  z.object({ kind: z.literal('upgrade_choice'),            power: zPower, upgradeCardId: z.string() }),
  z.object({ kind: z.literal('corruption_harvest_choice'), power: z.literal('gormen'), regionId: zRegionId, followerIds: z.array(z.string()) }),
  z.object({ kind: z.literal('card_on_play_choice'),       power: zPower, cardId: z.string(), regionId: zRegionId, choices: zChoices }),
  z.object({ kind: z.literal('forced_discard'),            power: zPower, cardIds: z.array(z.string()) }),
  z.object({ kind: z.literal('battle_hit_assignment'),     power: zPower, regionId: zRegionId, followerIds: z.array(z.string()), peasantsToTake: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('dial_place_token'),          power: zPower, regionId: zRegionId }),
  z.object({ kind: z.literal('dial_remove_corruption'),    power: zPower, regionId: zRegionId, targetPower: zPower }),
  z.object({ kind: z.literal('dial_remove_world_token'),   power: zPower, regionId: zRegionId, tokenType: zTokenType }),
  z.object({ kind: z.literal('tenzen_apprentice_choice'),  power: zPower, followerId: z.string(), fromRegion: zRegionId, toRegion: zRegionId, carry: z.boolean() }),
]);

const actionSchema = z.object({ action: zAction });

router.post('/:id/action', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: 'Game ID required' }); return; }

  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const action = parsed.data.action as Action;
  const actionPower = action.power;

  const allPlayers = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, id));
  const powerPlayer = allPlayers.find((p) => p.power === actionPower);
  if (!powerPlayer || powerPlayer.userId !== req.userId) {
    res.status(403).json({ error: 'You do not control this power' });
    return;
  }

  const newState = await applyPlayerAction(id, actionPower as Power, action);
  res.json({ state: newState });
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

  addListener(id, res);

  // Send current state + full history immediately on connect
  Promise.all([
    getGameState(id, req.userId ?? null),
    getGameHistory(id),
  ])
    .then(([state, history]) => {
      res.write(`data: ${JSON.stringify({
        type: 'history',
        state,
        eventLog: history.eventLog,
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

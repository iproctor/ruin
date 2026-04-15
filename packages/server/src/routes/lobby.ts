import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  getLobbySnapshot,
  postLobbyChat,
  broadcastPresence,
} from '../lobby/service.js';
import {
  addLobbyListener,
  removeLobbyListener,
} from '../lobby/sse.js';

const router: ReturnType<typeof Router> = Router();

router.get('/snapshot', requireAuth, async (req, res) => {
  try {
    const snap = await getLobbySnapshot(req.userId!);
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed' });
  }
});

const chatSchema = z.object({ message: z.string().min(1).max(500) });
router.post('/chat', requireAuth, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const [u] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
  const username = u?.username ?? 'Unknown';
  const msg = await postLobbyChat(req.userId!, username, parsed.data.message);
  res.json({ message: msg });
});

router.get('/stream', optionalAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) { res.status(401).json({ error: 'Unknown user' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  const listener = addLobbyListener(res, userId, u.username);
  // Tell others this user came online
  await broadcastPresence();

  // Send initial snapshot
  try {
    const snap = await getLobbySnapshot(userId);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: snap })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : 'Failed' })}\n\n`);
  }

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 30_000);

  req.on('close', () => {
    clearInterval(ping);
    removeLobbyListener(listener);
    void broadcastPresence();
  });
});

export default router;

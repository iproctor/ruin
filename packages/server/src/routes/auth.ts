import { Router } from 'express';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';
import { createMagicLink, consumeMagicLink } from '../auth/magicLink.js';
import { sendEmail } from '../email/index.js';
import { magicLinkEmail } from '../email/templates/magicLink.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
const registerSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(8),
  email: z.string().email().optional(),
});

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { username, password, email } = parsed.data;

  // Check for existing username or email
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(
      email
        ? or(eq(users.username, username), eq(users.email, email))
        : eq(users.username, username),
    )
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: 'Username or email already taken' });
    return;
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({ username, email: email ?? null, passwordHash })
    .returning({ id: users.id });

  if (!user) {
    res.status(500).json({ error: 'Failed to create user' });
    return;
  }

  const token = signToken(user.id);
  res.status(201).json({ token, userId: user.id });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
const loginSchema = z.object({
  username: z.string().optional(),
  email: z.string().email().optional(),
  password: z.string(),
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { username, email, password } = parsed.data;

  if (!username && !email) {
    res.status(400).json({ error: 'Provide username or email' });
    return;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(
      username
        ? eq(users.username, username)
        : eq(users.email, email!),
    )
    .limit(1);

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = signToken(user.id);
  res.json({ token, userId: user.id });
});

// ---------------------------------------------------------------------------
// POST /api/auth/magic-link/request
// ---------------------------------------------------------------------------
const magicLinkRequestSchema = z.object({
  email: z.string().email(),
  gameId: z.string().uuid().optional(),
});

router.post('/magic-link/request', async (req, res) => {
  const parsed = magicLinkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { email, gameId } = parsed.data;

  const token = await createMagicLink(email, gameId);

  await sendEmail({
    to: email,
    subject: 'Your Ruin sign-in link',
    html: magicLinkEmail(token),
  });

  // Always return 200 to avoid leaking whether email exists
  res.json({ message: 'If that email is valid, a link has been sent.' });
});

// ---------------------------------------------------------------------------
// GET /api/auth/magic-link/:token
// ---------------------------------------------------------------------------
router.get('/magic-link/:token', async (req, res) => {
  const { token } = req.params;

  if (!token) {
    res.status(400).json({ error: 'Token required' });
    return;
  }

  let linkData: { email: string; gameId: string | null };
  try {
    linkData = await consumeMagicLink(token);
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid link' });
    return;
  }

  // Find or create user by email
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, linkData.email))
    .limit(1);

  if (!user) {
    // Create a guest user with their email as a placeholder username
    const username = `guest_${linkData.email.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}_${Date.now()}`;
    const [created] = await db
      .insert(users)
      .values({ username, email: linkData.email })
      .returning();
    user = created;
  }

  if (!user) {
    res.status(500).json({ error: 'Failed to resolve user' });
    return;
  }

  const jwtToken = signToken(user.id);
  res.json({ token: jwtToken, userId: user.id, gameId: linkData.gameId });
});

export default router;

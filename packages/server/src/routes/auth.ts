import { Router } from 'express';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
const registerSchema = z.object({
  username: z.string().trim()
    .min(2, 'Username must be at least 2 characters')
    .max(32, 'Username must be at most 32 characters'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // Email is optional; treat a blank field as "not given".
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().email('That email address looks invalid').optional(),
  ),
});

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? 'Invalid input';
    res.status(400).json({ error: first, details: parsed.error.issues });
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
    res.status(404).json({ error: 'No such user', code: 'no_user' });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Wrong password', code: 'bad_password' });
    return;
  }

  const token = signToken(user.id);
  res.json({ token, userId: user.id });
});

export default router;

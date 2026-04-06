import { eq, and, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { magicLinks } from '../db/schema.js';

export async function createMagicLink(
  email: string,
  gameId?: string,
): Promise<string> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const [row] = await db
    .insert(magicLinks)
    .values({
      email,
      gameId: gameId ?? null,
      expiresAt,
    })
    .returning({ token: magicLinks.token });

  if (!row) throw new Error('Failed to create magic link');
  return row.token;
}

export async function consumeMagicLink(
  token: string,
): Promise<{ email: string; gameId: string | null }> {
  const now = new Date();

  const [link] = await db
    .select()
    .from(magicLinks)
    .where(
      and(
        eq(magicLinks.token, token),
        eq(magicLinks.used, false),
        gt(magicLinks.expiresAt, now),
      ),
    )
    .limit(1);

  if (!link) {
    throw new Error('Magic link is invalid, expired, or already used');
  }

  await db
    .update(magicLinks)
    .set({ used: true })
    .where(eq(magicLinks.token, token));

  return { email: link.email, gameId: link.gameId ?? null };
}

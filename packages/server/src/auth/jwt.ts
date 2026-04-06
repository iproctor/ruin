import jwt from 'jsonwebtoken';

function getSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return secret;
}

export function signToken(userId: string): string {
  return jwt.sign({ userId }, getSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): { userId: string } {
  const payload = jwt.verify(token, getSecret()) as { userId: string };
  return { userId: payload.userId };
}

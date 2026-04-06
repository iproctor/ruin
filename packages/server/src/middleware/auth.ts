import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../auth/jwt.js';

// Extend Express Request to carry userId
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = header.slice(7);
  try {
    const { userId } = verifyToken(token);
    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7);
    try {
      const { userId } = verifyToken(token);
      req.userId = userId;
    } catch {
      // Invalid token — treat as unauthenticated
    }
  }
  next();
}

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

function constantTimeMatch(userKey: string, validKeys: string[]): boolean {
  for (const validKey of validKeys) {
    if (userKey.length === validKey.length) {
      if (timingSafeEqual(Buffer.from(userKey), Buffer.from(validKey))) {
        return true;
      }
    }
  }
  return false;
}

export function authMiddleware(apiKeys: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth if no keys configured (local dev mode)
    if (apiKeys.length === 0) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const key = authHeader.slice(7);
    if (!constantTimeMatch(key, apiKeys)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    next();
  };
}

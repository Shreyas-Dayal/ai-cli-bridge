import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import type { KeyManager } from '../keys.js';

// Extend Express Request to carry the authenticated key name
declare global {
  namespace Express {
    interface Request {
      keyName?: string;
      rawKey?: string;
    }
  }
}

/** Auth middleware using KeyManager for per-user key validation + limit checking. */
export function keyAuthMiddleware(keyManager: KeyManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth if no keys exist (local dev mode)
    if (!keyManager.hasKeys()) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawKey = authHeader.slice(7);
    const keyName = keyManager.validate(rawKey);
    if (!keyName) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Check usage limits
    const limitError = keyManager.checkLimits(rawKey);
    if (limitError) {
      res.status(429).json({ error: limitError });
      return;
    }

    req.keyName = keyName;
    req.rawKey = rawKey;
    next();
  };
}

/** Admin auth middleware — checks against BRIDGE_ADMIN_KEY env var. */
export function adminAuthMiddleware(adminKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!adminKey) {
      res.status(503).json({ error: 'Admin API not configured' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const provided = authHeader.slice(7);
    if (provided.length !== adminKey.length) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(adminKey))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    next();
  };
}

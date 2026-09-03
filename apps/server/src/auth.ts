import type { NextFunction, Request, Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import type { Config } from './config.ts';

/**
 * Bearer-token authentication.
 *
 * In firebase mode every request must carry a Firebase ID token, which is
 * verified against the project's public keys. In local mode the token is any
 * non-empty string and becomes the user id directly — enough to exercise
 * multi-user behaviour on one machine without a Firebase project, and
 * unreachable in production because {@link loadConfig} refuses to select local
 * mode there.
 */

export interface AuthedRequest extends Request {
  userId?: string;
}

export const LOCAL_TOKEN_PREFIX = 'local:';

export function requireAuth(config: Config) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'unauthenticated', message: 'Missing bearer token.' });
      return;
    }

    if (config.mode === 'local') {
      // `local:alice` -> user "alice". Anything else is hashed to a stable id so
      // a pasted real token still maps to one consistent local account.
      const userId = token.startsWith(LOCAL_TOKEN_PREFIX)
        ? token.slice(LOCAL_TOKEN_PREFIX.length)
        : `local-${simpleHash(token)}`;
      if (!userId) {
        res.status(401).json({ error: 'unauthenticated', message: 'Empty local user id.' });
        return;
      }
      req.userId = userId;
      next();
      return;
    }

    try {
      const decoded = await getAuth().verifyIdToken(token, true);
      req.userId = decoded.uid;
      next();
    } catch (error) {
      res.status(401).json({
        error: 'unauthenticated',
        message: error instanceof Error ? error.message : 'Token verification failed.',
      });
    }
  };
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

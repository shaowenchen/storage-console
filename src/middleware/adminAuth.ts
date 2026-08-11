import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { sendApiError } from '../domain/apiError.js';
import { getDownloadKey, getUploadKey } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { readSession } from './session.js';

export interface UserKeyAuth {
  userId: string;
  user: string;
  keyType: 'login' | 'upload' | 'download';
}

declare global {
  namespace Express {
    interface Request {
      userKeyAuth?: UserKeyAuth;
    }
  }
}

const log = createLogger('adminAuth');

export interface AuthCredentials {
  key: string;
}

export function extractAuthCredentials(req: Request): AuthCredentials | undefined {
  const key = req.headers['x-api-key'] as string | undefined;
  if (key?.trim()) {
    return { key: key.trim() };
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function sessionAuth(req: Request): UserKeyAuth | undefined {
  const session = readSession(req);
  if (!session) return undefined;
  return { userId: session.userId, user: session.user, keyType: 'login' };
}

/** Resolves upload/download API keys only — never the login key. */
export function authenticateUserKey(creds: AuthCredentials): UserKeyAuth | undefined {
  try {
    if (safeEqual(creds.key, getUploadKey())) {
      return { userId: 'admin', user: 'admin', keyType: 'upload' };
    }
    if (safeEqual(creds.key, getDownloadKey())) {
      return { userId: 'admin', user: 'admin', keyType: 'download' };
    }
  } catch (error) {
    log.warn('User authentication failed — app keys unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  log.warn('User authentication failed', { hasApiKeyHeader: true });
  return undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const fromSession = sessionAuth(req);
  if (fromSession) {
    req.userKeyAuth = fromSession;
    return next();
  }

  sendApiError(res, 401, 'Authentication required');
}

export function requireUploadAuth(req: Request, res: Response, next: NextFunction): void {
  const fromSession = sessionAuth(req);
  if (fromSession) {
    req.userKeyAuth = fromSession;
    return next();
  }

  const creds = extractAuthCredentials(req);
  if (!creds) {
    sendApiError(res, 401, 'Authentication required');
    return;
  }

  const auth = authenticateUserKey(creds);
  if (auth && auth.keyType === 'upload') {
    req.userKeyAuth = auth;
    return next();
  }
  sendApiError(res, 401, 'Unauthorized');
}

export function requireDownloadAuth(req: Request, res: Response, next: NextFunction): void {
  const fromSession = sessionAuth(req);
  if (fromSession) {
    req.userKeyAuth = fromSession;
    return next();
  }

  const creds = extractAuthCredentials(req);
  if (!creds) {
    sendApiError(res, 401, 'Authentication required');
    return;
  }

  const auth = authenticateUserKey(creds);
  if (auth && auth.keyType === 'download') {
    req.userKeyAuth = auth;
    return next();
  }
  sendApiError(res, 401, 'Unauthorized');
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.userKeyAuth?.user === 'admin') return next();
    sendApiError(res, 403, 'Admin access required');
  });
}

export function requireAdminUploadAuth(req: Request, res: Response, next: NextFunction): void {
  requireUploadAuth(req, res, () => {
    if (req.userKeyAuth?.user === 'admin') return next();
    sendApiError(res, 403, 'Admin access required');
  });
}

export function requireAdminDownloadAuth(req: Request, res: Response, next: NextFunction): void {
  requireDownloadAuth(req, res, () => {
    if (req.userKeyAuth?.user === 'admin') return next();
    sendApiError(res, 403, 'Admin access required');
  });
}

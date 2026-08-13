import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/adminAuth.js';
import { clearSessionCookie, readSession, setSessionCookie } from '../middleware/session.js';
import { getAdminUserKey, getDownloadKey, getUploadKey } from '../config/env.js';
import { sendApiError } from '../domain/apiError.js';
import { rotateCachedAuthKey } from '../services/authKeyStore.js';
import { getClientIp, loginThrottle } from '../services/loginThrottle.js';
import { createLogger } from '../utils/logger.js';

const router = Router();
const log = createLogger('auth');

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const ip = getClientIp(req);
    const lock = loginThrottle.getLockStatus(ip);
    if (lock.locked) {
      res.setHeader('Retry-After', String(lock.retryAfterSeconds));
      sendApiError(
        res,
        429,
        `Too many failed login attempts. Try again in ${lock.retryAfterSeconds} second(s).`,
        'login_locked',
        [`retryAfterSeconds=${lock.retryAfterSeconds}`],
      );
      return;
    }

    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key) {
      sendApiError(res, 400, 'Login key is required');
      return;
    }

    if (!safeEqualString(key, getAdminUserKey())) {
      const failure = loginThrottle.recordFailure(ip);
      log.warn('Login failed', {
        ip,
        failures: failure.failures,
        locked: failure.locked,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
      if (failure.locked) {
        res.setHeader('Retry-After', String(failure.retryAfterSeconds));
        sendApiError(
          res,
          429,
          `Too many failed login attempts. Try again in ${failure.retryAfterSeconds} second(s).`,
          'login_locked',
          [`retryAfterSeconds=${failure.retryAfterSeconds}`],
        );
        return;
      }
      sendApiError(res, 401, 'Invalid login key');
      return;
    }

    loginThrottle.clear(ip);
    setSessionCookie(res, {
      userId: 'admin',
      user: 'admin',
      issuedAt: Date.now(),
    });
    res.json({ user: 'admin' });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

router.get(
  '/session',
  asyncHandler(async (req, res) => {
    const session = readSession(req);
    if (!session) {
      sendApiError(res, 401, 'Not authenticated', 'not_authenticated');
      return;
    }
    res.json({ user: session.user, userId: session.userId });
  }),
);

router.get(
  '/profile/keys',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ upload: getUploadKey(), download: getDownloadKey() });
  }),
);

router.get(
  '/profile/keys/upload',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ type: 'upload', key: getUploadKey() });
  }),
);

router.get(
  '/profile/keys/download',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ type: 'download', key: getDownloadKey() });
  }),
);

router.post(
  '/profile/keys/:type/rotate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const type = req.params.type;
    if (type !== 'upload' && type !== 'download') {
      sendApiError(res, 400, 'type must be upload or download');
      return;
    }
    const key = await rotateCachedAuthKey(type);
    res.json({ type, key });
  }),
);

export default router;

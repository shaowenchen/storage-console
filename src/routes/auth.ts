import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/adminAuth.js';
import { clearSessionCookie, readSession, setSessionCookie } from '../middleware/session.js';
import { getAdminUserKey, getDownloadKey, getUploadKey } from '../config/env.js';
import { sendApiError } from '../domain/apiError.js';
import { rotateCachedAuthKey } from '../services/authKeyStore.js';

const router = Router();

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key) {
      sendApiError(res, 400, 'Login key is required');
      return;
    }

    if (key !== getAdminUserKey()) {
      sendApiError(res, 401, 'Invalid login key');
      return;
    }

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

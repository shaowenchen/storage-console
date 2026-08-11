import { createLogger } from '../utils/logger.js';

const log = createLogger('config');

const DEFAULT_SESSION_SECRET = 'storage-console-session-secret-change-me';
const DEFAULT_ADMIN_USER_KEY = 'change-me';

export function getSessionSecret(): string {
  return process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
}

export function getCredentialsSecret(): string {
  const explicit = (process.env.CREDENTIALS_SECRET || '').trim();
  if (explicit) return explicit;
  return getSessionSecret();
}

/** Admin token accepted for sign-in and (via X-API-Key) for script/automation calls. */
export function getAdminUserKey(): string {
  return (process.env.ADMIN_USER_KEY || DEFAULT_ADMIN_USER_KEY).trim();
}

/** Upload key used by the "Pull & Run" script; defaults to the admin key. */
export function getUploadKey(): string {
  return (process.env.UPLOAD_KEY || '').trim() || getAdminUserKey();
}

export function isProductionLike(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function getPort(): number {
  const port = parseInt(process.env.PORT || '3001', 10);
  return Number.isFinite(port) ? port : 3001;
}

export function getHost(): string {
  return process.env.HOST || '0.0.0.0';
}

export function validateProductionConfig(): void {
  if (!isProductionLike()) return;

  const sessionSecret = getSessionSecret();
  if (!sessionSecret || sessionSecret === DEFAULT_SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set to a strong unique value in production');
  }

  const adminKey = getAdminUserKey();
  if (!adminKey || adminKey === DEFAULT_ADMIN_USER_KEY) {
    throw new Error('ADMIN_USER_KEY must be set to a strong unique value in production');
  }

  log.info('Production configuration validated');
}

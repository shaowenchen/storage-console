import { createLogger } from '../utils/logger.js';
import { getCachedAuthKey } from '../services/authKeyStore.js';

const log = createLogger('config');

const DEFAULT_ADMIN_USER_KEY = 'change-me';

/** Admin token accepted for sign-in only. */
export function getAdminUserKey(): string {
  return (process.env.ADMIN_USER_KEY || DEFAULT_ADMIN_USER_KEY).trim();
}

/** HMAC secret for session cookies (persisted auth key). */
export function getSessionSecret(): string {
  return getCachedAuthKey('session');
}

/** Secret for encrypting S3 credentials at rest. */
export function getCredentialsSecret(): string {
  const explicit = (process.env.CREDENTIALS_SECRET || '').trim();
  if (explicit) return explicit;
  return getSessionSecret();
}

/** Upload API key (persisted auth key). */
export function getUploadKey(): string {
  return getCachedAuthKey('upload');
}

/** Download API key (persisted auth key). */
export function getDownloadKey(): string {
  return getCachedAuthKey('download');
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

  const adminKey = getAdminUserKey();
  if (!adminKey || adminKey === DEFAULT_ADMIN_USER_KEY) {
    throw new Error('ADMIN_USER_KEY must be set to a strong unique value in production');
  }

  log.info('Production configuration validated');
}

import { randomBytes } from 'crypto';
import type { DatabaseAdapter } from '../adapter.js';

export type AuthKeyType = 'upload' | 'download' | 'session';

const ALL_TYPES: AuthKeyType[] = ['upload', 'download', 'session'];

function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

export async function ensureAuthKeys(adapter: DatabaseAdapter): Promise<void> {
  const now = Date.now();
  for (const type of ALL_TYPES) {
    const row = await adapter.get(`SELECT type FROM auth_keys WHERE type = ?`, [type]);
    if (!row) {
      await adapter.run(
        `INSERT INTO auth_keys (type, key, created_at, rotated_at) VALUES (?, ?, ?, NULL)`,
        [type, generateKey(), now],
      );
    }
  }
}

export async function getAuthKey(adapter: DatabaseAdapter, type: AuthKeyType): Promise<string> {
  const row = await adapter.get(`SELECT key FROM auth_keys WHERE type = ?`, [type]);
  if (!row?.key || typeof row.key !== 'string') {
    throw new Error(`Missing auth key: ${type}`);
  }
  return row.key;
}

export async function rotateAuthKey(
  adapter: DatabaseAdapter,
  type: 'upload' | 'download',
): Promise<string> {
  const next = generateKey();
  const now = Date.now();
  await adapter.run(`UPDATE auth_keys SET key = ?, rotated_at = ? WHERE type = ?`, [
    next,
    now,
    type,
  ]);
  return next;
}

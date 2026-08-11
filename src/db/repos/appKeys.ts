import { randomBytes } from 'crypto';
import type { DatabaseAdapter } from '../adapter.js';

export type AppKeyType = 'upload' | 'download' | 'session';

const ALL_TYPES: AppKeyType[] = ['upload', 'download', 'session'];

function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

export async function ensureAppKeys(adapter: DatabaseAdapter): Promise<void> {
  const now = Date.now();
  for (const type of ALL_TYPES) {
    const row = await adapter.get(`SELECT type FROM app_keys WHERE type = ?`, [type]);
    if (!row) {
      await adapter.run(
        `INSERT INTO app_keys (type, key, created_at, rotated_at) VALUES (?, ?, ?, NULL)`,
        [type, generateKey(), now],
      );
    }
  }
}

export async function getAppKey(adapter: DatabaseAdapter, type: AppKeyType): Promise<string> {
  const row = await adapter.get(`SELECT key FROM app_keys WHERE type = ?`, [type]);
  if (!row?.key || typeof row.key !== 'string') {
    throw new Error(`Missing app key: ${type}`);
  }
  return row.key;
}

export async function rotateAppKey(
  adapter: DatabaseAdapter,
  type: 'upload' | 'download',
): Promise<string> {
  const next = generateKey();
  const now = Date.now();
  await adapter.run(`UPDATE app_keys SET key = ?, rotated_at = ? WHERE type = ?`, [
    next,
    now,
    type,
  ]);
  return next;
}

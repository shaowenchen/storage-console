import { createHash } from 'crypto';
import type { DatabaseAdapter } from './adapter.js';
import { getDb } from './connection.js';

export async function getAdapter(): Promise<DatabaseAdapter> {
  return getDb();
}

export function keyToSha256(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

import { getDb } from '../db/connection.js';
import { type AuthKeyType, getAuthKey, rotateAuthKey } from '../db/repos/authKeys.js';

type Cache = Record<AuthKeyType, string>;

let cache: Cache | undefined;

function requireCache(): Cache {
  if (!cache) {
    throw new Error('Auth keys have not been bootstrapped');
  }
  return cache;
}

export async function bootstrapAuthKeys(): Promise<void> {
  const adapter = await getDb();
  cache = {
    upload: await getAuthKey(adapter, 'upload'),
    download: await getAuthKey(adapter, 'download'),
    session: await getAuthKey(adapter, 'session'),
  };
}

export function getCachedAuthKey(type: AuthKeyType): string {
  return requireCache()[type];
}

export async function rotateCachedAuthKey(type: 'upload' | 'download'): Promise<string> {
  const adapter = await getDb();
  const next = await rotateAuthKey(adapter, type);
  requireCache()[type] = next;
  return next;
}

export function resetAuthKeyStoreForTests(): void {
  cache = undefined;
}

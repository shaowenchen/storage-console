import { getDb } from '../db/connection.js';
import {
  type AppKeyType,
  getAppKey,
  rotateAppKey,
} from '../db/repos/appKeys.js';

type Cache = Record<AppKeyType, string>;

let cache: Cache | undefined;

function requireCache(): Cache {
  if (!cache) {
    throw new Error('App keys have not been bootstrapped');
  }
  return cache;
}

export async function bootstrapAppKeys(): Promise<void> {
  const adapter = await getDb();
  cache = {
    upload: await getAppKey(adapter, 'upload'),
    download: await getAppKey(adapter, 'download'),
    session: await getAppKey(adapter, 'session'),
  };
}

export function getCachedAppKey(type: AppKeyType): string {
  return requireCache()[type];
}

export async function rotateCachedAppKey(type: 'upload' | 'download'): Promise<string> {
  const adapter = await getDb();
  const next = await rotateAppKey(adapter, type);
  requireCache()[type] = next;
  return next;
}

export function resetAppKeyStoreForTests(): void {
  cache = undefined;
}

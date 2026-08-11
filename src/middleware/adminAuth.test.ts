import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetAdapterForTests } from '../db/adapter.js';
import { resetMigrateForTests } from '../db/migrate.js';
import { getAdminUserKey } from '../config/env.js';
import {
  bootstrapAuthKeys,
  getCachedAuthKey,
  resetAuthKeyStoreForTests,
} from '../services/authKeyStore.js';
import { authenticateUserKey } from './adminAuth.js';

describe('authenticateUserKey', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-console-auth-'));
    process.env.SQL_DSN = `sqlite://${join(dir, 'test.sqlite')}`;
    process.env.ADMIN_USER_KEY = 'login-secret-for-tests';
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();
    await bootstrapAuthKeys();
  });

  afterEach(() => {
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();
    delete process.env.SQL_DSN;
    delete process.env.ADMIN_USER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects the login key', () => {
    expect(authenticateUserKey({ key: getAdminUserKey() })).toBeUndefined();
  });

  it('accepts the upload key as upload', () => {
    const auth = authenticateUserKey({ key: getCachedAuthKey('upload') });
    expect(auth).toEqual({ userId: 'admin', user: 'admin', keyType: 'upload' });
  });

  it('accepts the download key as download', () => {
    const auth = authenticateUserKey({ key: getCachedAuthKey('download') });
    expect(auth).toEqual({ userId: 'admin', user: 'admin', keyType: 'download' });
  });

  it('rejects unknown keys', () => {
    expect(authenticateUserKey({ key: 'not-a-real-key' })).toBeUndefined();
  });
});

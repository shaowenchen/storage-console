import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAdapterForTests } from '../adapter.js';
import { getDb } from '../connection.js';
import { resetMigrateForTests } from '../migrate.js';
import { getAuthKey, rotateAuthKey } from './authKeys.js';

describe('authKeys', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-console-keys-'));
    process.env.SQL_DSN = `sqlite://${join(dir, 'test.sqlite')}`;
    resetAdapterForTests();
    resetMigrateForTests();
  });

  afterEach(() => {
    resetAdapterForTests();
    resetMigrateForTests();
    delete process.env.SQL_DSN;
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensures upload, download, and session keys on migrate', async () => {
    const db = await getDb();
    const upload = await getAuthKey(db, 'upload');
    const download = await getAuthKey(db, 'download');
    const session = await getAuthKey(db, 'session');
    const alphanumeric = /^[A-Za-z0-9]+$/;
    expect(upload).toMatch(alphanumeric);
    expect(download).toMatch(alphanumeric);
    expect(session).toMatch(alphanumeric);
    expect(upload).toHaveLength(40);
    expect(download).toHaveLength(40);
    expect(session).toHaveLength(40);
    expect(new Set([upload, download, session]).size).toBe(3);
  });

  it('keeps existing keys on second ensure', async () => {
    const db = await getDb();
    const upload1 = await getAuthKey(db, 'upload');
    const download1 = await getAuthKey(db, 'download');
    const session1 = await getAuthKey(db, 'session');

    resetAdapterForTests();
    resetMigrateForTests();
    const db2 = await getDb();
    expect(await getAuthKey(db2, 'upload')).toBe(upload1);
    expect(await getAuthKey(db2, 'download')).toBe(download1);
    expect(await getAuthKey(db2, 'session')).toBe(session1);
  });

  it('rotates only the upload key', async () => {
    const db = await getDb();
    const uploadBefore = await getAuthKey(db, 'upload');
    const downloadBefore = await getAuthKey(db, 'download');
    const sessionBefore = await getAuthKey(db, 'session');

    const uploadAfter = await rotateAuthKey(db, 'upload');
    expect(uploadAfter).not.toBe(uploadBefore);
    expect(await getAuthKey(db, 'upload')).toBe(uploadAfter);
    expect(await getAuthKey(db, 'download')).toBe(downloadBefore);
    expect(await getAuthKey(db, 'session')).toBe(sessionBefore);
  });
});

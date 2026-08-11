import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAdapterForTests } from '../adapter.js';
import { getDb } from '../connection.js';
import { resetMigrateForTests } from '../migrate.js';
import { getAppKey, rotateAppKey } from './appKeys.js';

describe('appKeys', () => {
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
    const upload = await getAppKey(db, 'upload');
    const download = await getAppKey(db, 'download');
    const session = await getAppKey(db, 'session');
    expect(upload.length).toBeGreaterThan(20);
    expect(download.length).toBeGreaterThan(20);
    expect(session.length).toBeGreaterThan(20);
    expect(new Set([upload, download, session]).size).toBe(3);
  });

  it('keeps existing keys on second ensure', async () => {
    const db = await getDb();
    const upload1 = await getAppKey(db, 'upload');
    const download1 = await getAppKey(db, 'download');
    const session1 = await getAppKey(db, 'session');

    resetAdapterForTests();
    resetMigrateForTests();
    const db2 = await getDb();
    expect(await getAppKey(db2, 'upload')).toBe(upload1);
    expect(await getAppKey(db2, 'download')).toBe(download1);
    expect(await getAppKey(db2, 'session')).toBe(session1);
  });

  it('rotates only the upload key', async () => {
    const db = await getDb();
    const uploadBefore = await getAppKey(db, 'upload');
    const downloadBefore = await getAppKey(db, 'download');
    const sessionBefore = await getAppKey(db, 'session');

    const uploadAfter = await rotateAppKey(db, 'upload');
    expect(uploadAfter).not.toBe(uploadBefore);
    expect(await getAppKey(db, 'upload')).toBe(uploadAfter);
    expect(await getAppKey(db, 'download')).toBe(downloadBefore);
    expect(await getAppKey(db, 'session')).toBe(sessionBefore);
  });
});

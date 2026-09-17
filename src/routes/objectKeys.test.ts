import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../createApp.js';
import { resetAdapterForTests } from '../db/adapter.js';
import { resetMigrateForTests } from '../db/migrate.js';
import { createBucket } from '../db/repos/buckets.js';
import { bootstrapAuthKeys, resetAuthKeyStoreForTests } from '../services/authKeyStore.js';
import { clearS3Client } from '../services/s3.js';

/**
 * The recursive listing behind "download this folder".
 *
 * The property that matters is that a folder yields *every* object beneath it,
 * at any depth, and that the response is paginated properly — ListObjectsV2
 * returns at most 1000 keys per page and this walks the continuation tokens.
 *
 * It also pins the cap. The client downloads these one at a time, so a folder
 * that exceeds the limit must say so rather than quietly return a short list
 * the user would read as "that was all of them".
 *
 * Everything is loopback: a fake storage serving ListObjectsV2, a temporary
 * SQLite database, and the real Express app. No docker, no credentials.
 */

type FakeStorage = {
  endpoint: string;
  /** Keys the fake bucket holds. */
  objects: string[];
  /** Paging size, so multi-page listings are exercised. */
  pageSize: number;
  requests: string[];
  close: () => Promise<void>;
};

/** Escape the five XML metacharacters, so odd keys round-trip intact. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function startFakeStorage(objects: string[]): Promise<FakeStorage> {
  const requests: string[] = [];
  // Held behind accessors: the request handler reads these on every call, so a
  // test assigning `storage.objects = [...]` must be visible to it.
  const state = { pageSize: 1000, objects };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push(req.url || '');
    if (req.method !== 'GET' || !url.searchParams.has('list-type')) {
      res.writeHead(404);
      res.end();
      return;
    }

    const prefix = url.searchParams.get('prefix') || '';
    const token = url.searchParams.get('continuation-token') || '';
    const matching = state.objects.filter((key) => key.startsWith(prefix)).sort();

    // The token is just an offset, which is enough to prove the walk works.
    const offset = token ? Number(token) : 0;
    const page = matching.slice(offset, offset + state.pageSize);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < matching.length;

    const contents = page
      .map((key) => `<Contents><Key>${xmlEscape(key)}</Key><Size>1</Size></Contents>`)
      .join('');
    const next = truncated
      ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${nextOffset}</NextContinuationToken>`
      : '<IsTruncated>false</IsTruncated>';

    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><Prefix>${xmlEscape(prefix)}</Prefix>${next}${contents}</ListBucketResult>`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    get objects() {
      return state.objects;
    },
    set objects(value: string[]) {
      state.objects = value;
    },
    get pageSize() {
      return state.pageSize;
    },
    set pageSize(value: number) {
      state.pageSize = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startApp(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('recursive object key listing', () => {
  let dir: string;
  let storage: FakeStorage;
  let app: { origin: string; close: () => Promise<void> };
  let cookie: string;
  let bucketId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-console-keys-'));
    process.env.SQL_DSN = `sqlite://${join(dir, 'test.sqlite')}`;
    process.env.ADMIN_USER_KEY = 'test-admin-key';
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();

    storage = await startFakeStorage([]);
    await bootstrapAuthKeys();

    const bucket = await createBucket(
      'test bucket',
      'ObjectStorage',
      storage.endpoint,
      'us-east-1',
      'access-key',
      'secret-key',
      'b',
      '',
      'admin',
    );
    bucketId = bucket.id;
    app = await startApp();

    // `requireAdmin` accepts a session cookie, not an API key — the same
    // credential a browser tab carries. Logging in for real keeps this test
    // honest about that path.
    const login = await fetch(`${app.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-admin-key' }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') || '';
    cookie = setCookie.split(';')[0]!;
    expect(cookie).toContain('storageconsole_session=');
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    clearS3Client(bucketId);
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();
    delete process.env.SQL_DSN;
    delete process.env.ADMIN_USER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  async function listKeys(query: string) {
    const res = await fetch(`${app.origin}/api/storages/${bucketId}/object-keys?${query}`, {
      headers: { Cookie: cookie },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('returns every object under the prefix, at any depth', async () => {
    storage.objects = [
      'logs/2026/a.txt',
      'logs/2026/deep/nested/b.txt',
      'logs/c.txt',
      'other/d.txt',
      'logs/2026/sub/e.txt',
    ];

    const { status, body } = await listKeys('key=logs/&isPrefix=1');
    expect(status).toBe(200);
    expect(body.keys).toEqual([
      'logs/2026/a.txt',
      'logs/2026/deep/nested/b.txt',
      'logs/2026/sub/e.txt',
      'logs/c.txt',
    ]);
    expect(body.total).toBe(4);
    expect(body.truncated).toBe(false);
    // `other/d.txt` is outside the prefix.
    expect(body.keys).not.toContain('other/d.txt');
  });

  it('walks continuation tokens instead of stopping at the first page', async () => {
    // 250 objects against a 100-key page: three pages, so a listing that
    // ignored the continuation token would return only the first 100.
    storage.objects = Array.from(
      { length: 250 },
      (_, i) => `bulk/file-${String(i).padStart(3, '0')}.bin`,
    );
    storage.pageSize = 100;

    const { body } = await listKeys('key=bulk/&isPrefix=1');
    expect(body.total).toBe(250);
    expect((body.keys as string[]).length).toBe(250);
    // More than one page was actually fetched.
    expect(storage.requests.length).toBeGreaterThan(1);
  });

  it('caps an oversized folder and says so', async () => {
    storage.objects = Array.from({ length: 1200 }, (_, i) => `big/f-${i}.bin`);
    storage.pageSize = 500;

    const { status, body } = await listKeys('key=big/&isPrefix=1');
    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
    expect((body.keys as string[]).length).toBe(1000);
    expect(body.maxObjects).toBe(1000);
  });

  it('treats a trailing slash as "everything under this prefix"', async () => {
    storage.objects = ['a/b.txt', 'a/deep/c.txt'];

    // No isPrefix flag: the slash alone must trigger recursion.
    const { body } = await listKeys('key=a/');
    expect(body.keys).toEqual(['a/b.txt', 'a/deep/c.txt']);
  });

  it('returns a single key when the target is not a prefix', async () => {
    storage.objects = ['a/b.txt', 'a/c.txt'];

    const { body } = await listKeys('key=a/b.txt');
    expect(body.keys).toEqual(['a/b.txt']);
    expect(body.truncated).toBe(false);
  });

  it('returns an empty list for an empty folder', async () => {
    storage.objects = ['elsewhere/x.txt'];

    const { body } = await listKeys('key=empty/&isPrefix=1');
    expect(body.keys).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${app.origin}/api/storages/${bucketId}/object-keys?key=a/&isPrefix=1`);
    expect(res.status).toBe(401);
  });

  it('rejects a missing key', async () => {
    const res = await fetch(`${app.origin}/api/storages/${bucketId}/object-keys?key=`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });
});

/**
 * The signing endpoint behind the directory download.
 *
 * Signing is local, so the fake storage serves nothing here; what matters is
 * that each key comes back with its own signed URL, that the file name is
 * derived from the key, and that the batch is bounded before it is signed.
 */
describe('batch download links', () => {
  let dir: string;
  let storage: FakeStorage;
  let app: { origin: string; close: () => Promise<void> };
  let cookie: string;
  let bucketId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-console-links-'));
    process.env.SQL_DSN = `sqlite://${join(dir, 'test.sqlite')}`;
    process.env.ADMIN_USER_KEY = 'test-admin-key';
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();

    storage = await startFakeStorage([]);
    await bootstrapAuthKeys();

    const bucket = await createBucket(
      'test bucket',
      'ObjectStorage',
      storage.endpoint,
      'us-east-1',
      'access-key',
      'secret-key',
      'b',
      '',
      'admin',
    );
    bucketId = bucket.id;
    app = await startApp();

    const login = await fetch(`${app.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-admin-key' }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') || '').split(';')[0]!;
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    clearS3Client(bucketId);
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();
    delete process.env.SQL_DSN;
    delete process.env.ADMIN_USER_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  async function requestLinks(keys: unknown) {
    const res = await fetch(`${app.origin}/api/storages/${bucketId}/download-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ keys }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('signs every requested key, with its name', async () => {
    const { status, body } = await requestLinks(['logs/a.txt', 'logs/deep/b.txt']);

    expect(status).toBe(200);
    const links = body.links as Array<{ key: string; name: string; url: string }>;
    expect(links.map((l) => l.key)).toEqual(['logs/a.txt', 'logs/deep/b.txt']);
    expect(links.map((l) => l.name)).toEqual(['a.txt', 'b.txt']);
    for (const link of links) {
      expect(link.url).toContain('X-Amz-Signature=');
    }
    // The key must survive into the signed path, slashes intact.
    expect(decodeURIComponent(links[0]!.url)).toContain('/b/logs/a.txt');
    expect(decodeURIComponent(links[1]!.url)).toContain('/b/logs/deep/b.txt');
    expect(body.direct).toBe(true);
    expect(body.expiresInSeconds).toBeGreaterThan(0);
  });

  it('signs URLs the browser can read cross-origin, without a forced download', async () => {
    const { body } = await requestLinks(['logs/a.txt']);
    const url = (body.links as Array<{ url: string }>)[0]!.url;

    // `attachment` would be pointless for a fetch, and the caller decides how
    // to store the bytes, so it must not be forced here.
    expect(url).not.toContain('response-content-disposition');
  });

  it('ignores non-string entries instead of failing the batch', async () => {
    const { body } = await requestLinks(['a.txt', 42, null, '', 'b.txt']);
    const links = body.links as Array<{ key: string }>;
    expect(links.map((l) => l.key)).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses an empty key list', async () => {
    const { status } = await requestLinks([]);
    expect(status).toBe(400);
  });

  it('refuses a list past the cap, before signing anything', async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `k/${i}.bin`);
    const { status, body } = await requestLinks(keys);
    expect(status).toBe(400);
    expect((body.error as { code?: string })?.code).toBe('too_many_keys');
  });

  it('requires authentication', async () => {
    const res = await fetch(`${app.origin}/api/storages/${bucketId}/download-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['a.txt'] }),
    });
    expect(res.status).toBe(401);
  });
});

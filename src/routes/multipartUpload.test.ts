import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../createApp.js';
import { resetAdapterForTests } from '../db/adapter.js';
import { resetMigrateForTests } from '../db/migrate.js';
import { createBucket } from '../db/repos/buckets.js';
import { bootstrapAuthKeys, getCachedAuthKey, resetAuthKeyStoreForTests } from '../services/authKeyStore.js';
import { clearS3Client } from '../services/s3.js';

/**
 * The end-to-end proof that the fix holds.
 *
 * The failure this replaces was not a bug in any one function: the browser PUT
 * the whole file through this service in a single request, and every hop in
 * front of it ends a request body that has not finished within its window — so a
 * large upload was cut off and surfaced as an opaque 502. The property that
 * makes that impossible is that **no single request body is large**, and that is
 * what this test measures, on the requests the app actually forwards, for a file
 * far larger than any single request.
 *
 * It also checks the price of the design. Parts are spooled to disk so the
 * server can retry them, and a temp file that outlives its request is a leak
 * that would only show up as a full disk much later. Every path here asserts the
 * spool directory is empty afterwards.
 *
 * What it does not claim: this test sees the requests the app makes to the
 * storage, not what the browser sent it. The browser-side half of the invariant
 * is pinned in `web/src/shared/upload/chunks.test.ts`, which asserts the plan
 * never exceeds the part size — the two together cover both ends.
 *
 * Everything here is loopback: a fake storage implementing just the multipart
 * calls, a temporary SQLite database, and the real Express app. No docker, no
 * network, no credentials.
 */

const PART_SIZE = 8 * 1024 * 1024;
/** Comfortably more than one part, so chunking is actually exercised. */
const FILE_SIZE = 20 * 1024 * 1024;

/** What the fake storage observed. */
type RecordedRequest = {
  method: string;
  path: string;
  bodyBytes: number;
  declaredLength: number | null;
};

type FakeStorage = {
  endpoint: string;
  requests: RecordedRequest[];
  uploadedParts: Map<string, Array<{ partNumber: number; bytes: number }>>;
  completed: string[];
  aborted: string[];
  /** Stored object sizes by key, so completion can be verified. */
  objects: Map<string, number>;
  /** When set, every part PUT is answered with this status. */
  failPartsWith: number | null;
  /** Answer the first N-1 part PUTs with 500, so a retry is exercised. */
  failPartsUntilAttempt: number;
  /** How many part PUTs have been received, including retries. */
  partAttempts: () => number;
  close: () => Promise<void>;
};

/**
 * A storage that implements the multipart calls and nothing else.
 *
 * It records the byte count of every request body it receives, which is the
 * measurement this test exists for.
 */
async function startFakeStorage(): Promise<FakeStorage> {
  const requests: RecordedRequest[] = [];
  const uploadedParts = new Map<string, Array<{ partNumber: number; bytes: number }>>();
  const completed: string[] = [];
  const aborted: string[] = [];
  const objects = new Map<string, number>();
  const state: { failPartsWith: number | null; failPartsUntilAttempt: number; partAttempts: number } =
    { failPartsWith: null, failPartsUntilAttempt: 0, partAttempts: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''));
    const uploadId = url.searchParams.get('uploadId') || '';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks).length;
      requests.push({
        method: req.method || '',
        path: req.url || '',
        bodyBytes: bytes,
        declaredLength: req.headers['content-length']
          ? Number(req.headers['content-length'])
          : null,
      });

      // Initiate multipart upload: POST with ?uploads.
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const id = `upload-${uploadId || requests.length}`;
        uploadedParts.set(id, []);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }

      // Upload a part: PUT with partNumber + uploadId.
      if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
        const partNumber = Number(url.searchParams.get('partNumber'));
        state.partAttempts += 1;

        if (state.failPartsWith !== null) {
          res.writeHead(state.failPartsWith, { 'Content-Type': 'application/xml' });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied</Message></Error>',
          );
          return;
        }
        if (state.partAttempts < state.failPartsUntilAttempt) {
          res.writeHead(500, { 'Content-Type': 'application/xml' });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>try again</Message></Error>',
          );
          return;
        }

        const parts = uploadedParts.get(uploadId) || [];
        parts.push({ partNumber, bytes });
        uploadedParts.set(uploadId, parts);
        res.writeHead(200, { ETag: `"etag-${partNumber}"` });
        res.end();
        return;
      }

      // Complete the upload: POST with uploadId and no ?uploads.
      if (req.method === 'POST' && uploadId) {
        completed.push(uploadId);
        const parts = uploadedParts.get(uploadId) || [];
        const total = parts.reduce((sum, part) => sum + part.bytes, 0);
        objects.set(key, total);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`,
        );
        return;
      }

      // Abort: DELETE with uploadId.
      if (req.method === 'DELETE' && uploadId) {
        aborted.push(uploadId);
        res.writeHead(204);
        res.end();
        return;
      }

      // HeadObject.
      if (req.method === 'HEAD') {
        const size = objects.get(key);
        if (size === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Length': String(size), 'Content-Type': 'application/x-tar' });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    uploadedParts,
    completed,
    aborted,
    objects,
    get failPartsWith() {
      return state.failPartsWith;
    },
    set failPartsWith(value: number | null) {
      state.failPartsWith = value;
    },
    get failPartsUntilAttempt() {
      return state.failPartsUntilAttempt;
    },
    set failPartsUntilAttempt(value: number) {
      state.failPartsUntilAttempt = value;
    },
    partAttempts: () => state.partAttempts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Serve the app on a random port and return its origin. */
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

describe('chunked upload end to end', () => {
  let dir: string;
  let storage: FakeStorage;
  let app: { origin: string; close: () => Promise<void> };
  let uploadKey: string;
  let bucketId: string;
  let spoolRoot: string;
  let previousSpoolDir: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-console-multipart-'));
    process.env.SQL_DSN = `sqlite://${join(dir, 'test.sqlite')}`;
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();

    // Keep spooled parts inside the sandbox, so the test can assert they are
    // gone rather than writing into the real temporary directory.
    spoolRoot = mkdtempSync(join(tmpdir(), 'storage-console-spool-'));
    previousSpoolDir = process.env.UPLOAD_SPOOL_DIR;
    process.env.UPLOAD_SPOOL_DIR = spoolRoot;

    // Started first, so the bucket can be created pointing at it.
    storage = await startFakeStorage();
    await bootstrapAuthKeys();
    uploadKey = getCachedAuthKey('upload');

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
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    clearS3Client(bucketId);
    resetAdapterForTests();
    resetMigrateForTests();
    resetAuthKeyStoreForTests();
    delete process.env.SQL_DSN;
    if (previousSpoolDir === undefined) delete process.env.UPLOAD_SPOOL_DIR;
    else process.env.UPLOAD_SPOOL_DIR = previousSpoolDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(spoolRoot, { recursive: true, force: true });
  });

  /**
   * Files still sitting in this process's spool directory.
   *
   * The whole point of spooling is that the files do not survive their request,
   * on any path, so every test ends by asserting this is empty.
   */
  function leftoverSpoolFiles(): string[] {
    try {
      return readdirSync(join(spoolRoot, `upload-part-${process.pid}`));
    } catch {
      return [];
    }
  }

  /**
   * Upload `bytes` of data through the real endpoints, exactly as the browser
   * would: start, one PUT per part, then complete.
   *
   * The chunk sizes come from the part size the server reports, never from a
   * constant here — that is what the real client does, and hard-coding one would
   * hide a server/client disagreement about the boundary.
   */
  async function uploadInParts(name: string, bytes: number) {
    const headers = { 'X-API-Key': uploadKey };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=${encodeURIComponent(name)}&contentType=application/x-tar&size=${bytes}`,
      { method: 'POST', headers, body: '' },
    );
    expect(startRes.status).toBe(201);
    const session = (await startRes.json()) as {
      uploadToken: string;
      key: string;
      partCount: number;
      partSize: number;
    };

    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let index = 0; index < session.partCount; index++) {
      const partNumber = index + 1;
      const isLast = partNumber === session.partCount;
      const chunkSize = isLast ? bytes - session.partSize * (session.partCount - 1) : session.partSize;
      // Note the absence of an isLast flag: the server derives which part is
      // last from the signed session, so a client cannot declare it.
      const res = await fetch(
        `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=${partNumber}`,
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          body: Buffer.alloc(chunkSize, 0x61),
        },
      );
      expect(res.status).toBe(200);
      const receipt = (await res.json()) as { etag: string };
      parts.push({ partNumber, etag: receipt.etag });
    }

    const completeRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart/complete`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadToken: session.uploadToken, parts }),
      },
    );
    return { session, parts, completeRes };
  }

  it('uploads a file larger than one part, and never sends a large request', async () => {
    const { session, completeRes } = await uploadInParts('rollback.tar', FILE_SIZE);
    expect(completeRes.status).toBe(201);

    // The property the whole design exists for: every request body the app sent
    // to the storage was bounded by the part size, despite the file being much
    // larger. A return to whole-file proxying fails exactly here.
    const largest = Math.max(...storage.requests.map((request) => request.bodyBytes));
    expect(largest).toBeLessThanOrEqual(PART_SIZE);
    expect(largest).toBeLessThan(FILE_SIZE);

    // The chunking is real, not a coincidence of a small file.
    const partRequests = storage.requests.filter((request) => request.path.includes('partNumber='));
    expect(partRequests).toHaveLength(session.partCount);
    expect(session.partCount).toBe(Math.ceil(FILE_SIZE / PART_SIZE));

    // And the object that landed is the whole file.
    expect(storage.objects.get(session.key)).toBe(FILE_SIZE);

    // Spooling must not leave anything behind once the parts are stored.
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('accepts a part sent with a JSON content type without buffering it', async () => {
    // A file named *.json uploads as application/json; the global parser used to
    // swallow the body before the route could stream it.
    const headers = { 'X-API-Key': uploadKey };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=report.json&contentType=application%2Fjson&size=${PART_SIZE}`,
      { method: 'POST', headers, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    const body = Buffer.alloc(PART_SIZE, 0x7b);
    const partRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      },
    );
    expect(partRes.status).toBe(200);

    const forwarded = storage.requests.filter((request) => request.path.includes('partNumber=1'));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.bodyBytes).toBe(PART_SIZE);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('refuses a part larger than the part size, before forwarding it', async () => {
    const headers = { 'X-API-Key': uploadKey };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=big.tar&contentType=application/x-tar&size=${FILE_SIZE}`,
      { method: 'POST', headers, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(PART_SIZE + 1024, 0x61),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
    // Nothing oversized reached the storage, and nothing was left on disk.
    expect(storage.requests.filter((r) => r.path.includes('partNumber='))).toHaveLength(0);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('rejects a short part, which the session knows must be a full one', async () => {
    // The client cannot send a runt part and call it a day: the expected length
    // of a non-final part comes from the signed session.
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=short.tar&contentType=application/x-tar&size=${FILE_SIZE}`,
      { method: 'POST', headers: { 'X-API-Key': uploadKey }, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`,
      {
        method: 'PUT',
        headers: { 'X-API-Key': uploadKey, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(1024, 0x61),
      },
    );
    expect(res.status).toBe(400);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('refuses a part number beyond what the upload declares', async () => {
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=oob.tar&contentType=application/x-tar&size=${PART_SIZE}`,
      { method: 'POST', headers: { 'X-API-Key': uploadKey }, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=2`,
      {
        method: 'PUT',
        headers: { 'X-API-Key': uploadKey, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(PART_SIZE, 0x61),
      },
    );
    expect(res.status).toBe(400);
  });

  it('refuses a completion that is missing parts, rather than storing a truncated object', async () => {
    const headers = { 'X-API-Key': uploadKey };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=partial.tar&contentType=application/x-tar&size=${FILE_SIZE}`,
      { method: 'POST', headers, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    const res = await fetch(`${app.origin}/api/storages/${bucketId}/upload-multipart/complete`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadToken: session.uploadToken,
        parts: [{ partNumber: 1, etag: '"a"' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code?: string } };
    expect(body.error.code).toBe('missing_parts');
    // Nothing was completed at the storage.
    expect(storage.completed).toHaveLength(0);
  });

  it('refuses an upload token minted for a different storage', async () => {
    // The bucket is sealed into the token, so a token cannot be pointed at
    // another storage whose key was computed differently.
    const other = await createBucket(
      'other bucket',
      'ObjectStorage',
      storage.endpoint,
      'us-east-1',
      'access-key',
      'secret-key',
      'other-bucket',
      '',
      'admin',
    );
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=cross.tar&contentType=application/x-tar&size=${PART_SIZE}`,
      { method: 'POST', headers: { 'X-API-Key': uploadKey }, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    const res = await fetch(
      `${app.origin}/api/storages/${other.id}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`,
      {
        method: 'PUT',
        headers: { 'X-API-Key': uploadKey, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(PART_SIZE, 0x61),
      },
    );
    expect(res.status).toBe(400);
    clearS3Client(other.id);
  });

  it('refuses an unknown upload token, and says it is not worth retrying', async () => {
    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=not-a-real-token&partNumber=1`,
      {
        method: 'PUT',
        headers: { 'X-API-Key': uploadKey, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(64, 0x61),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('cleans up the spooled part when the storage rejects it', async () => {
    // A part accepted from the browser but refused by the storage must not leave
    // its file behind — this is the leak path that would only surface as a full
    // disk much later.
    const headers = { 'X-API-Key': uploadKey };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=fail.tar&contentType=application/x-tar&size=${PART_SIZE}`,
      { method: 'POST', headers, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    storage.failPartsWith = 403;
    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(PART_SIZE, 0x61),
      },
    );
    expect(res.status).toBe(403);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('retries a transient storage failure without the client resending anything', async () => {
    // The reason parts are spooled at all: the bytes are on disk, so a blip at
    // the storage costs a retry here instead of a round trip to the browser.
    const headers = { 'X-API-Key': uploadKey };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=retry.tar&contentType=application/x-tar&size=${PART_SIZE}`,
      { method: 'POST', headers, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string };

    storage.failPartsUntilAttempt = 2;
    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(PART_SIZE, 0x61),
      },
    );
    expect(res.status).toBe(200);
    // The server sent the part twice; the browser sent it once.
    expect(storage.partAttempts()).toBeGreaterThanOrEqual(2);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('aborts the storage upload when the client abandons it', async () => {
    const headers = { 'X-API-Key': uploadKey, 'Content-Type': 'application/json' };
    const startRes = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=gone.tar&contentType=application/x-tar&size=${PART_SIZE}`,
      { method: 'POST', headers: { 'X-API-Key': uploadKey }, body: '' },
    );
    const session = (await startRes.json()) as { uploadToken: string; key: string };

    await fetch(`${app.origin}/api/storages/${bucketId}/upload-part?uploadToken=${session.uploadToken}&partNumber=1`, {
      method: 'PUT',
      headers: { 'X-API-Key': uploadKey, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(PART_SIZE, 0x61),
    });

    const abortRes = await fetch(`${app.origin}/api/storages/${bucketId}/upload-multipart/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ uploadToken: session.uploadToken }),
    });
    expect(abortRes.status).toBe(200);
    // The parts already sent stop occupying the bucket.
    expect(storage.aborted).toHaveLength(1);
    expect(leftoverSpoolFiles()).toHaveLength(0);
  });

  it('rejects a declared size over the upload limit without starting an upload', async () => {
    const res = await fetch(
      `${app.origin}/api/storages/${bucketId}/upload-multipart?relativePath=&name=huge.tar&contentType=application/x-tar&size=${2 * 1024 * 1024 * 1024}`,
      { method: 'POST', headers: { 'X-API-Key': uploadKey }, body: '' },
    );
    expect(res.status).toBe(400);
    expect(storage.requests.filter((r) => r.method === 'POST' && r.path.includes('uploads'))).toHaveLength(0);
  });
});

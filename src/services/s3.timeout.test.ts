import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, formatS3RequestError, isRetryableS3Error } from './s3.js';
import type { Bucket } from '../db/store.js';

/**
 * The SDK treats "no timeout configured" as its default, so a stalled bucket
 * never fails — and the upload proxy streams its PutObject body from the
 * browser, so the request body simply stops being read and the transfer parks at
 * a fixed byte offset with no error. These tests pin the timeouts in place.
 *
 * Short timeouts are injected rather than set through the environment, because
 * the config module reads the environment once at import and a test cannot
 * revisit that.
 */

/** Short values so a test does not have to outwait a production timeout. */
const SHORT: import('./s3.js').S3Timeouts = { socketMs: 2000, connectMs: 2000, requestMs: 5000 };

function bucketFor(endpoint: string): Bucket {
  return {
    id: 'bucket-1',
    name: 'test',
    storageType: 'ObjectStorage',
    endpoint,
    region: 'us-east-1',
    accessKey: 'a',
    secretKey: 'b',
    bucketName: 'b',
    bucketPath: '',
    userId: 'admin',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as Bucket;
}

/** A storage that accepts bytes and never answers. */
async function hangingServer(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req) => {
    req.resume();
    // Deliberately never respond.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, close: () => server.close() };
}

/** Run one PutObject against a hanging storage and return the failure. */
async function failAgainstHangingStorage(): Promise<{
  error: Error;
  elapsedMs: number;
  port: number;
}> {
  const { port, close } = await hangingServer();
  try {
    const client = createS3Client(bucketFor(`http://127.0.0.1:${port}`), SHORT);
    const started = Date.now();
    // maxAttempts(1): the SDK's own retry would otherwise multiply the wait.
    // What is being pinned is that this settles at all.
    const error = await client
      .send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' }), { maxAttempts: 1 })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    return {
      error: error ?? new Error('request unexpectedly succeeded'),
      elapsedMs: Date.now() - started,
      port,
    };
  } finally {
    close();
  }
}

/**
 * One stall, asserted several ways.
 *
 * The SDK defers socket-timeout registration and runs its own agent-acquisition
 * timer, so provoking a stall costs several seconds of fixed overhead — worth
 * paying once and deriving the rest from the same failure.
 */
const stall = failAgainstHangingStorage();

describe('createS3Client timeouts', () => {
  it('fails a stalled request instead of waiting forever', async () => {
    const { error, elapsedMs } = await stall;
    // Without a timeout this promise never settles, which is the bug pinned here.
    expect(error.message).not.toBe('request unexpectedly succeeded');
    expect(elapsedMs).toBeLessThan(30_000);
  }, 40_000);

  it('names the timeout in the failure, so the cause is not guessed at', async () => {
    const { error } = await stall;
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toMatch(/timed out/i);
  }, 40_000);

  it('is classified as retryable, so the browser re-sends rather than giving up', async () => {
    const { error } = await stall;
    // A timeout carries no HTTP status, which is exactly the case the retryable
    // classification is meant to cover.
    expect(isRetryableS3Error(error)).toBe(true);
  }, 40_000);

  it('reports the timeout through the user-facing error formatter', async () => {
    const { error } = await stall;
    const formatted = formatS3RequestError(error, bucketFor('http://127.0.0.1:1'));
    // The raw SDK text is not actionable on its own; the formatter's job is to
    // turn it into something the operator can act on, at a retryable status.
    expect(formatted.message).toBeTruthy();
    expect(formatted.status).toBe(502);
  }, 40_000);
});

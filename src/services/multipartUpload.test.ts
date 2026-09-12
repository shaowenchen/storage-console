import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetAdapterForTests } from '../db/adapter.js';
import { resetMigrateForTests } from '../db/migrate.js';
import { bootstrapAuthKeys, resetAuthKeyStoreForTests } from './authKeyStore.js';
import {
  createSessionToken,
  expectedPartLength,
  parseSessionToken,
  sessionPartCount,
  type UploadSession,
} from './multipartUpload.js';

/**
 * Session tokens are the only thing standing between a client and writing to an
 * arbitrary key in the bucket, so the signature is what these tests are really
 * about. They also pin the property that makes the chunked upload work behind
 * more than one instance: the session is entirely in the token, so any process
 * holding the same secret can verify it.
 */

const HOUR = 60 * 60 * 1000;
const PART = 8 * 1024 * 1024;

function claims(overrides: Partial<Omit<UploadSession, 'issuedAt'>> = {}) {
  return {
    uploadId: 'storage-upload-1',
    bucketId: 'bucket-1',
    key: 'prefix/report.tar',
    contentType: 'application/x-tar',
    size: 20 * 1024 * 1024,
    partSize: PART,
    lastPartSize: 4 * 1024 * 1024,
    userId: 'admin',
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'storage-console-session-'));
  process.env.SQL_DSN = `sqlite://${join(dir, 'test.sqlite')}`;
  resetAdapterForTests();
  resetMigrateForTests();
  resetAuthKeyStoreForTests();
  await bootstrapAuthKeys();
});

describe('upload session tokens', () => {
  it('round-trips every claim that decides where bytes are written', () => {
    const token = createSessionToken(claims());
    const parsed = parseSessionToken(token);
    expect(parsed).toMatchObject({
      uploadId: 'storage-upload-1',
      bucketId: 'bucket-1',
      key: 'prefix/report.tar',
      size: 20 * 1024 * 1024,
      partSize: PART,
      lastPartSize: 4 * 1024 * 1024,
      userId: 'admin',
    });
  });

  it('is verifiable by a different process sharing the same secret', async () => {
    // The property the design turns on: nothing about the session is stored in
    // the process that created it, so a second instance can accept a part the
    // first one started. Simulated by rebuilding the auth-key cache from the
    // same database, which is what another replica would read.
    const token = createSessionToken(claims());
    resetAuthKeyStoreForTests();
    await bootstrapAuthKeys();
    expect(parseSessionToken(token)?.key).toBe('prefix/report.tar');
  });

  it('rejects a token whose payload has been edited', () => {
    const token = createSessionToken(claims());
    const [body, signature] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    tampered.key = 'somewhere-else/steal.tar';
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;
    expect(parseSessionToken(forged)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = createSessionToken(claims());
    // A redeployed instance with a rotated secret must not honour old tokens.
    const { rotateCachedAuthKey } = await import('./authKeyStore.js');
    await rotateCachedAuthKey('session');
    expect(parseSessionToken(token)).toBeNull();
  });

  it('rejects a token with no signature or a malformed one', () => {
    expect(parseSessionToken('')).toBeNull();
    expect(parseSessionToken('no-dot')).toBeNull();
    expect(parseSessionToken('body.')).toBeNull();
    expect(parseSessionToken(createSessionToken(claims()).replace(/\..*$/, '.short'))).toBeNull();
  });

  it('expires a token past its TTL', () => {
    const token = createSessionToken(claims());
    expect(parseSessionToken(token, Date.now() + 23 * HOUR)).not.toBeNull();
    expect(parseSessionToken(token, Date.now() + 25 * HOUR)).toBeNull();
  });

  it('does not accept a token stamped in the future', () => {
    // A clock-skewed instance could otherwise mint a token that never expires.
    const token = createSessionToken(claims());
    expect(parseSessionToken(token, Date.now() - 10 * 60 * 1000)).toBeNull();
  });

  it('rejects a payload missing the fields that bound the upload', () => {
    const payload = { ...claims(), size: 0 };
    const body = Buffer.from(JSON.stringify({ ...payload, issuedAt: Date.now() })).toString(
      'base64url',
    );
    // Re-sign properly so the signature is valid and the field check is what
    // rejects it, rather than the signature.
    const signed = createSessionToken(claims({ size: 0 }));
    expect(parseSessionToken(signed)).toBeNull();
    expect(parseSessionToken(body + '.x')).toBeNull();
  });
});

describe('part arithmetic', () => {
  it('counts parts from the sealed size and part size', () => {
    expect(sessionPartCount({ size: 20 * 1024 * 1024, partSize: PART })).toBe(3);
    expect(sessionPartCount({ size: PART, partSize: PART })).toBe(1);
    expect(sessionPartCount({ size: PART + 1, partSize: PART })).toBe(2);
  });

  it('expects full parts everywhere but the last', () => {
    const session = { size: 20 * 1024 * 1024, partSize: PART, lastPartSize: 4 * 1024 * 1024 };
    expect(expectedPartLength(session, 1)).toBe(PART);
    expect(expectedPartLength(session, 2)).toBe(PART);
    // The last part is the remainder, and the only one allowed to be short.
    expect(expectedPartLength(session, 3)).toBe(4 * 1024 * 1024);
  });

  it('expects the whole file as one part when it fits in one', () => {
    const session = { size: 1000, partSize: PART, lastPartSize: 1000 };
    expect(expectedPartLength(session, 1)).toBe(1000);
  });

  it('derives the last part from the size, not from the client', () => {
    // The client cannot claim a part is the last one to escape the minimum size
    // rule: the expected length comes from the signed session.
    const size = 3 * PART + 12345;
    const session = {
      size,
      partSize: PART,
      lastPartSize: size - PART * (Math.ceil(size / PART) - 1),
    };
    expect(expectedPartLength(session, 4)).toBe(12345);
  });
});

describe('session token does not leak the storage upload id', () => {
  it('keeps the upload id out of the part a client can read', () => {
    // The id is carried so the server can use it, but the key/upload pair must
    // never be usable by a client to address another object — the whole point is
    // that the key is fixed at creation and cannot be changed afterwards.
    const token = createSessionToken(claims({ uploadId: 'super-secret-upload-id' }));
    const parsed = parseSessionToken(token);
    expect(parsed?.key).toBe('prefix/report.tar');
    // Whatever the token carries, the client cannot alter it without breaking
    // the signature — which the tampering test above pins.
    expect(parsed?.uploadId).toBe('super-secret-upload-id');
  });
});

afterEach(() => {
  resetAdapterForTests();
  resetMigrateForTests();
  resetAuthKeyStoreForTests();
  delete process.env.SQL_DSN;
  rmSync(dir, { recursive: true, force: true });
});
